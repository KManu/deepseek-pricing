#!/usr/bin/env node
//
// probe-native-pass.mjs — phase-3 evidence probe (zero-dep Node ESM).
//
// Proves that context-mode's pi session extraction prices DeepSeek rows from
// the provider-supplied NATIVE cost (pi's `usage.cost.total`) rather than
// falling back to the static catalog. That native pass-through — added in
// phases 1-2 — is the reason the fragile minified hook bundle is deliberately
// left unpatched (docs/decisions.md D-11).
//
// What it does:
//   1. Imports the installed hooks/session-extract.bundle.mjs (the bundle the
//      hook actually runs). If that import fails cleanly it says so and falls
//      back to the unminified build/session/extract.js + analytics.js pipeline.
//   2. Finds the newest *.jsonl under ~/.pi/agent/sessions (by mtime) and runs
//      the extractor's parsePiUsage over every line.
//   3. Counts DeepSeek rows (model_id starts with "deepseek") that carry a
//      numeric native_cost_usd vs rows that would fall back to the catalog.
//   4. Writes docs/evidence/phase3-native-pass.json and prints a 10-line
//      summary.
//
// Zero dependencies (node builtins only).
// Test-only env overrides: CTXMODE_DIR, PROBE_SESSIONS_DIR, PROBE_EVIDENCE_FILE.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);

const CTXMODE_DIR =
  process.env.CTXMODE_DIR ??
  join(homedir(), ".pi/agent/npm/node_modules/context-mode");
const BUNDLE = join(CTXMODE_DIR, "hooks/session-extract.bundle.mjs");
const EXTRACT = join(CTXMODE_DIR, "build/session/extract.js");
const ANALYTICS = join(CTXMODE_DIR, "build/session/analytics.js");
const PKG_JSON = join(CTXMODE_DIR, "package.json");

const SESSIONS_DIR =
  process.env.PROBE_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
const EVIDENCE_FILE =
  process.env.PROBE_EVIDENCE_FILE ??
  join(REPO_ROOT, "docs/evidence/phase3-native-pass.json");

const SAMPLE_LIMIT = 5;

// --- extraction source -------------------------------------------------------

/**
 * Prefer the minified hook bundle (what actually runs at hook time). If it
 * cannot be imported cleanly, fall back to the unminified build pipeline and
 * report why, so the probe output is never silently misleading.
 */
async function loadExtractor() {
  try {
    const bundle = await import(pathToFileURL(BUNDLE).href);
    if (typeof bundle.parsePiUsage !== "function") {
      throw new Error("bundle imported but does not export parsePiUsage");
    }
    return {
      source: "bundle",
      detail: "hooks/session-extract.bundle.mjs",
      parsePiUsage: bundle.parsePiUsage,
      bundleImportError: null,
    };
  } catch (bundleErr) {
    const reason = bundleErr?.message ?? String(bundleErr);
    const extract = await import(pathToFileURL(EXTRACT).href);
    const analytics = await import(pathToFileURL(ANALYTICS).href);
    if (typeof extract.parsePiUsage !== "function") {
      throw new Error(
        `fallback ${EXTRACT} does not export parsePiUsage (bundle error: ${reason})`,
      );
    }
    return {
      source: "build",
      detail: "build/session/extract.js + analytics.js",
      parsePiUsage: extract.parsePiUsage,
      bundleImportError: reason,
      analyticsReady: typeof analytics.pricePerToken === "function",
    };
  }
}

// --- session discovery -------------------------------------------------------

/** Newest *.jsonl file (by mtime) anywhere under `dir`, or null. */
function newestSession(dir) {
  let best = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path, mtimeMs: stat.mtimeMs };
        }
      }
    }
  }
  return best;
}

// --- extraction --------------------------------------------------------------

/** parsePiUsage over every JSONL line; skip blank/invalid lines. */
function extractRows(raw, parsePiUsage) {
  const rows = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const usage = parsePiUsage(parsed);
    if (!usage) continue;
    rows.push({
      timestamp:
        typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      ...usage,
    });
  }
  return rows;
}

function isNumeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const extractor = await loadExtractor();
  const { source, parsePiUsage, detail, bundleImportError } = extractor;
  const version = packageVersion();

  const newest = newestSession(SESSIONS_DIR);
  const rows = newest
    ? extractRows(readFileSync(newest.path, "utf8"), parsePiUsage)
    : [];

  const deepseek = rows.filter((row) =>
    String(row.model_id).startsWith("deepseek"),
  );
  let nativeCostRows = 0;
  let catalogFallbackRows = 0;
  let nativeCostUsdSum = 0;
  for (const row of deepseek) {
    if (isNumeric(row.native_cost_usd)) {
      nativeCostRows++;
      nativeCostUsdSum += row.native_cost_usd;
    } else {
      catalogFallbackRows++;
    }
  }

  const samples = deepseek.slice(0, SAMPLE_LIMIT).map((row) => ({
    timestamp: row.timestamp,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    native_cost_usd: isNumeric(row.native_cost_usd) ? row.native_cost_usd : null,
    basis: isNumeric(row.native_cost_usd) ? "native" : "catalog",
  }));

  const evidence = {
    probeTime: new Date().toISOString(),
    source,
    sessionFile: newest ? newest.path : null,
    totals: {
      usageRows: rows.length,
      deepseekRows: deepseek.length,
      nativeCostRows,
      catalogFallbackRows,
      nativeCostUsdSum,
    },
    samples,
  };
  if (source === "build") evidence.bundleImportError = bundleImportError;

  mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);

  const lines = [
    "Phase-3 native-cost pass-through probe",
    source === "bundle"
      ? `source: bundle (${detail})`
      : `source: build (${detail}) — bundle import failed: ${bundleImportError}`,
    `context-mode version: ${version}`,
    `session: ${newest ? newest.path : "(no .jsonl session found)"}`,
    `scanned usage rows: ${rows.length}`,
    `deepseek rows: ${deepseek.length}`,
    `  with numeric native_cost_usd: ${nativeCostRows}`,
    `  catalog-fallback rows: ${catalogFallbackRows}`,
    `native cost total: $${nativeCostUsdSum.toFixed(6)}`,
    `evidence: ${EVIDENCE_FILE} (samples: ${samples.length})`,
  ];
  for (const line of lines) console.log(line);
}

await main();
