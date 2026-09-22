# DeepSeek Dynamic (Peak/Off-Peak) Pricing — Master Plan

Goal: make **cost reported by usage on this machine always accurate** for DeepSeek
(direct provider), by computing peak/off-peak rates at request time instead of one
static rate. pi has no native time-based pricing (verified: zero hits in docs and
dist for off-peak/peak; the only alternate-rate mechanism is volume tiers), so we
build a thin local layer.

Status legend: `[ ]` planned · `[~]` in progress · `[x]` done

## Architecture (target)

```
~/dev/deepseek-pricing/                 ← this repo (plans, source, tests, flows)
├── PLAN.md                             ← this file (entry point)
├── PROGRESS.md                         ← per-phase status + verification records
├── docs/
│   ├── research-notes.md               ← all established facts + sources (READ FIRST)
│   ├── decisions.md                    ← decisions + assumptions we bill by
│   ├── extension-api-cheat.md          ← exact pi extension API surface we use
│   └── phase-specs/
│       ├── phase-1.md                  ← rate engine + extension + tests (SPEC)
│       ├── phase-2.md                  ← ledger + reconciliation CLI
│       └── phase-3.md                  ← context-mode time-aware pricing (optional)
├── taskflow/
│   ├── phase1.json                     ← taskflow definition (implement+test+review)
│   ├── phase2.json                     ← (authored when phase 1 lands)
│   └── phase3.json                     ← (authored when phase 2 lands)
├── rates.ts                            ← pure rate engine (single source of truth)
├── cn-holidays.json                    ← CN public holiday rest-day ranges (2026…)
├── index.ts                            ← pi extension (auto-discovered)
├── tests/rates.test.ts                 ← node --test suite (zero deps)
├── scripts/ds-reconcile.mjs            ← DeepSeek balance reconciliation CLI
└── install.sh                          ← deploys extension + CLI to runtime paths

~/.pi/agent/extensions/deepseek-pricing/   ← deployed copy (index.ts, rates.ts, cn-holidays.json)
~/.pi/deepseek-pricing/ledger.jsonl        ← per-session corrected cost ledger
~/.pi/deepseek-pricing/balance.jsonl       ← DeepSeek balance samples (ground truth)
~/.local/bin/ds-reconcile                  ← on PATH
```

## How accuracy is achieved (the core mechanism)

pi persists each assistant message with `usage.cost` computed from ONE static rate
set (the catalog's peak rates). Extensions can replace a finalized message on
`message_end`, including its `usage.cost` — documented behavior. Our extension
recomputes the cost buckets with the rate in effect at the message timestamp and
returns the patched message. pi's footer, `/session`, and RPC totals sum these
stored entries → live totals become time-accurate with zero pi-core patching.

Coverage of DeepSeek spend on this machine:

| Spend source | Corrected by | Notes |
|---|---|---|
| Assistant messages (main) | `message_end` patch | the bulk of tokens |
| Nested LLM usage in tool results | `tool_result` `usage` patch | e.g. summary generation |
| Compaction summaries | phase 2 decision | see research-notes (maybe unpatchable) |
| Prompt-cache warming | n/a | DeepSeek models have no `promptCache` lifetime → pi never warms them |

Ground truth: `GET https://api.deepseek.com/user/balance` (key in `~/.pi/agent/auth.json`)
via `ds-reconcile` — detects any drift between our model and actual billing.

## Phases

### Phase 1 — Rate engine + pi extension (the value core)  `[ ]`
Deliverables: `rates.ts`, `cn-holidays.json`, `tests/rates.test.ts`, `index.ts`,
`install.sh`, deployed to runtime paths, unit tests green, reviewed via taskflow,
live-verified in a fresh pi session.
Spec: `docs/phase-specs/phase-1.md` · Flow: `taskflow/phase1.json`

### Phase 2 — Reconciliation + ops  `[ ]`
Deliverables: `scripts/ds-reconcile.mjs` → `~/.local/bin/ds-reconcile`, balance
history, drift report, optional auto-run wrapper (AGENTS.md daemon pattern), and
the compaction-summary decision (patch if API allows, else documented overestimate).
Spec: `docs/phase-specs/phase-2.md`

### Phase 3 — context-mode stats accuracy (optional)  `[ ]`
Patch context-mode's `pricing.js` + inlined hook bundle so `ctx_stats` also reports
time-aware DeepSeek cost. Needs re-patching after every context-mode upgrade.
Spec: `docs/phase-specs/phase-3.md`

## Working rules (see docs/decisions.md for rationale)

1. All peak/off-peak evaluation is **pure UTC** — provably equivalent to Beijing
   calendar rules because every peak window lies ≥ 01:00 UTC (= 09:00 Beijing).
2. Billing instant = the usage entry's timestamp (≈ request completion). Boundary
   minutes are the only ambiguity; `ds-reconcile` catches systematic drift.
3. pi's built-in static rates stay at **peak** (conservative fallback baseline);
   our layer corrects on top. Never patch pi core.
4. Holiday table = official State Council rest-day ranges; refresh annually
   (2027 notice expected Nov 2026).
5. Extension source lives in this repo; `install.sh` copies it into
   `~/.pi/agent/extensions/deepseek-pricing/` (no symlink-uncertainty).

## How to run

- Phase 1 flow: `taskflow(action=run, defineFile=taskflow/phase1.json)`
  (verify/plan first: `action=verify`, `action=plan`).
- Unit tests: `node --test tests/` (Node ≥22.18 runs .ts natively).
- Deploy: `bash install.sh`.
- Live check: new pi session → `/ds-cost`, and compare `/session` cost vs manual math.
- Reconcile: `ds-reconcile` (optionally `ds-reconcile --daemon` per AGENTS.md pattern).
