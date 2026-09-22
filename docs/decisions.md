# Decisions & Assumptions

Each decision records what we chose, why, and what would change it.

## D-01: Correct at the extension layer; never patch pi core
pi's cost model is static per model (peak rates baked into the built-in catalog).
Patching pi's dist would be lost on every upgrade and risks subtle accounting
bugs. Instead, an extension corrects `usage.cost` at the persistence boundary
(`message_end` replacement — documented behavior).
Change if: pi gains native time-based pricing (then delete this project).

## D-02: Billing instant = usage entry timestamp (≈ request completion)
DeepSeek returns no per-request price and the page does not say whether a
request spanning a window boundary is billed by start or end time. Peak windows
are 3–4h blocks, so ambiguity is limited to boundary minutes; expected error is
negligible. `ds-reconcile` (balance history vs ledger) detects any systematic
mismatch.
Change if: DeepSeek documents start-time billing, or reconciliation shows drift.

## D-03: Pure-UTC evaluation
Proven in research-notes §2: every peak hour has Beijing date == UTC date and
Beijing weekday == UTC weekday. No timezone library, no DST risk.
Change if: DeepSeek redefines windows to start before 01:00 UTC.

## D-04: Holidays = official rest-day ranges, whole days off-peak
"Chinese public holidays in full" is read as: all rest days in the State
Council schedule are off-peak all day. Make-up working days are all Sat/Sun and
fall out via the weekday rule — no special casing.
Change if: DeepSeek publishes a different interpretation, or reconciliation
shows drift around holidays.

## D-05: Static fallback stays PEAK
pi's built-in catalog keeps peak rates (conservative upper bound). Our
extension is the only place off-peak rates are applied. If the extension is
disabled, reported cost overestimates during off-peak rather than understates —
the safe failure direction.
Change if: user prefers off-peak as fallback (one-line change in extension? No —
fallback lives in pi's catalog; changing it means models.json modelOverrides).

## D-06: Deploy by copy, not symlink
Extension source lives in this repo; `install.sh` copies the runtime files into
`~/.pi/agent/extensions/deepseek-pricing/`. Symlinked extension dirs are not
documented as supported; a copy removes that uncertainty and leaves a clean
upgrade path (edit repo → re-run install.sh).
Change if: pi documents symlink support for extension discovery.

## D-07: Ledger location `~/.pi/deepseek-pricing/`
Separate from pi's own dirs (pi only inspects `~/.pi/agent` and `<cwd>/.pi`).
JSONL lines, append-only, written by the extension on `agent_settled` and by
`ds-reconcile` for balance samples. Survives pi upgrades.

## D-08: Holiday table refresh cadence
`cn-holidays.json` holds year-keyed ranges. New year announced in November →
add next year's ranges and commit. A missing year makes the engine treat every
day as non-holiday (fails toward peak rates = conservative, see D-05).

## D-09: Compaction summary cost — RESOLVED: mutate (2026-09-22)
The live `session_compact` probe proved that mutating the saved compaction
entry's `usage.cost` in place IS reflected by `sessionManager.getEntries()`
(compaction-probe.jsonl: recomputedTotal == objectTotalAfterMutation,
reflectedInEntries=true). The extension therefore rewrites the summarization
cost at the time-aware rate — compaction charges are billed peak/off-peak
correctly, no overestimate. Every mutation remains audited in
`~/.pi/deepseek-pricing/compaction-probe.jsonl`.

## D-10: Context-mode phase is isolated and re-patchable
Phase 3 edits files inside the context-mode package (build/ + hooks bundle).
Those edits do NOT survive context-mode upgrades; we keep a patch script in this
repo and re-run it after upgrades (same policy as the pi-shazam log-path fix).
