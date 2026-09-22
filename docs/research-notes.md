# Research Notes — DeepSeek Peak/Off-Peak Pricing

Source: https://api-docs.deepseek.com/quick_start/pricing (fetched 2026-09-22).
Official 2026 CN holidays: State Council notice, Nov 4 2025
(https://www.gov.cn/yaowen/liebiao/202511/content_7047099.htm, mirrored at
china-briefing.com/news/china-2026-public-holiday-schedule/).

## 1. The pricing scheme

Per 1M tokens. Two models, one endpoint each:

| Model (API name) | Version | Peak in (cache miss) | Peak out | Peak cache hit | Off-peak = half of peak |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | $0.30 | $1.20 | $0.006 | 0.15 / 0.60 / 0.003 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | $1.32 | $3.96 | $0.044 | 0.66 / 1.98 / 0.022 |

- Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still
  accepted; requests are served by V4.1-Flash and **billed at Flash price**.
- Cache write: $0 (no separate write rate on the page).
- Context 1M; max output 384K (both).
- Vision: flash yes, pro no. (irrelevant to pricing code)

**Peak hours:** "01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
excluding Chinese public holidays. All other hours are off-peak, including
weekends and Chinese public holidays in full."

## 2. The UTC simplification (proved)

Peak windows are [01:00,04:00) and [06:00,10:00) UTC. Beijing = UTC+8, so those
windows are 09:00–12:00 and 14:00–18:00 Beijing. Therefore for every hour that
can possibly be peak:

- the Beijing **date** equals the UTC **date** (window starts ≥ 09:00 Beijing), and
- the Beijing **weekday** equals the UTC **weekday**.

⇒ `isPeak(utcMs)` can be evaluated entirely in UTC:

```
d = new Date(utcMs)
if holiday(d)              → false   (date-range check, UTC date)
if d.getUTCDay() ∈ {0,6}   → false   (weekend)
h = d.getUTCHours()
return (1 ≤ h < 4) || (6 ≤ h < 10)
```

Make-up working days (e.g. 2026-02-14 Sat, 2026-10-10 Sat) are always Sat/Sun
in the official calendar → already excluded by the weekday rule. No special
casing needed. (Officially published make-up days for 2026: Jan 4, Feb 14,
Feb 28, May 9, Sep 20, Oct 10 — all weekends.)

## 3. Official 2026 holiday rest-day ranges (inclusive dates, China calendar)

- New Year: 2026-01-01 … 2026-01-03
- Spring Festival: 2026-02-15 … 2026-02-23
- Qingming: 2026-04-04 … 2026-04-06
- Labour Day: 2026-05-01 … 2026-05-05
- Dragon Boat: 2026-06-19 … 2026-06-21
- Mid-Autumn: 2026-09-25 … 2026-09-27
- National Day: 2026-10-01 … 2026-10-07

Whole rest-day ranges are treated as holidays (all-day off-peak) — matches
"Chinese public holidays in full" wording. 2027 range must be added when the
State Council notice lands (expected Nov 2026). This machine's session history
starts 2026-07-27, so 2026 coverage suffices for back-calculation.

## 4. pi facts (verified in installed pi 0.87.0 docs + dist)

- **No native time-based pricing.** `grep -ri "off-peak|peak hour|time-of-day"`
  over all docs: 0 hits. `grep -c "offPeak|peakHour"` over the dist bundle: 0.
  The only alternate-rate mechanism is `cost.tiers[]` keyed on
  `inputTokensAbove` (input-volume thresholds) — cannot express time windows.
- **Static cost shape**: `cost: { input, output, cacheRead, cacheWrite }`,
  per-M tokens. Built-in deepseek catalog uses PEAK rates (flash .3/1.2/.006;
  pro 1.32/3.96/.044) — matches pricing page peak. These stay as the
  conservative fallback baseline; we correct on top.
- **`message_end` (extension event)** fires for user/assistant/toolResult
  messages; a handler may return `{ message }` to replace the finalized
  message, and the official docs example rewrites
  `usage.cost.total` — i.e. patched cost persists into session totals
  (footer, `/session`, RPC). This is the core mechanism. Requires the same
  `role` in the replacement.
- **`tool_result` (extension event)** handlers chain as middleware and may
  return partial patches `{ content, details, isError, usage }` — nested-LLM
  usage is patchable.
- **Cache warming is n/a for DeepSeek**: pi warms only models with a
  `promptCache` lifetime; the built-in catalog fills lifetimes for direct
  Anthropic only. DeepSeek models have none → no cache_warm usage entries.
- **Compaction summaries**: `session_before_compact` may supply custom
  `usage`; `session_compact` exposes `event.compactionEntry` (the saved
  compaction) but docs show no patch return for it. Default pi-generated
  summaries keep pi's static (peak) cost. Decision deferred to phase 2
  (accept small overestimate or patch if empirically supported).
- **Usage entry shape** (session JSONL, message entries):
  `usage: { input, output, cacheRead, cacheWrite, reasoning, totalTokens,
  cost: { input, output, cacheRead, cacheWrite, total } }` (tokens; cost USD).
  Message entries carry `provider` and `model` (e.g. provider "deepseek",
  model "deepseek-v4-pro") plus `timestamp` (unix ms).
- **Extension discovery**: `~/.pi/agent/extensions/*.ts` (global) and
  `~/.pi/agent/extensions/*/index.ts` (subdir). Import style:
  `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
  `export default function (pi: ExtensionAPI) { ... }`.
  Sessions expose `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
  `PI_MODEL` to spawned commands.

## 5. context-mode facts (for phase 3)

- `build/session/pricing.js`: `lookupPrice(modelId)` → Price|null, exact →
  normalized → provider-stripped; `computeCostUsd(modelId, tokens)` (no
  timestamp param today); `nativeOrComputed(id, t, native)`.
- `build/session/model-prices.json`: keys are bare model ids
  (`deepseek-flash`, `deepseek-v4-pro`, legacy alias `deepseek-v4-flash` —
  already present, peak rates, source URL set).
- The hook bundle `hooks/session-extract.bundle.mjs` has the catalog **inlined**
  — both files must be patched together for phase 3, and re-patched after
  every context-mode upgrade (same class of caveat as the pi-shazam fix).

## 6. Ground truth for reconciliation

- `GET https://api.deepseek.com/user/balance` with the DeepSeek API key
  (`~/.pi/agent/auth.json` → `deepseek.key`) returns granted/topped-up/total
  balance. Per-request prices are NOT returned by the API — billing-instant is
  client-inferred (we use the usage entry timestamp; see decisions.md).

## 7. DeepSeek balance API (for ds-reconcile)

- `GET https://api.deepseek.com/user/balance` — `Authorization: Bearer <key>`.
- Response shape:
  `{ "is_available": true, "balance_infos": [ { "currency": "CNY"|"USD",
  "total_balance": "...", "granted_balance": "...", "topped_up_balance": "..." } ] }`
  (numbers are strings; there may be several currency entries — prefer USD).
- Billing deducts from granted balance first, then topped-up.
- Top-up detection between samples: `topUp = max(0, currToppedUp - prevToppedUp)`;
  `balanceSpend = prevTotal - currTotal + topUp`; `drift = ledgerWindowSum - balanceSpend`.
- Key source: `~/.pi/agent/auth.json` → `deepseek.key` (file mode 0600; never log it).
