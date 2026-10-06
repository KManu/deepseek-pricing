# Pristine context-mode pricing fixture

This directory is a **byte-for-byte copy** of context-mode's *unmodified*:

- `~/.pi/agent/npm/node_modules/context-mode/build/session/pricing.js`
- `~/.pi/agent/npm/node_modules/context-mode/build/session/model-prices.json`

It is imported by `tests/ctxmode-pricing.test.ts` as the reference for
non-DeepSeek models (case 5): the patched module in
`stage/context-mode/build/session/pricing.js` must return numerically identical
results for those models. A test also re-diffs both files against the installed
copies (content-equal, line endings normalized), so **do not edit the files
here** — an intentional refresh means re-copying them from the installed module
(after a context-mode upgrade).
