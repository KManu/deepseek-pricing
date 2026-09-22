# Phase 2 Spec — Reconciliation + ops

Prereq: phase 1 accepted.

## 1. scripts/ds-reconcile.mjs — ground-truth reconciliation CLI

Zero-dep Node ESM script, deployed to `~/.local/bin/ds-reconcile`.

Behavior:
- Read DeepSeek API key from `~/.pi/agent/auth.json` (`deepseek.key`).
  Fail with a clear message if absent.
- `GET https://api.deepseek.com/user/balance` (Bearer key). On HTTP error,
  exit non-zero with the status + body snippet.
- Append a sample line to `~/.pi/deepseek-pricing/balance.jsonl`:
  `{ ts, totalBalance, grantedBalance, toppedUpBalance, currency }`.
- Print: current balances, spend since previous sample
  (topUpDelta + (prevToppedUp - currToppedUp) — using topped_up balance deltas
  plus top-up detection from toppedUpBalance increases), and the ledger-sum
  window comparison: dynamicCost sum from `ledger.jsonl` lines with
  `ts` between the previous and current sample → report drift =
  ledgerWindowSum − balanceWindowSpend (negative drift = we under-billed our
  estimate; positive = over).
- Flags: `--once` (default), `--daemon` (loop every N min via setInterval,
  `--interval <min>` default 60; single-instance pidfile at
  `~/.pi/deepseek-pricing/ds-reconcile.pid` per AGENTS.md daemon convention),
  `--help`.

## 2. Compaction-summary decision (from decisions.md D-09)

Attempt in a live session: in `session_compact` handler, mutate
`event.compactionEntry.usage.cost` (if object) and observe whether pi's
`/session` reflects it. If yes → add a `session_compact` handler to index.ts.
If no → leave as-is (documented overestimate) and mark ledger lines with
`compactionOverestimate: true` when a compaction entry is present.

## 3. Ledger format (produced by phase 1; consumed here)

One JSONL line per settled agent run:
`{ ts, sessionId, model, peakTokens:{input,output,cacheRead},
offPeakTokens:{...}, dynamicCost, nativeCost, delta }`

## Acceptance criteria

- [ ] ds-reconcile --once exits 0 with balances + drift line
- [ ] balance.jsonl grows one line per run; ledger window sum matches manual math
- [ ] daemon mode keeps a pidfile and re-runs on interval; `kill $(cat pidfile)` cleans up
- [ ] compaction decision recorded in docs/decisions.md with observed result
