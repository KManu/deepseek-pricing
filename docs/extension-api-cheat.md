# Extension API Cheat Sheet (for implementers)

Verified against installed pi 0.87.0 docs (`docs/extensions.md`) and the
session JSONL format. Only the surface this project uses.

## Module shape

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // pi.on("event", handler)
  // pi.registerCommand("name", { description, handler })
}
```

Type-only imports are erased — extension runs with pi's own runtime, no bundling.
Do NOT add npm deps; keep it dependency-free TypeScript.

## Events used

### message_end  (fires for user / assistant / toolResult messages)

Handler may return `{ message }` to replace the finalized message
(must keep the same `role`). Docs example rewrites `usage.cost` — this is what
persists into footer / `/session` / RPC totals:

```ts
pi.on("message_end", async (event, ctx) => {
  const m = event.message;
  if (m.role !== "assistant") return;           // we only touch assistant messages
  if (m.provider !== "deepseek") return;        // provider field on message (JSONL-verified)
  // m.usage = { input, output, cacheRead, cacheWrite, reasoning, totalTokens,
  //             cost: { input, output, cacheRead, cacheWrite, total } }  (may be undefined)
  // m.timestamp: unix ms
  return { message: { ...m, usage: { ...m.usage, cost: recompute(...) } } };
});
```

Guard rails: only act when `m.usage` exists and token fields are numbers.
Never invent usage. Preserve all other fields (spread).

### tool_result (nested-LLM usage inside tool results)

Middleware chain; handler may return partial patch:
`{ content?, details?, isError?, usage? }`. Omitted fields keep current values.
Patch `usage.cost` only when the active model is DeepSeek and `usage` has
token numbers. `ctx.model` gives the active model id (strip provider prefix
before rate lookup).

### agent_settled (notification-only, final boundary)

Fired when pi will not continue automatically. Use it to append the session's
corrected-cost summary to our ledger. `ctx.sessionManager.getEntries()` reads
session entries; PI_SESSION_ID / PI_SESSION_FILE are also exposed to spawned
commands. Do not return anything actionable; it is notification-only.

## Commands

```ts
pi.registerCommand("ds-cost", {
  description: "DeepSeek peak/off-peak cost breakdown for this session",
  async handler(_args, ctx) {
    return { content: "…markdown…" };   // shown in-session
  },
});
```

## Helpers available (if needed)

- `ctx.sessionManager.getEntries()` — active-branch entries.
- `ctx.model` — active model id (e.g. "deepseek/deepseek-v4-pro" or bare id).
- `ctx.isIdle()`, `ctx.waitForIdle()` — control-flow helpers.
- Node builtins are available (`node:fs`, `node:path`).

## Session JSONL facts (what we read for the ledger)

- Message entries: `{ "type":"message", "id", "timestamp" (ms),
  "message": { "role", "content", "provider", "model",
  "usage": { "input","output","cacheRead","cacheWrite","reasoning",
             "totalTokens","cost":{...} }, "stopReason" } }`
- Usage entries (cache warm etc.): `{ "type":"usage", "kind", "provider",
  "model", "usage": {...} }` — DeepSeek never triggers these (no promptCache).
