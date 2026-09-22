// pi extension: DeepSeek dynamic (peak/off-peak) pricing.
//
// pi persists a static, peak-rate cost for every DeepSeek message. This
// extension recomputes `usage.cost` from the timestamped rate card in
// ./rates.ts at the persistence boundary (message_end / tool_result), so pi's
// footer, /session, and RPC totals become time-accurate. On settle it appends
// a per-session summary to a JSONL ledger for later reconciliation.
//
// Design notes:
//   * Stateless: every value is derived from session entries / event payloads.
//   * Every filesystem operation is wrapped in try/catch. An event handler that
//     throws can break a pi turn, so this extension must never propagate.
//   * Zero npm dependencies; only `node:` builtins and the local rate engine.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { computeCost, computePeakCost, isHoliday, isPeak, normalizeModelId } from "./rates.ts";
import type { Usage } from "./rates.ts";

const PROVIDER = "deepseek";
const LEDGER_DIR = join(homedir(), ".pi", "deepseek-pricing");
const LEDGER_FILE = join(LEDGER_DIR, "ledger.jsonl");
const COMPACTION_PROBE_FILE = join(LEDGER_DIR, "compaction-probe.jsonl");
const PEAK_WINDOW_LABEL =
  "01:00\u201304:00 and 06:00\u201310:00 UTC, Mon\u2013Fri (excluding CN public holidays)";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
}

interface Summary {
  peakTokens: Tokens;
  offPeakTokens: Tokens;
  dynamicCost: number;
  nativeCost: number;
  count: number;
  model: string | null;
  /** Earliest entry timestamp counted in the active branch, or null. */
  firstTs: number | null;
}

// --- small helpers -----------------------------------------------------------

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** True when `usage` carries at least one finite token count (never invents usage). */
function hasNumericTokens(usage: unknown): usage is Usage {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as Record<string, unknown>;
  return TOKEN_FIELDS.some(
    (field) => typeof u[field] === "number" && Number.isFinite(u[field]),
  );
}

/** Extract `{ id, isDeepseek }` from either a Model object or a bare id string. */
function modelInfo(model: unknown): { id: string | null; isDeepseek: boolean } {
  if (typeof model === "string") {
    return { id: model, isDeepseek: normalizeModelId(model) !== null };
  }
  if (model && typeof model === "object") {
    const m = model as { id?: unknown; provider?: unknown };
    const id = typeof m.id === "string" ? m.id : null;
    const provider = typeof m.provider === "string" ? m.provider.toLowerCase() : "";
    return { id, isDeepseek: provider === PROVIDER };
  }
  return { id: null, isDeepseek: false };
}

function messageTimestamp(message: unknown, entry: unknown): number {
  const m = message as { timestamp?: unknown } | null;
  if (m && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
    return m.timestamp;
  }
  const e = entry as { timestamp?: unknown } | null;
  if (e && typeof e.timestamp === "string") {
    const parsed = Date.parse(e.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function zeroTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0 };
}

/** Read session entries defensively; never throws. */
function readEntries(ctx: { sessionManager?: { getEntries?: () => unknown } }): unknown[] {
  try {
    const entries = ctx?.sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => unknown } }): string | null {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // fall through to env
  }
  try {
    const id = process.env.PI_SESSION_ID;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Aggregate DeepSeek usage from session entries.
 * Assistant messages are attributed by their own provider/model; tool-result
 * usage is attributed to the currently active model (tool results carry no
 * provider/model of their own).
 */
function summarize(entries: unknown[], activeModel: unknown): Summary {
  const active = modelInfo(activeModel);
  const peakTokens = zeroTokens();
  const offPeakTokens = zeroTokens();
  let dynamicCost = 0;
  let nativeCost = 0;
  let count = 0;
  let model: string | null = active.id;
  let firstTs: number | null = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; message?: unknown };
    if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;

    const message = e.message as {
      role?: unknown;
      provider?: unknown;
      model?: unknown;
      usage?: unknown;
      cost?: unknown;
    };

    let modelId: string | null = null;
    let usage: unknown;
    if (message.role === "assistant") {
      const provider =
        typeof message.provider === "string" ? message.provider.toLowerCase() : "";
      if (provider !== PROVIDER) continue;
      modelId = typeof message.model === "string" ? message.model : "";
      usage = message.usage;
    } else if (message.role === "toolResult" && active.isDeepseek) {
      modelId = active.id;
      usage = message.usage;
    } else {
      continue;
    }

    if (!hasNumericTokens(usage)) continue;

    const ts = messageTimestamp(message, entry);
    const cost = computeCost(modelId ?? "", usage, ts);
    if (!cost) continue;

    const bucket = isPeak(ts) ? peakTokens : offPeakTokens;
    bucket.input += toNumber(usage.input);
    bucket.output += toNumber(usage.output);
    bucket.cacheRead += toNumber(usage.cacheRead);

    dynamicCost += cost.total;
    // nativeCost = what pi's STATIC peak-rate catalog would have billed for
    // these same buckets (not the stored, already-patched cost). delta then
    // measures what the dynamic pricing actually corrected.
    const peakCost = computePeakCost(modelId ?? "", usage);
    if (peakCost) nativeCost += peakCost.total;
    count += 1;
    if (!model && modelId) model = modelId;
    if (Number.isFinite(ts)) firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
  }

  return { peakTokens, offPeakTokens, dynamicCost, nativeCost, count, model, firstTs };
}

function appendLedger(record: Record<string, unknown>): void {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Ledger IO must never break pi.
  }
}

function appendProbe(record: Record<string, unknown>): void {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(COMPACTION_PROBE_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Probe evidence IO must never break pi.
  }
}

function currentWindow(nowMs: number): { peak: boolean; reason: string } {
  if (isHoliday(nowMs)) return { peak: false, reason: "CN public holiday" };
  const d = new Date(nowMs);
  const weekday = d.getUTCDay();
  if (weekday === 0 || weekday === 6) return { peak: false, reason: "weekend" };
  const hour = d.getUTCHours();
  if ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) {
    return { peak: true, reason: "inside a peak window" };
  }
  return { peak: false, reason: "outside peak windows" };
}

function usd(value: number): string {
  return value.toFixed(6);
}

function tokensLine(t: Tokens): string {
  return `${t.input.toLocaleString("en-US")} / ${t.output.toLocaleString("en-US")} / ${t.cacheRead.toLocaleString("en-US")}`;
}

function buildReport(summary: Summary, nowMs: number): string {
  const window = currentWindow(nowMs);
  const delta = summary.dynamicCost - summary.nativeCost;
  const direction = delta < 0 ? "saved" : delta > 0 ? "over" : "even";

  return [
    "## DeepSeek pricing \u2014 this session",
    "",
    `**Current window:** ${window.peak ? "peak" : "off-peak"} \u2014 ${window.reason} (${new Date(nowMs).toISOString()})`,
    `Peak windows: ${PEAK_WINDOW_LABEL}.`,
    "",
    "| tokens | input / output / cache-read |",
    "|---|---|",
    `| peak | ${tokensLine(summary.peakTokens)} |`,
    `| off-peak | ${tokensLine(summary.offPeakTokens)} |`,
    "",
    "| cost | USD |",
    "|---|---:|",
    `| dynamic (peak/off-peak) | ${usd(summary.dynamicCost)} |`,
    `| native (pi static peak) | ${usd(summary.nativeCost)} |`,
    `| **delta (${direction})** | **${usd(delta)}** |`,
    "",
    `Model: ${summary.model ?? "\u2014"} \u00b7 billed entries: ${summary.count}`,
    "",
    "Reconcile against the DeepSeek account balance with the `ds-reconcile` CLI.",
  ].join("\n");
}

// --- extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    try {
      const m = event.message as {
        role?: unknown;
        provider?: unknown;
        model?: unknown;
        usage?: unknown;
        timestamp?: unknown;
      };
      if (!m || m.role !== "assistant") return;
      if (typeof m.provider !== "string" || m.provider.toLowerCase() !== PROVIDER) return;
      if (!hasNumericTokens(m.usage)) return;

      const ts =
        typeof m.timestamp === "number" && Number.isFinite(m.timestamp)
          ? m.timestamp
          : Date.now();
      const modelId = typeof m.model === "string" ? m.model : "";
      const cost = computeCost(modelId, m.usage, ts);
      if (!cost) return;

      return {
        message: {
          ...(event.message as object),
          usage: { ...(m.usage as object), cost },
        },
      };
    } catch {
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!hasNumericTokens(event.usage)) return;

      const active = modelInfo(ctx.model);
      if (!active.isDeepseek) return;

      const cost = computeCost(active.id ?? "", event.usage, Date.now());
      if (!cost) return;

      return { usage: { ...(event.usage as object), cost } };
    } catch {
      return;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const summary = summarize(readEntries(ctx), ctx.model);
      if (summary.count === 0) return; // nothing DeepSeek-billed settled: no line
      appendLedger({
        ts: Date.now(),
        sessionId: sessionIdOf(ctx),
        model: summary.model,
        peakTokens: summary.peakTokens,
        offPeakTokens: summary.offPeakTokens,
        dynamicCost: summary.dynamicCost,
        nativeCost: summary.nativeCost,
        delta: summary.dynamicCost - summary.nativeCost,
        firstTs: summary.firstTs,
      });
    } catch {
      // Notification-only event: swallow everything.
    }
  });

  // D-09 (RESOLVED 2026-09-22, live evidence): pi stores the summarization
  // `usage` (with pi's static peak cost) on the saved compaction entry.
  // Rewrite `usage.cost` in place with the time-aware cost; the probe
  // experiment proved `sessionManager.getEntries()` reflects the mutation
  // (compaction-probe.jsonl: reflectedInEntries=true), so pi persists the
  // corrected cost. Every line appended here doubles as an audit record.
  pi.on("session_compact", async (event, ctx) => {
    try {
      const entry = event?.compactionEntry as unknown as {
        id?: unknown;
        provider?: unknown;
        model?: unknown;
        timestamp?: unknown;
        usage?: unknown;
      } | null;
      if (!entry || typeof entry !== "object") return;

      const usage = entry.usage as Record<string, unknown> | null | undefined;
      if (!usage || typeof usage !== "object") return;
      if (!usage.cost || typeof usage.cost !== "object") return;
      const hasTokens = hasNumericTokens(usage);
      if (!hasTokens) return;

      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts)) return;

      // pi's CompactionEntry carries no provider/model, so prefer any fields
      // the entry happens to expose and otherwise fall back to the active
      // model. Never rewrite a non-DeepSeek entry.
      const provider = typeof entry.provider === "string" ? entry.provider.toLowerCase() : "";
      const entryModel = typeof entry.model === "string" ? entry.model : "";
      let modelId = entryModel;
      let isDeepseek = provider === PROVIDER;
      if (!provider && entryModel) isDeepseek = modelInfo(entryModel).isDeepseek;
      if (!provider && !entryModel) {
        const active = modelInfo(ctx.model);
        modelId = active.id ?? "";
        isDeepseek = active.isDeepseek;
      }
      if (!isDeepseek) return;

      const recomputed = computeCost(modelId, usage as unknown as Usage, ts);
      if (!recomputed) return;

      // The probe: mutate the saved entry's cost object in place.
      (usage as { cost?: unknown }).cost = recomputed;
      const recomputedTotal = recomputed.total;

      // Re-read persisted entries and locate the same compaction entry.
      const entries = readEntries(ctx);
      const found = entries.find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const c = candidate as { type?: unknown; id?: unknown };
        return c.type === "compaction" && c.id === entry.id;
      });
      let objectTotalAfterMutation: number | "not-found" = "not-found";
      let reflectedInEntries: boolean | "not-found" = "not-found";
      if (found && typeof found === "object") {
        const foundTotal = (found as { usage?: { cost?: { total?: unknown } } }).usage?.cost
          ?.total;
        if (typeof foundTotal === "number" && Number.isFinite(foundTotal)) {
          objectTotalAfterMutation = foundTotal;
          reflectedInEntries = foundTotal === recomputedTotal;
        }
      }

      appendProbe({
        ts: Date.now(),
        sessionId: sessionIdOf(ctx),
        model: modelId,
        recomputedTotal,
        objectTotalAfterMutation,
        reflectedInEntries,
        note: "in-place session_compact usage.cost mutation; reflectedInEntries=true means getEntries() returned the mutated object",
      });
    } catch {
      // Probe is evidence-only: never propagate into pi.
    }
  });

  pi.registerCommand("ds-cost", {
    description: "DeepSeek peak/off-peak cost breakdown for this session",
    handler: async (_args, ctx) => {
      const entries = readEntries(ctx);
      const summary = summarize(entries, ctx.model);
      const now = Date.now();
      const window = currentWindow(now);

      let markdown: string;
      try {
        markdown = buildReport(summary, now);
      } catch {
        markdown = "## DeepSeek pricing\n\nCould not build the session report.";
      }

      try {
        ctx.ui.notify(
          `DeepSeek ${window.peak ? "peak" : "off-peak"}: dynamic $${usd(summary.dynamicCost)} vs native $${usd(summary.nativeCost)}`,
          "info",
        );
      } catch {
        // UI is best-effort.
      }

      // Per extension-api-cheat.md a command handler may return markdown content.
      return { content: markdown };
    },
  });
}
