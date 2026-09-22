# Phase 3 Spec — context-mode time-aware pricing (optional)

Goal: `ctx_stats` / context-mode analytics also report time-accurate DeepSeek
cost, not just pi itself.

## Target files (inside installed context-mode)

- `~/.pi/agent/npm/node_modules/context-mode/build/session/pricing.js`
  (module; read at runtime via `import "./model-prices.json" with { type: "json" }`)
- `~/.pi/agent/npm/node_modules/context-mode/hooks/session-extract.bundle.mjs`
  (the hook bundle that ACTUALLY runs — catalog inlined; both must change)

## Change

1. `pricing.js`: extend `lookupPrice(modelId, ts?)` and
   `computeCostUsd(modelId, tokens, ts?)`: when the model resolves to a
   deepseek id, return rates from OUR engine logic (duplicate the tiny
   pure-UTC algorithm + holiday table inline; context-mode must stay
   self-contained) instead of the static row. Callers that pass no `ts` get
   the static peak row (backward compatible).
2. `session-extract.bundle.mjs`: same inline logic; locate the inlined
   catalog + pricing code in the minified bundle and patch equivalently.
3. Call sites: `build/session/extract.js` / `analytics.js` pass each event's
   timestamp. If a call site cannot easily carry `ts`, leave it static (peak)
   and note it.

## Policy

- Every context-mode upgrade wipes these patches → keep
  `scripts/patch-ctxmode.sh` in this repo that re-applies phase 3 (idempotent,
  exits non-zero with "ALREADY PATCHED" if current).
- Re-run `scripts/patch-ctxmode.sh` after `ctx-upgrade` or npm updates.
  Add a note in `~/.pi/agent/AGENTS.md` pointing at it.

## Acceptance criteria

- [ ] `node --test` equivalent: pricing module returns peak/off-peak per
      fixed timestamps for deepseek ids
- [ ] ctx_stats on a real session matches the extension ledger for deepseek rows
- [ ] patch script idempotent; documented in AGENTS.md
