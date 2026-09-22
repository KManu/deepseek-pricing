// Compat shim for `node --test tests/`.
//
// Node >= 22.2x no longer expands a bare directory argument for the test
// runner (the glob `tests/` resolves to the directory itself, which is then
// loaded as a module and fails). This file lets the spec's exact command work
// while `tests/rates.test.ts` stays the single real test suite. It is not a
// test file, so `node --test` auto-discovery does not double-run anything.
require("./rates.test.ts");
