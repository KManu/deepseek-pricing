// Pure DeepSeek peak/off-peak rate engine. Single source of truth.
//
// No side effects: importable by the pi extension, tests, and ds-reconcile.
// Zero npm dependencies. Numbers mirror docs/research-notes.md §1 exactly.
//
// Peak hours (UTC, Mon-Fri, excluding CN public holidays):
//   [01:00, 04:00) and [06:00, 10:00)
// Everything else (other hours, weekends, holidays in full) is off-peak.
// Per research-notes §2 the UTC date/weekday is sufficient for every window
// that can be peak, so this module stays entirely in UTC.

import cnHolidays from "./cn-holidays.json" with { type: "json" };

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** USD per 1M tokens. */
export const PEAK_RATES: Record<string, Rates> = {
  "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
};

/** USD per 1M tokens; exactly half of peak for every bucket. */
export const OFFPEAK_RATES: Record<string, Rates> = {
  "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
};

/** Legacy API names still accepted and billed at Flash price. */
const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/**
 * Canonicalize a model id.
 * Lowercases, drops any `provider/` prefix, and maps legacy aliases to their
 * billing key. Returns `null` for anything that is not a DeepSeek-family id;
 * DeepSeek-family ids without a rate card normalize to themselves (and are
 * then rejected by `rateFor`, which owns the rate-key lookup).
 */
export function normalizeModelId(id: string): string | null {
  if (typeof id !== "string") return null;
  let name = id.toLowerCase();
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  if (Object.hasOwn(LEGACY_ALIASES, name)) name = LEGACY_ALIASES[name]!;
  if (Object.hasOwn(PEAK_RATES, name)) return name;
  // Other DeepSeek-family ids normalize to themselves (and simply have no
  // rate key); anything that is not DeepSeek is rejected here.
  return name === "deepseek" || name.startsWith("deepseek-") ? name : null;
}

interface HolidayYear {
  ranges: [string, string][];
}

interface HolidayCalendar {
  note: string;
  years: Record<string, HolidayYear>;
}

const HOLIDAYS = cnHolidays as HolidayCalendar;

function utcDate(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** True when the UTC date falls inside an inclusive CN public-holiday range. */
export function isHoliday(utcMs: number): boolean {
  const date = utcDate(utcMs);
  const year = date.slice(0, 4);
  const entry = HOLIDAYS.years[year];
  if (!entry) return false;
  for (const [start, end] of entry.ranges) {
    if (date >= start && date <= end) return true;
  }
  return false;
}

/** True during a DeepSeek peak window (weekday, non-holiday, UTC hours). */
export function isPeak(utcMs: number): boolean {
  if (isHoliday(utcMs)) return false;
  const d = new Date(utcMs);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Applicable rate card for a model at an instant, or `null` if not DeepSeek. */
export function rateFor(modelId: string, utcMs: number): Rates | null {
  const key = normalizeModelId(modelId);
  if (!key) return null;
  const table = isPeak(utcMs) ? PEAK_RATES : OFFPEAK_RATES;
  return Object.hasOwn(table, key) ? table[key] : null;
}

function costAtRates(modelId: string, usage: Usage, table: Record<string, Rates>): Cost | null {
  const key = normalizeModelId(modelId);
  if (!key || !Object.hasOwn(table, key)) return null;
  const rate = table[key]!;
  const u = usage ?? {};
  const input = ((u.input ?? 0) * rate.input) / 1e6;
  const output = ((u.output ?? 0) * rate.output) / 1e6;
  const cacheRead = ((u.cacheRead ?? 0) * rate.cacheRead) / 1e6;
  const cacheWrite = ((u.cacheWrite ?? 0) * rate.cacheWrite) / 1e6;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Cost in USD for a usage record at an instant.
 * `cost.bucket = tokens.bucket * rate.bucket / 1e6`, no rounding.
 * Missing/undefined token fields count as 0.
 * Returns `null` when the model is not a known DeepSeek billing model.
 */
export function computeCost(modelId: string, usage: Usage, utcMs: number): Cost | null {
  return costAtRates(modelId, usage, isPeak(utcMs) ? PEAK_RATES : OFFPEAK_RATES);
}

/**
 * Static PEAK-rate cost — what pi's built-in catalog would bill regardless of
 * time of day. Used to quantify what the dynamic pricing corrected
 * (peak minus dynamic = amount the extension saved).
 */
export function computePeakCost(modelId: string, usage: Usage): Cost | null {
  return costAtRates(modelId, usage, PEAK_RATES);
}
