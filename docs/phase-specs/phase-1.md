# Phase 1 Spec — Rate engine + pi extension

Authoritative implementation contract. Read `../research-notes.md` and
`../extension-api-cheat.md` first. Root: repo root `~/dev/deepseek-pricing/`.

## Files to create

1. `cn-holidays.json`
2. `rates.ts`
3. `tests/rates.test.ts`
4. `index.ts`
5. `install.sh`

Runtime: Node ≥ 22.18 runs .ts natively (`node --test tests/`). **Zero npm deps.**

## 1. cn-holidays.json

```json
{
  "note": "State Council public-holiday rest-day ranges (inclusive, China calendar). Add next year when announced (Nov).",
  "years": {
    "2026": {
      "ranges": [
        ["2026-01-01", "2026-01-03"],
        ["2026-02-15", "2026-02-23"],
        ["2026-04-04", "2026-04-06"],
        ["2026-05-01", "2026-05-05"],
        ["2026-06-19", "2026-06-21"],
        ["2026-09-25", "2026-09-27"],
        ["2026-10-01", "2026-10-07"]
      ]
    }
  }
}
```
Ranges are ISO `YYYY-MM-DD`, inclusive both ends. Dates are China-calendar
dates; per the UTC simplification (research-notes §2) comparing against the UTC
date string is correct for all peak windows.

## 2. rates.ts — pure rate engine (single source of truth)

Exports (no side effects; importable by extension, tests, ds-reconcile):

```ts
export interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number }
export interface Cost { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }

export const PEAK_RATES: Record<string, Rates>   // keys: "deepseek-flash", "deepseek-v4-pro"
export const OFFPEAK_RATES: Record<string, Rates>
export function normalizeModelId(id: string): string | null
   // lowercase; strip leading "provider/" segment ("deepseek/deepseek-flash" → "deepseek-flash");
   // map legacy aliases "deepseek-v4-flash", "deepseek-v4-flash-vision-exp" → "deepseek-flash";
   // return null for anything not deepseek
export function isHoliday(utcMs: number): boolean        // date-range lookup in cn-holidays.json (import it)
export function isPeak(utcMs: number): boolean           // research-notes §2 algorithm, pure UTC
export function rateFor(modelId: string, utcMs: number): Rates | null
export function computeCost(modelId: string, usage: Usage, utcMs: number): Cost | null
   // cost.bucket = tokens.bucket * rate.bucket / 1e6 (no rounding); total = sum of 4 buckets;
   // missing/undefined token fields count as 0; return null when model not deepseek
```

Numbers must match the pricing page exactly:
- flash peak: input .3, output 1.2, cacheRead .006, cacheWrite 0
- flash off:  .15 / .6 / .003 / 0
- pro peak:   1.32 / 3.96 / .044 / 0
- pro off:    .66 / 1.98 / .022 / 0

`isPeak` algorithm (UTC only):
```
d = new Date(utcMs)
if isHoliday(utcMs) return false
wd = d.getUTCDay(); if (wd === 0 || wd === 6) return false
h = d.getUTCHours(); return (h >= 1 && h < 4) || (h >= 6 && h < 10)
```

## 3. tests/rates.test.ts — node:test, no deps

Cover at least:
- isPeak boundaries on a normal Monday 2026-03-02: 00:59 off, 01:00 peak,
  03:59 peak, 04:00 off, 05:59 off, 06:00 peak, 09:59 peak, 10:00 off.
- Weekend off all day (2026-03-07 Sat 02:00 → off; 2026-03-08 Sun 07:00 → off).
- Holidays off all day: 2026-02-16 (Mon, Spring Festival, 02:00 UTC → off);
  2026-01-02 (Fri, New Year, 07:30 → off); 2026-10-05 (Mon, National Day, 06:15 → off).
- Make-up working day 2026-02-14 (Sat) 02:00 → off (weekend rule).
- Normal Friday 2026-03-06 08:00 → peak.
- rateFor: peak vs off-peak values for flash & pro at same hour; legacy alias
  mapping; "deepseek/deepseek-flash" prefixed form; unknown model → null.
- computeCost math: exact expected numbers for a known usage (e.g. 1M tokens of
  each bucket at peak vs off); missing buckets → 0; unknown model → null;
  total == sum of buckets.
- Sanity invariants: offPeak == peak/2 for every bucket/model.

Run: `node --test tests/` must exit 0.

## 4. index.ts — the extension

Factory per extension-api-cheat.md. Behavior:

- `message_end`: if assistant message, `provider === "deepseek"`, usage with
  numeric tokens → recompute `usage.cost` via `computeCost(model, usage,
  m.timestamp ?? Date.now())`; return `{ message: { ...m, usage: { ...m.usage,
  cost } } }`. Otherwise return nothing.
- `tool_result`: if a usage patch is present and active model is deepseek
  (`ctx.model`), recompute its cost the same way; return `{ usage: {...} }`.
- `agent_settled`: append one JSONL line to `~/.pi/deepseek-pricing/ledger.jsonl`:
  `{ ts, sessionId, model, peakTokens:{input,output,cacheRead}, offPeakTokens:{...},
  dynamicCost, nativeCost, delta }` aggregated from
  `ctx.sessionManager.getEntries()` (deepseek assistant messages + tool-result
  usage). mkdir -p first; guard all IO with try/catch (never break pi).
- `registerCommand("ds-cost")`: markdown report — current window
  (peak/off-peak + why), this session's peak vs off-peak token split, dynamic
  vs native cost delta, and a pointer to `ds-reconcile`.
- Keep a module-level stateless design; all state derives from session entries.

## 5. install.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.pi/agent/extensions/deepseek-pricing"
mkdir -p "$DEST" "$HOME/.pi/deepseek-pricing" "$HOME/.local/bin"
cp "$REPO/index.ts" "$REPO/rates.ts" "$REPO/cn-holidays.json" "$DEST/"
cp "$REPO/scripts/ds-reconcile.mjs" "$HOME/.local/bin/ds-reconcile" 2>/dev/null || true
chmod +x "$HOME/.local/bin/ds-reconcile" 2>/dev/null || true
echo "installed: $DEST"
```
(Phase 2 adds ds-reconcile; the `|| true` lets phase 1 install cleanly first.)

## Acceptance criteria (phase-1 gate)

- [ ] `node --test tests/` green (all cases above + invariants)
- [ ] `node --check` passes on index.ts and rates.ts
- [ ] install.sh idempotent; deployed files identical to repo copies
- [ ] rates.ts numbers match research-notes §1 exactly
- [ ] extension never throws into pi (all IO guarded); unknown models untouched
- [ ] LIVE: in a fresh pi session, after a deepseek turn, `/session` cost equals
      computeCost at that timestamp; `/ds-cost` renders; ledger line appears on settle
