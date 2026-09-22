/**
 * Pricing catalog — single source of truth for per-model USD cost.
 *
 * Deep module, tiny interface. At load it reads one curated multi-vendor JSON
 * (src/session/model-prices.json) into a Map<modelId, Price> in per-Mtok units,
 * then exposes three pure-ish functions:
 *
 *   lookupPrice(modelId)            → Price | null
 *   computeCostUsd(modelId, tokens) → number  | null
 *   nativeOrComputed(id, t, native) → number  | null
 *
 * WHY THIS EXISTS — the bug it kills:
 * The old table in src/session/extract.ts hardcoded ~5 Claude rows plus a
 * `default` row, and any unmatched id (every OpenAI / Gemini / Qwen / DeepSeek
 * / Grok model) silently inherited Claude-Sonnet pricing. Non-Claude turns were
 * therefore mispriced. Here each model is priced from ITS OWN curated row, and
 * an unknown id resolves to `null` (no price) instead of a wrong Claude rate.
 *
 * The large litellm catalog (~1.5MB, ~2900 models) is NOT bundled — it lives at
 * tools/pricing/litellm-catalog.json as the dev-only refresh base for this
 * curated JSON.
 *
 * The curated JSON is small (~13KB, 61 models) and esbuild inlines it into the
 * hook/server bundles at build time (no runtime fs read, no external file).
 */
import catalog from "./model-prices.json" with { type: "json" };
/**
 * Read the curated JSON into one Map. A row with a null *input* price is
 * unusable for cost (the primary bucket has no rate) and is dropped at load so
 * lookupPrice returns null for it — matching "null-priced entries → no price".
 * (The two null-input ids are already pruned from the JSON itself; this guard
 * keeps the loader robust if one is ever re-added.)
 */
function buildCatalog() {
    const map = new Map();
    const src = catalog;
    for (const id of Object.keys(src)) {
        const row = src[id];
        if (row == null || typeof row !== "object")
            continue;
        // No input rate ⇒ no usable price for this model.
        if (typeof row.input_per_mtok !== "number")
            continue;
        map.set(id, {
            input_per_mtok: row.input_per_mtok,
            output_per_mtok: typeof row.output_per_mtok === "number" ? row.output_per_mtok : null,
            cache_read_per_mtok: typeof row.cache_read_per_mtok === "number" ? row.cache_read_per_mtok : null,
            cache_write_per_mtok: typeof row.cache_write_per_mtok === "number" ? row.cache_write_per_mtok : null,
        });
    }
    return map;
}
const CATALOG = buildCatalog();
/**
 * Strip a single leading `provider/` segment, char-algorithmically (NO regex).
 * Walks to the first '/'; everything after it is the bare model id. Only the
 * FIRST segment is stripped — `openai/gpt-5` → `gpt-5`, `a/b/c` → `b/c` — so a
 * model id that legitimately contains a slash keeps its remaining segments.
 * Returns null when there is no '/' (caller already tried the raw form).
 */
function stripProviderPrefix(id) {
    for (let i = 0; i < id.length; i++) {
        if (id.charCodeAt(i) === 47 /* '/' */) {
            // Guard against a leading or trailing slash producing an empty segment.
            if (i === 0 || i === id.length - 1)
                return null;
            return id.slice(i + 1);
        }
    }
    return null;
}
/** trim + lowercase, char-safe (String.prototype.trim/toLowerCase, no regex). */
function normalize(id) {
    return id.trim().toLowerCase();
}
/**
 * Resolve a model id to its curated Price, or null on miss.
 * Strategy: exact, then normalized (trim+lowercase), then provider-stripped
 * normalized. Misses return null so the caller can decide (warn / fall back).
 */
export function lookupPrice(modelId) {
    if (typeof modelId !== "string" || modelId.length === 0)
        return null;
    // 1. Exact — fastest path, covers ids already in canonical form.
    const exact = CATALOG.get(modelId);
    if (exact)
        return exact;
    // 2. Normalized — trimmed + lowercased.
    const norm = normalize(modelId);
    const byNorm = CATALOG.get(norm);
    if (byNorm)
        return byNorm;
    // 3. Provider-stripped (pi / openclaw / opencode report `provider/model`).
    const bare = stripProviderPrefix(norm);
    if (bare) {
        const byBare = CATALOG.get(bare);
        if (byBare)
            return byBare;
    }
    return null;
}
/** Price one token bucket. A null bucket rate falls back to the input rate. */
function bucketCost(tokens, rate, inputRate) {
    if (tokens <= 0)
        return 0;
    const effective = typeof rate === "number" ? rate : inputRate;
    return tokens * effective;
}
// --- DeepSeek time-aware override -------------------------------------------
//
// The curated catalog bills every model at ONE static rate (DeepSeek's PEAK
// card). DeepSeek actually charges peak/off-peak by wall-clock, so for the two
// current billing keys we substitute the rate in effect at the request instant.
// The engine below is a self-contained, pure-UTC mirror of the repo's rates.ts
// (same peak windows, same 2026 CN holiday table, same rate cards), inlined so
// this module keeps ZERO new imports and never touches the filesystem.
//
// Peak windows (UTC, Mon-Fri, excluding CN public holidays):
//   [01:00, 04:00) and [06:00, 10:00)
// Off-peak is exactly half of peak for every bucket. A missing/NaN timestamp
// keeps the static PEAK rate — i.e. exactly what lookupPrice returns today.
const DEEPSEEK_PEAK_RATES = {
    "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
};
const DEEPSEEK_OFFPEAK_RATES = {
    "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
};
/** Legacy API names still accepted and billed at Flash price. */
const DEEPSEEK_LEGACY_ALIASES = {
    "deepseek-v4-flash": "deepseek-flash",
};
/** 2026 State Council rest-day ranges, inclusive, calendar dates in UTC. */
const DEEPSEEK_HOLIDAYS_2026 = [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
];
/**
 * Canonical DeepSeek billing key for an id, or null when it is not one of the
 * time-aware DeepSeek models. Lowercases, trims, strips ONE provider/ prefix,
 * then maps the legacy alias before the final key lookup.
 */
function deepseekRateKey(modelId) {
    if (typeof modelId !== "string")
        return null;
    let name = normalize(modelId);
    const bare = stripProviderPrefix(name);
    if (bare)
        name = bare;
    if (Object.prototype.hasOwnProperty.call(DEEPSEEK_LEGACY_ALIASES, name))
        name = DEEPSEEK_LEGACY_ALIASES[name];
    return Object.prototype.hasOwnProperty.call(DEEPSEEK_PEAK_RATES, name) ? name : null;
}
/** True when the UTC date falls inside an inclusive 2026 CN holiday range. */
function isCnHolidayUtc(utcMs) {
    const date = new Date(utcMs).toISOString().slice(0, 10);
    for (const range of DEEPSEEK_HOLIDAYS_2026) {
        if (date >= range[0] && date <= range[1])
            return true;
    }
    return false;
}
/** True during a DeepSeek peak window (weekday, non-holiday, UTC hours). */
function isDeepseekPeak(utcMs) {
    if (isCnHolidayUtc(utcMs))
        return false;
    const d = new Date(utcMs);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6)
        return false;
    const h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
/**
 * Σ tokens × per-Mtok price / 1e6 over the four buckets. Returns null when no
 * price is found OR every token count is zero/absent (so dashboards never show
 * a misleading "$0.00 for nothing" row). On a price miss, warns exactly once
 * with the unmatched id so the curated catalog can be extended.
 *
 * Bucket → price mapping:
 *   input_tokens          → input_per_mtok
 *   output_tokens         → output_per_mtok  (null ⇒ input rate)
 *   cache_read_tokens     → cache_read_per_mtok  (null ⇒ input rate)
 *   cache_creation_tokens → cache_write_per_mtok (null ⇒ input rate)
 *
 * Optional `tsMs` (epoch ms) selects the DeepSeek peak/off-peak rate in effect
 * at that instant for the two time-aware DeepSeek ids; when absent or NaN the
 * static catalog (peak) row is used, so existing two-arg callers are unchanged.
 */
export function computeCostUsd(modelId, t, tsMs) {
    const input = typeof t.input_tokens === "number" ? t.input_tokens : 0;
    const output = typeof t.output_tokens === "number" ? t.output_tokens : 0;
    const cacheRead = typeof t.cache_read_tokens === "number" ? t.cache_read_tokens : 0;
    const cacheCreate = typeof t.cache_creation_tokens === "number" ? t.cache_creation_tokens : 0;
    // All buckets empty ⇒ nothing to price, regardless of model.
    if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheCreate <= 0)
        return null;
    const price = lookupPrice(modelId);
    if (!price || typeof price.input_per_mtok !== "number") {
        // Unknown model — emit one line so the id can be added to the catalog.
        console.warn(`[pricing] no curated price for model id: ${modelId}`);
        return null;
    }
    // DeepSeek: swap the static catalog row for the peak/off-peak card. With no
    // (or a NaN) timestamp this uses the PEAK card, identical to the row above.
    const deepseekKey = deepseekRateKey(modelId);
    if (deepseekKey !== null) {
        const rates = typeof tsMs === "number" && Number.isFinite(tsMs)
            ? isDeepseekPeak(tsMs)
                ? DEEPSEEK_PEAK_RATES[deepseekKey]
                : DEEPSEEK_OFFPEAK_RATES[deepseekKey]
            : DEEPSEEK_PEAK_RATES[deepseekKey];
        const inputRate = rates.input;
        const microDollars = bucketCost(input, inputRate, inputRate) +
            bucketCost(output, rates.output, inputRate) +
            bucketCost(cacheRead, rates.cacheRead, inputRate) +
            bucketCost(cacheCreate, rates.cacheWrite, inputRate);
        return microDollars / 1_000_000;
    }
    const inputRate = price.input_per_mtok;
    const microDollars = bucketCost(input, inputRate, inputRate) +
        bucketCost(output, price.output_per_mtok, inputRate) +
        bucketCost(cacheRead, price.cache_read_per_mtok, inputRate) +
        bucketCost(cacheCreate, price.cache_write_per_mtok, inputRate);
    return microDollars / 1_000_000;
}
/**
 * Prefer a provider-supplied native cost when present, else compute from the
 * catalog. A native cost of exactly 0 is a real value (free tier) and passes
 * through — only null/undefined defers to computeCostUsd.
 */
export function nativeOrComputed(modelId, t, nativeCostUsd) {
    if (typeof nativeCostUsd === "number")
        return nativeCostUsd;
    return computeCostUsd(modelId, t);
}
