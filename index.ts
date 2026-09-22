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

import { computeCost, isHoliday, isPeak, normalizeModelId } from "./rates.ts";
import type { Usage } from "./rates.ts";

const PROVIDER = "deepseek";
const LEDGER_DIR = join(homedir(), ".pi", "deepseek-pricing");
const LEDGER_FILE = join(LEDGER_DIR, "ledger.jsonl");
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
    nativeCost += toNumber((usage as { cost?: { total?: unknown } }).cost?.total);
    count += 1;
    if (!model && modelId) model = modelId;
  }

  return { peakTokens, offPeakTokens, dynamicCost, nativeCost, count, model };
}

function appendLedger(record: Record<string, unknown>): void {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Ledger IO must never break pi.
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
      appendLedger({
        ts: Date.now(),
        sessionId: sessionIdOf(ctx),
        model: summary.model,
        peakTokens: summary.peakTokens,
        offPeakTokens: summary.offPeakTokens,
        dynamicCost: summary.dynamicCost,
        nativeCost: summary.nativeCost,
        delta: summary.dynamicCost - summary.nativeCost,
      });
    } catch {
      // Notification-only event: swallow everything.
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
