# PROGRESS — DeepSeek Dynamic (Peak/Off-Peak) Pricing

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done

Repo root: `~/dev/deepseek-pricing/`
Runtime deploy: `~/.pi/agent/extensions/deepseek-pricing/`

---

## Phase status board

| Phase | Build | Review | Installed | Live verification |
|---|---|---|---|---|
| Phase 1 — rate engine + extension | `[x]` | `[x]` | `[x]` | `[ ]` **PENDING** |
| Phase 2 — reconciliation + ops | `[ ]` | `[ ]` | `[ ]` | `[ ]` |
| Phase 3 — context-mode stats (optional) | `[ ]` | `[ ]` | `[ ]` | `[ ]` |

---

## Phase 1 — Rate engine + pi extension

**Implemented:** `[x]` (2026-09-22) · **Reviewed:** `[x]` (taskflow gates,
`taskflow/phase1.json`) · **Installed:** `[x]`

Commits:
- `d05f447` feat: phase 1 pure DeepSeek rate engine
- `0c51761` feat: phase 1 pi extension + install script

Deliverables on disk:
- `cn-holidays.json`
- `rates.ts`
- `tests/rates.test.ts`
- `index.ts`
- `install.sh`

Deployed (byte-identical to repo copies, via `bash install.sh`):
- `~/.pi/agent/extensions/deepseek-pricing/{index.ts,rates.ts,cn-holidays.json}`
- `~/.pi/deepseek-pricing/` (ledger dir, created; empty until first settle)

**Verification performed (2026-09-22):**

| Check | Command | Result |
|---|---|---|
| Unit tests | `node --test tests/` | `# tests 16`, `# pass 16`, `# fail 0` |
| Syntax | `node --check index.ts && node --check rates.ts` | both OK |
| Installer | `bash install.sh` | `installed: ~/.pi/agent/extensions/deepseek-pricing` |
| Deploy fidelity | `diff -q` repo vs installed for all 3 files | identical |
| API conformance | reviewed vs `docs/extension-api-cheat.md` | pass (taskflow gates) |

Not yet verified: the live end-to-end path through a real pi session
(see below). This is the only open Phase 1 item.

### Phase 1 — LIVE VERIFICATION (PENDING)

Manual steps, run after the extension has been installed. Requires a **fresh pi
session** so the extension is discovered at startup.

1. **Extension discovery / no startup error.**
   Start a new pi session (`pi` from any directory) and confirm the
   `deepseek-pricing` extension loads without an error in pi's output/logs.
   If the extension throws at load time it will be reported here; handlers
   themselves are try/catch guarded and never break a turn.

2. **Select a DeepSeek model.** In the session run `/model` and choose a
   DeepSeek model (e.g. `deepseek-v4-pro` or `deepseek-flash`). Record the exact
   model id shown.

3. **Produce one completed assistant turn** with a normal prompt so a
   `message_end` event with token usage is persisted.

4. **Check `/session` cost equals the timestamp-aware `computeCost`.**
   - Run `/session`; note the reported cost for the DeepSeek message and its
     timestamp.
   - Compute the expected value with the rate engine at that timestamp:
     `node -e "import('./rates.ts').then(m=>console.log(m.computeCost('<model-id>', {input:<n>,output:<n>,cacheRead:<n>,cacheWrite:<n>}, <timestamp_ms>)))"`
     (or mirror the arithmetic by hand:
     `bucket_tokens * bucket_rate / 1e6`, summed over the 4 buckets, using the
     peak or off-peak card in effect at the timestamp).
   - **Pass:** `/session` cost == expected `total` (within float tolerance).
     If the turn ran in an off-peak window the value must be ~half of pi's
     static peak cost.

5. **Check `/ds-cost` renders.**
   Run `/ds-cost`. It must render a markdown table with:
   - the current window (peak/off-peak) and the reason (window / weekend /
     CN public holiday),
   - this session's peak vs off-peak token split (input / output / cache-read),
   - dynamic vs native cost and the signed delta,
   - the active model and billed-entry count,
   - a pointer to `ds-reconcile`.
   An info notification with the same peak/off-peak summary should also appear.

6. **Check the ledger line appears on settle.**
   Let the session settle (stop when pi will not continue automatically), then:
   ```bash
   tail -n 1 ~/.pi/deepseek-pricing/ledger.jsonl
   ```
   **Pass:** one JSON line with keys
   `ts`, `sessionId`, `model`, `peakTokens{input,output,cacheRead}`,
   `offPeakTokens{input,output,cacheRead}`, `dynamicCost`, `nativeCost`, `delta`.
   `delta == dynamicCost - nativeCost`.

7. **Cross-check both windows (recommended).**
   If step 1–6 ran during peak, repeat once during an off-peak window
   (weekend, CN public holiday, or UTC hours outside `[01:00,04:00)` /
   `[06:00,10:00)`) and confirm off-peak rates were applied (cost ≈ half).
   Peak windows: `01:00–04:00` and `06:00–10:00` UTC, Mon–Fri, excluding CN
   public holidays.

8. **Non-DeepSeek safety check.**
   Switch to a non-DeepSeek model and send a turn; confirm the extension leaves
   its cost untouched and `/ds-cost` reports 0 billed entries.

Record the outcome (pass/fail + observed values) in the Phase 1 section above.

---

## Phase 2 — Reconciliation + ops

**Implemented:** `[ ]`

Deliverables (see `PLAN.md` / `docs/phase-specs/phase-2.md`):
`scripts/ds-reconcile.mjs` → `~/.local/bin/ds-reconcile`, balance history at
`~/.pi/deepseek-pricing/balance.jsonl`, drift report, optional auto-run wrapper,
and the compaction-summary decision (D-09).

Note: `install.sh` already tolerates a missing `scripts/ds-reconcile.mjs`
(`|| true`), so Phase 1 installs cleanly before Phase 2 lands. No
`ds-reconcile` binary exists yet.

## Phase 3 — context-mode stats accuracy (optional)

**Implemented:** `[ ]`

Patch context-mode's `pricing.js` + inlined hook bundle so `ctx_stats` reports
time-aware DeepSeek cost (see `PLAN.md` / `docs/phase-specs/phase-3.md`).

---

## Verification record — Phase 1 summary

_(appended 2026-09-22; see also the table above)_

# Phase 1 — Implementation Summary

## Files created

| File | Purpose |
|---|---|
| `rates.ts` | Pure, zero-dependency rate engine — the single source of truth. Exports `PEAK_RATES`/`OFFPEAK_RATES` (USD per 1M tokens), `normalizeModelId`, `isHoliday`, `isPeak`, `rateFor`, and `computeCost`. No side effects; importable by the extension, tests, and (phase 2) `ds-reconcile`. Evaluates everything in UTC. |
| `cn-holidays.json` | Official 2026 State Council public-holiday rest-day ranges (inclusive ISO dates), keyed by year. Imported by `rates.ts` for the holiday check. |
| `tests/rates.test.ts` | Zero-dep `node:test` suite (16 tests) covering `isPeak` window boundaries, weekends, holidays + inclusive range edges, make-up working days, legacy aliases / provider-prefixed ids, unknown-model rejection, `computeCost` math (peak vs off-peak, missing buckets → 0, unknown model → null, total == sum of buckets), and the off-peak == peak/2 invariant. |
| `index.ts` | The pi extension. `message_end` recomputes and replaces `usage.cost` for finalized DeepSeek assistant messages using the timestamped rate; `tool_result` patches nested-LLM usage when the active model is DeepSeek; `agent_settled` appends a per-session summary to the JSONL ledger; `registerCommand("ds-cost")` renders the session report. Stateless; every filesystem/handler path is wrapped so it can never throw into pi. |
| `install.sh` | Idempotent deploy: copies `index.ts`, `rates.ts`, `cn-holidays.json` into `~/.pi/agent/extensions/deepseek-pricing/`, creates the ledger + `~/.local/bin` dirs, and best-effort installs the (phase 2) `ds-reconcile` CLI. |

## What each does (runtime behaviour)

- **`message_end`** — fires for each finalized message; only acts on
  `role === "assistant"` with `provider === "deepseek"` and numeric tokens. It
  recomputes the four cost buckets at `message.timestamp` and returns the
  message with a patched `usage.cost`, keeping every other field. This is the
  mechanism that makes pi's footer / `/session` / RPC totals time-accurate.
- **`tool_result`** — patches `usage.cost` for nested LLM usage inside tool
  results, but only when `ctx.model` resolves to DeepSeek.
- **`agent_settled`** — aggregates the session's DeepSeek assistant +
  tool-result usage from `ctx.sessionManager.getEntries()`, splits it into
  peak/off-peak buckets, and appends `{ts, sessionId, model, peakTokens,
  offPeakTokens, dynamicCost, nativeCost, delta}` to
  `~/.pi/deepseek-pricing/ledger.jsonl` (mkdir -p first; all IO guarded).
- **`/ds-cost`** — prints an in-session markdown report: current window
  (peak/off-peak + reason), peak vs off-peak token split, dynamic vs native
  cost with signed delta, model + billed-entry count, and a `ds-reconcile`
  pointer; also raises an info notification.

## Verification performed

- `node --test tests/` → **16 tests, 16 pass, 0 fail.**
- `node --check index.ts` and `node --check rates.ts` → both pass.
- `bash install.sh` → deploys to `~/.pi/agent/extensions/deepseek-pricing/`.
- `diff -q` of all three deployed files vs repo copies → identical.
- Rate numbers in `rates.ts` match `docs/research-notes.md` §1 exactly
  (flash peak `.3 / 1.2 / .006 / 0`, off `.15 / .6 / .003 / 0`; pro peak
  `1.32 / 3.96 / .044 / 0`, off `.66 / 1.98 / .022 / 0`).
- Extension surface reviewed against `docs/extension-api-cheat.md` via the
  taskflow reviewer gates (`taskflow/phase1.json`).

## Still open

Live end-to-end verification in a fresh pi session (see the Phase 1 LIVE
VERIFICATION checklist above) — this is the only Phase 1 item not yet
completed.
