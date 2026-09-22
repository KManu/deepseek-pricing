# PROGRESS — DeepSeek Dynamic (Peak/Off-Peak) Pricing

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done

Repo root: `~/dev/deepseek-pricing/`
Runtime deploy: `~/.pi/agent/extensions/deepseek-pricing/`

---

## Phase status board

| Phase | Build | Review | Installed | Live verification |
|---|---|---|---|---|
| Phase 1 — rate engine + extension | `[x]` | `[x]` | `[x]` | `[x]` (2026-09-22, user-confirmed) |
| Phase 2 — reconciliation + ops | `[x]` | `[x]` | `[x]` | `[x]` (2026-09-22, live probe + CLI + daemon) |
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

### Phase 1 — LIVE VERIFICATION (`[x]` DONE 2026-09-22)

User confirmed in a separate pi session: extension loads without startup
errors and `/ds-cost` renders the session report. `/reload` in the working
session hot-reloaded the extension successfully (docs: auto-discovered
extensions can be hot-reloaded with `/reload`).

---
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

**Implemented:** `[x]` (2026-09-22) · **Reviewed:** `[x]` (taskflow gates,
`taskflow/phase2.json`) · **Installed:** `[x]`

Commits:
- `33b5a10` feat: phase 2 ds-reconcile balance reconciliation CLI
- `c8317a5` feat: guarded session_compact cost-probe handler (phase 2 D-09)
- `70c0ba5` fix: ledger nativeCost = static peak-rate baseline (meaningful delta)
- `bcffd33` docs: phase 2 live evidence recorded
- `1adeed5` fix: detached daemon + per-session incremental reconciliation (firstTs)
  + D-09 resolution (see git log for hash; committed 2026-09-22)

Deliverables on disk:
- `scripts/ds-reconcile.mjs` — zero-dep Node ESM balance reconciliation CLI
- `index.ts` — guarded `session_compact` D-09 probe handler added
- `install.sh` — best-effort installs the CLI to `~/.local/bin/ds-reconcile`
- `docs/research-notes.md` — §7 balance API shape + reconciliation formulas

Deployed:
- `~/.local/bin/ds-reconcile` — mode 0755, byte-identical to the repo copy
  (installed by `bash install.sh`)
- `~/.pi/deepseek-pricing/balance.jsonl` — balance history (3 samples so far)
- `~/.pi/deepseek-pricing/compaction-probe.jsonl` — created on the first
  compaction after the probe handler is loaded (not present yet)

**Verification performed (2026-09-22):**

| Check | Command | Result |
|---|---|---|
| Repo script present | `test -f scripts/ds-reconcile.mjs` | present |
| Deployed + executable | `test -x ~/.local/bin/ds-reconcile` | executable (0755) |
| Deploy fidelity | `diff -q` repo vs installed | identical |
| Syntax | `node --check scripts/ds-reconcile.mjs` | OK |
| CLI surface | `ds-reconcile --help` | `--once` / `--daemon` / `--stop` / `--help` |
| Probe handler | grep `session_compact` in `index.ts` | registered, try/catch guarded |
| Balance history | `wc -l ~/.pi/deepseek-pricing/balance.jsonl` | 3 sample lines |
| Live balance API | `node scripts/ds-reconcile.mjs --once` | OK: real USD balances, spend $0.01 between samples, drift line printed |
| Live ledger pipeline | `tail -1 ~/.pi/deepseek-pricing/ledger.jsonl` | line from session `01a0c90d`: stored cost == half-peak == dynamic (proves `message_end` patching end-to-end) |
| Unit tests after fix | `node --test tests/rates.test.ts tests/ds-reconcile.test.mjs` | `# pass 24` |

### Phase 2 — LIVE VERIFICATION (DONE, 2026-09-22)

**(a) D-09 compaction probe — RESOLVED: mutate.**

Live probe line (session `01a0c8a2`, `/compact` at 13:38Z):

```json
{"ts":1790084330171,"sessionId":"01a0c8a2-...","model":"deepseek-v4-pro",
 "recomputedTotal":0.09109914,"objectTotalAfterMutation":0.09109914,
 "reflectedInEntries":true,"note":"in-place session_compact usage.cost mutation..."}
```

`recomputedTotal == objectTotalAfterMutation` and `reflectedInEntries=true`:
pi persists the mutated cost → compaction summaries are billed at the
time-aware rate. The handler is now the production correction (comment
updated in `index.ts`); every mutation stays audited in
`~/.pi/deepseek-pricing/compaction-probe.jsonl`. **D-09 = mutate.**

**(b) `ds-reconcile` drift line — verified, and two real bugs fixed.**

Live `--once` runs hit the balance API (real USD balances) and printed the
drift line. The first live drift reading exposed two defects, both fixed and
re-verified:

1. **Cumulative-line double counting**: ledger lines are cumulative per
   session, so summing raw `dynamicCost` over a window double-counted
   (+$1.73 ghost drift on first run). Fixed: per-session incremental deltas
   via a new `firstTs` field (branch start) on each ledger line; legacy
   lines without `firstTs` are reported as excluded. Covered by 5 new unit
   tests (`tests/ds-reconcile.test.mjs`).
2. **`--daemon` never detached**: the interval loop kept the foreground
   process alive (CLI never returned). Fixed: `--daemon` spawns a detached
   child (`--daemon-child`, internal) and returns in ~0.2s; the child owns
   the pidfile.

**(c) Daemon lifecycle — verified.**

```
ds-reconcile --daemon --interval 1   # returns immediately; detached sampler (pid N)
ds-reconcile --once                  # sample now; drift + short-window note
ds-reconcile --stop                  # SIGTERM; "stopped (pid N)"
```

Observed: pidfile appears, sample appended, `--stop` kills the detached
child and removes the pidfile, and a live pidfile refuses a second start.

Final test count: `node --test tests/rates.test.ts tests/ds-reconcile.test.mjs`
→ **24 tests, 24 pass, 0 fail**. (`node --test tests/` alone does not pick up
`.mjs` on this Node version — pass both files explicitly.)

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

---

# Phase 2 — Implementation Summary

_(appended 2026-09-22)_

## Files created / changed

| File | Purpose |
|---|---|
| `scripts/ds-reconcile.mjs` | Zero-dep Node ESM CLI. Reads the DeepSeek API key from `~/.pi/agent/auth.json` (`deepseek.key`, never logged), GETs `https://api.deepseek.com/user/balance`, appends a `{ts,totalBalance,grantedBalance,toppedUpBalance,currency}` sample to `~/.pi/deepseek-pricing/balance.jsonl`, and compares the balance drop between the latest two samples against the sum of `dynamicCost` in `ledger.jsonl` over the same `(prev.ts, curr.ts]` window (exclusive start avoids double-counting). Reports `drift = ledgerWindowSum - balanceSpend`, with `balanceSpend = prev.total - curr.total + max(0, curr.toppedUp - prev.toppedUp)`. Prefers the USD `balance_infos` entry; skips drift for non-USD or mixed-currency balances. Modes: `--once` (default), `--daemon [--interval <min>]`, `--stop`, `--help`. Daemon follows the AGENTS.md pidfile pattern (`~/.pi/deepseek-pricing/ds-reconcile.pid`) with SIGTERM/SIGINT cleanup and single-instance refusal. |
| `index.ts` (changed) | Added a guarded `pi.on("session_compact", …)` D-09 probe. On compaction it locates the saved `compactionEntry`; only for DeepSeek it recomputes `usage.cost` at the entry timestamp, mutates the cost object in place, then re-reads `ctx.sessionManager.getEntries()` to see whether the mutation is reflected. It appends the outcome (`recomputedTotal`, `objectTotalAfterMutation`, `reflectedInEntries`) to `~/.pi/deepseek-pricing/compaction-probe.jsonl`. Evidence-only and fully try/catch guarded — it never changes pi behaviour and never throws into pi. |
| `install.sh` (changed) | Best-effort installs `scripts/ds-reconcile.mjs` to `~/.local/bin/ds-reconcile` and `chmod +x`. |
| `docs/research-notes.md` | §7: DeepSeek balance API shape + reconciliation formulas. |

## What Phase 2 adds at runtime

- **Balance ground truth.** `ds-reconcile` samples the account balance so the
  dynamic time-aware pricing can be validated against reality rather than only
  against pi's static-peak estimate.
- **Drift report.** Per sample: availability, currency, total / granted /
  topped-up, the top-up-adjusted balance spend over the window and the ledger
  window sum, ending in a signed `drift` line.
- **D-09 evidence.** The compaction probe turns the open "does pi keep the
  patched compaction cost?" question into a recorded, decidable fact.

## Verification performed

- `scripts/ds-reconcile.mjs` present; byte-identical to the installed,
  executable `~/.local/bin/ds-reconcile` (0755).
- `node --check scripts/ds-reconcile.mjs` → OK; `ds-reconcile --help` lists the
  `--once` / `--daemon` / `--stop` / `--help` surface.
- `index.ts` registers the guarded `session_compact` probe handler.
- `~/.pi/deepseek-pricing/balance.jsonl` has 3 well-formed sample lines.
- Phase 2 flow gates tracked in `taskflow/phase2.json`.

## Still open

Live verification only (see "Phase 2 — LIVE VERIFICATION (PENDING)" above):
(a) decide D-09 from `compaction-probe.jsonl` after `/reload` + `/compact`,
(b) read the `ds-reconcile` drift line, (c) optionally long-run `--daemon`.
