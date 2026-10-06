# deepseek-pricing

Time-aware DeepSeek peak/off-peak pricing for pi: recomputes `usage.cost` at the persistence boundary using the rate in effect at each usage timestamp, keeps a per-session JSONL ledger, and reconciles it against your real DeepSeek account balance.

## What it does

pi persists a static, peak-rate cost for every DeepSeek message. This extension recomputes that cost at the persistence boundary (`message_end` / `tool_result`) using the peak/off-peak rate in effect at the usage timestamp, so pi's footer, `/session`, and RPC totals become time-accurate — with zero pi-core patching.

Concretely:

- **Corrects persisted costs.** Every finalized DeepSeek assistant message gets its `usage.cost` replaced with the time-aware value (all other fields kept). Nested-LLM usage from `tool_result` is patched the same way when the active model is DeepSeek.
- **Adds `/ds-cost`.** In-session markdown report with the current window (peak/off-peak + reason), peak vs off-peak token split, dynamic vs native cost and signed delta, model, and billed-entry count.
- **Writes a ledger.** On `agent_settled` it appends one cumulative message-usage summary line per settled session/branch to `~/.pi/deepseek-pricing/ledger.jsonl`.
- **Fixes compaction charges at the source.** On `session_compact` it rewrites the saved compaction entry's `usage.cost` in place at the time-aware rate; every mutation is audited to `compaction-probe.jsonl`.
- **Ships `ds-reconcile`.** A zero-dependency CLI that polls the DeepSeek balance API as ground truth and reports drift vs the ledger.
- **Optional context-mode patch.** Makes context-mode's `ctx_stats` report time-aware DeepSeek cost too (machine-local, re-applied after upgrades).

## How it works

**Rate engine** (`rates.ts`): pure UTC, zero dependencies, single source of truth imported by the extension, the tests, and `ds-reconcile`.

- Peak windows: **01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding CN public holidays** (2026 State Council rest-day ranges from `cn-holidays.json`, year-keyed).
- Off-peak is everything else, and is exactly **half of peak** for every bucket.
- USD per 1M tokens:

| model | window | input | output | cache-read | cache-write |
|---|---|---|---|---|---|
| `deepseek-flash` | peak | 0.30 | 1.20 | 0.006 | 0 |
| `deepseek-flash` | off-peak | 0.15 | 0.60 | 0.003 | 0 |
| `deepseek-v4-pro` | peak | 1.32 | 3.96 | 0.044 | 0 |
| `deepseek-v4-pro` | off-peak | 0.66 | 1.98 | 0.022 | 0 |

- Legacy aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are billed at Flash price; provider-prefixed ids (`provider/model`) are stripped before lookup.
- Cost math: `bucketTokens × bucketRate / 1e6`, no rounding; missing token fields count as 0; non-DeepSeek models are never touched.

**Events used:** `message_end` replaces finalized DeepSeek assistant messages with the recomputed `usage.cost`; `tool_result` patches nested-LLM usage; `agent_settled` writes the ledger summary; `session_compact` mutates the compaction entry's cost in place.

**Billing instant** is the usage entry's timestamp (≈ request completion). Pure-UTC evaluation is provably equivalent to Beijing calendar rules (see `docs/research-notes.md` §2).

**Fallback direction is deliberate:** pi's built-in static catalog stays at peak rates. If the extension is disabled, costs overestimate during off-peak rather than understate — the safe failure direction.

The extension is stateless and config-free: every value is derived from session entries and event payloads, and every handler plus all filesystem IO is wrapped in try/catch so the extension can never throw into pi.

## Install

### Option A — pi package (official)

```bash
pi install git:github.com/KManu/deepseek-pricing
```

Pi clones the repo and loads the declared extension (`package.json` → `"pi": { "extensions": ["./index.ts"] }`) via jiti. No npm install and no build step are needed: the package declares zero runtime dependencies, and the `ExtensionAPI` import is type-only and erased. Manage it with `pi list`, `pi update --extensions`, and `pi remove`.

Notes:

- The repo has no git tags yet, so tag-pinned installs (`git:...@v1`) are unavailable; commit refs still work.
- `pi install` loads the **extension only** — it does not deploy the `ds-reconcile` CLI or the patch script. For those, use Option B.

### Option B — manual (zip or clone), extension + CLI

Download the repo as a zip (or `git clone`), then run from the repo root:

```bash
bash install.sh
```

`install.sh` copies `index.ts`, `rates.ts`, `cn-holidays.json` into `~/.pi/agent/extensions/deepseek-pricing/` (pi auto-discovers subdirectories with an `index.ts`), creates `~/.pi/deepseek-pricing/`, and installs `ds-reconcile` to `~/.local/bin` (best-effort; make sure that directory is on your `PATH`). It is idempotent and deploys by copy, not symlink: edit the repo, re-run `install.sh` to upgrade.

## One-time machine-local step: context-mode patch (optional)

Only needed if you have **context-mode** installed and want its `ctx_stats` output to be time-accurate. The patch replaces the installed context-mode's unminified `build/session/pricing.js` with a self-contained time-aware engine (a timestamped `.pre-ds-pricing` backup is kept). The minified hook bundle is deliberately left unpatched — it already prefers the numeric `native_cost_usd` that this extension makes time-aware.

From a repo checkout:

```bash
bash scripts/patch-ctxmode.sh apply    # install the patch (idempotent)
bash scripts/patch-ctxmode.sh check    # read-only: reports PATCHED / NOT PATCHED
bash scripts/patch-ctxmode.sh verify   # check + live smoke test of computeCostUsd
```

Exit-code convention: `apply` exits **1** with `ALREADY PATCHED` when the installed file already matches the staged patch. That is success, not failure — inspect the output, not the exit code. Exit 0 means a fresh patch was applied.

**Re-run after every context-mode upgrade** — every `ctx-upgrade`, context-mode upgrade, or npm update wipes the patch. Forgetting this silently reverts `ctx_stats` to static peak rates (the pi extension itself is unaffected). A device-local note in `~/.pi/agent/AGENTS.md` enforces this.

## ds-reconcile: reconciling against the account

`ds-reconcile` reads the DeepSeek API key from `~/.pi/agent/auth.json` (`deepseek.key`, never logged), samples `https://api.deepseek.com/user/balance`, and appends a sample (`ts`, `totalBalance`, `grantedBalance`, `toppedUpBalance`, `currency`) to `~/.pi/deepseek-pricing/balance.jsonl`. It then compares the balance drop between the two latest samples against new ledger usage over the same window:

```
drift = ledgerWindowSum − balanceSpend
balanceSpend = prevTotal − currTotal + max(0, top-up)
```

The ledger side is summed as per-session incremental deltas (keyed by `firstTs`; legacy lines are excluded). **Negative drift = the local pricing under-billed vs the account; positive = over-billed.**

Usage:

```bash
ds-reconcile                              # one sample (--once, the default)
ds-reconcile --daemon                     # detached sampler, sample now then every 60 min
ds-reconcile --daemon --interval 30       # ...every 30 minutes
ds-reconcile --stop                       # stop the daemon (pidfile: ~/.pi/deepseek-pricing/ds-reconcile.pid)
ds-reconcile --help
```

The daemon is single-instance: starting it again while running prints the existing pid and tells you to use `--stop`.

Caveats:

- The **first sample prints drift n/a** — a previous sample is needed to bound the window.
- Only **USD** balances are comparable to the USD ledger; non-USD or mixed-currency samples print drift n/a.
- Windows **< 3h are flagged as noisy**: settle lines can lag usage and balance billing; long windows are authoritative.
- **Compaction charges are corrected in pi's transcript but never enter `ledger.jsonl`** — the ledger summarizes assistant and tool-result message entries only, while the account balance drop includes the compaction charge. Expect negative drift of roughly the compaction amount over windows containing a compaction. Each rewrite is audited in `compaction-probe.jsonl`.

## In-session command

Inside a pi session:

```
/ds-cost
```

Renders the per-session report (also raises an info notification): current window with reason and UTC instant, the peak-window definition, peak/off-peak token split (input / output / cache-read), dynamic vs native (pi static peak) cost with signed delta (`saved` / `over` / `even`), model, and billed-entry count.

## Ledger location and format

All runtime files live in `~/.pi/deepseek-pricing/` (kept outside `~/.pi/agent` so they survive pi upgrades and are never inspected by pi itself):

| file | contents |
|---|---|
| `~/.pi/deepseek-pricing/ledger.jsonl` | one append-only cumulative summary line per settled session/branch |
| `~/.pi/deepseek-pricing/balance.jsonl` | DeepSeek balance samples (ground truth for `ds-reconcile`) |
| `~/.pi/deepseek-pricing/compaction-probe.jsonl` | audit record of every `session_compact` cost rewrite |
| `~/.pi/agent/extensions/deepseek-pricing/` | the deployed extension (`index.ts`, `rates.ts`, `cn-holidays.json`) |
| `~/.local/bin/ds-reconcile` | reconciliation CLI |

Each ledger line (JSON per line) has the fields (illustrative values):

```json
{
  "ts": 1769000000000,
  "sessionId": "<pi session id>",
  "model": "deepseek-flash",
  "peakTokens": { "input": 12345, "output": 6789, "cacheRead": 0 },
  "offPeakTokens": { "input": 54321, "output": 21000, "cacheRead": 0 },
  "dynamicCost": 0.012345,
  "nativeCost": 0.024690,
  "delta": -0.012345,
  "firstTs": 1768990000000
}
```

`dynamicCost` is the time-aware cost, `nativeCost` is what pi's static peak catalog would have billed for the same buckets, and `delta = dynamicCost − nativeCost` (negative = saved). Cost values are USD, unrounded.

## Repo layout

| path | purpose |
|---|---|
| `index.ts` | the pi extension (events + `/ds-cost` command) |
| `rates.ts` | pure, side-effect-free rate engine — single source of truth |
| `cn-holidays.json` | CN State Council holiday rest-day ranges, year-keyed |
| `package.json` | pi package manifest (`"pi": { "extensions": ["./index.ts"] }`) |
| `install.sh` | deploys the extension and the CLI to runtime paths |
| `scripts/ds-reconcile.mjs` | balance reconciliation CLI (zero-dep ESM) |
| `scripts/patch-ctxmode.sh` | context-mode patch installer (`apply`/`check`/`verify`) |
| `scripts/probe-native-pass.mjs` | evidence probe for native-cost pass-through |
| `docs/` | research-notes, decisions, extension-API cheat sheet, phase specs, evidence |
| `PROGRESS.md` / `PLAN.md` | phase status and verification records / master plan |
| `taskflow/phase{1,2,3}.json` | pi-taskflow orchestration flows used for build/review |
| `tests/` | `rates.test.ts`, `ds-reconcile.test.mjs`, `ctxmode-pricing.test.ts` (33 tests) |
| `stage/` | context-mode patch payload and pristine fixture |

Run the test suite (Node ≥ 22.18):

```bash
node --test tests/rates.test.ts tests/ds-reconcile.test.mjs tests/ctxmode-pricing.test.ts
```

## Limitations and notes

- **Stateless and config-free.** All values are derived from session entries and event payloads; there is no configuration file.
- **Zero npm dependencies.** The extension runs inside pi via jiti (no build/bundling); only `node:` builtins are used. Keep it dependency-free so jiti can load it directly.
- **Test shorthand is broken.** `node --test tests/` fails (`tests/index.js` is an obsolete shim incompatible with `"type": "module"`); pass the three test files explicitly (33 pass / 0 fail on Node 22.23.1).
- **`pi install` path is declared but not yet live-verified** in this repo's records; only the `install.sh` copy path was verified end-to-end (see `PROGRESS.md`).
- **Holiday table is year-keyed.** A missing year makes every day non-holiday, failing toward peak (conservative) rates. 2027 ranges must be added when the State Council notice lands (expected Nov 2026).
- **Billing instant is client-inferred** from the usage timestamp; window-boundary minutes are ambiguous. `ds-reconcile` is the detector for systematic drift.
- **Compaction charges are excluded from the ledger** (message entries only). Over windows that contain a compaction, `ds-reconcile` drift reads negative by roughly the compaction charge; the charge itself is still time-corrected in pi's transcript.
- **`patch-ctxmode.sh` edits files inside the installed context-mode package** and must be re-run after every context-mode upgrade / `ctx-upgrade` / npm update.
- **Minified context-mode hook bundle is intentionally unpatched** (fragile, no stable anchor); its time-accuracy depends on pi continuing to write `usage.cost.total` (probe: 160/160 rows carried numeric `native_cost_usd`).
- One `PROGRESS.md` item remains open: comparing `ctx_stats` output against the ledger on a live session (Phase 3 final acceptance).
