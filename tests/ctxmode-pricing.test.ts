// Tests for the phase-3 time-aware context-mode pricing module.
// Run with: node --test tests/
// Zero npm deps — node:test + node:assert only. Node >= 22.18 runs .ts natively.
//
// Two modules are exercised:
//   - ../stage/context-mode/build/session/pricing.js
//       the PATCHED module (DeepSeek peak/off-peak by request timestamp).
//   - ../stage/context-mode-pristine/pricing.js
//       a byte-for-byte copy of the UNMODIFIED installed module, kept as the
//       reference for non-DeepSeek models. A test below re-checks that this
//       fixture still matches the live installed file (so it cannot drift).
//
// The JSON catalog is imported with `with { type: "json" }`; Node's module
// syntax detection treats the sibling .js as ESM even without a package.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { computeCostUsd } from "../stage/context-mode/build/session/pricing.js";
import { computeCostUsd as pristineComputeCostUsd } from "../stage/context-mode-pristine/pricing.js";

const at = (iso: string): number => Date.parse(iso);

const closeTo = (actual: number, expected: number, msg?: string): void =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    msg ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );

// --- Fixed instants ----------------------------------------------------------
// 2026-03-02 is a Monday; the peak windows are [01:00,04:00) and [06:00,10:00).
const PEAK = at("2026-03-02T02:00:00Z"); // Monday 02:00Z — peak
const OFF = at("2026-03-07T02:00:00Z"); // Saturday 02:00Z — off all day
const WED_OFF = at("2026-03-04T12:00:00Z"); // Wednesday 12:00Z — off (outside windows)
const HOLIDAY = at("2026-02-16T02:00:00Z"); // Spring Festival Mon 02:00Z — off

const ALL_BUCKETS = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_tokens: 1_000_000,
  cache_creation_tokens: 1_000_000,
};

// --- (1) DeepSeek off-peak is exactly half of peak ---------------------------

test("deepseek-flash off-peak is exactly half of peak for all four buckets", () => {
  const peak = computeCostUsd("deepseek-flash", ALL_BUCKETS, PEAK);
  const off = computeCostUsd("deepseek-flash", ALL_BUCKETS, OFF);
  assert.equal(typeof peak, "number");
  assert.equal(typeof off, "number");
  assert.equal(off! * 2, peak!, "off-peak must be exactly half of peak");
});

test("deepseek-v4-pro off-peak is exactly half of peak for all four buckets", () => {
  const peak = computeCostUsd("deepseek-v4-pro", ALL_BUCKETS, PEAK);
  const off = computeCostUsd("deepseek-v4-pro", ALL_BUCKETS, OFF);
  assert.equal(off! * 2, peak!, "off-peak must be exactly half of peak");
});

// --- (2) Peak window / weekday off / weekend / CN holiday vs static ----------

test("DeepSeek window, weekday-off, weekend and CN holiday vs static", () => {
  const staticCost = computeCostUsd("deepseek-flash", ALL_BUCKETS)!; // no ts = peak
  assert.equal(staticCost, computeCostUsd("deepseek-flash", ALL_BUCKETS, PEAK));

  const offPeak = [
    ["Monday outside window 12:00Z", at("2026-03-02T12:00:00Z")],
    ["Wednesday 12:00Z", WED_OFF],
    ["Saturday 02:00Z", OFF],
    ["CN holiday 2026-02-16 02:00Z", HOLIDAY],
  ] as const;
  for (const [label, ts] of offPeak) {
    closeTo(
      computeCostUsd("deepseek-flash", ALL_BUCKETS, ts)!,
      staticCost / 2,
      `${label} should be half of static peak`,
    );
  }
});

// --- (3) No ts => static peak (backward compatibility) -----------------------

test("missing ts falls back to the static peak row", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
    assert.equal(
      computeCostUsd(model, ALL_BUCKETS),
      computeCostUsd(model, ALL_BUCKETS, PEAK),
      `${model}: no ts must equal the peak row`,
    );
  }
});

// --- (4) Provider prefix + legacy alias resolve to the right tables ----------

test("provider-prefixed and legacy-alias ids resolve correctly", () => {
  // `deepseek/deepseek-v4-pro` must behave exactly like `deepseek-v4-pro`.
  assert.equal(
    computeCostUsd("deepseek/deepseek-v4-pro", ALL_BUCKETS, PEAK),
    computeCostUsd("deepseek-v4-pro", ALL_BUCKETS, PEAK),
  );
  assert.equal(
    computeCostUsd("deepseek/deepseek-v4-pro", ALL_BUCKETS, OFF),
    computeCostUsd("deepseek-v4-pro", ALL_BUCKETS, OFF),
  );

  // Legacy `deepseek-v4-flash` must bill at the Flash table.
  assert.equal(
    computeCostUsd("deepseek-v4-flash", ALL_BUCKETS, PEAK),
    computeCostUsd("deepseek-flash", ALL_BUCKETS, PEAK),
  );
  assert.equal(
    computeCostUsd("deepseek-v4-flash", ALL_BUCKETS, OFF),
    computeCostUsd("deepseek-flash", ALL_BUCKETS, OFF),
  );

  // The pro and flash tables really are different (guards an accidental swap).
  assert.notEqual(
    computeCostUsd("deepseek/deepseek-v4-pro", ALL_BUCKETS, PEAK),
    computeCostUsd("deepseek-v4-flash", ALL_BUCKETS, PEAK),
  );
});

// --- (5) Non-DeepSeek models are byte-identical to the pristine module -------

test("non-DeepSeek model matches pristine installed pricing with and without ts", () => {
  const tokens = {
    input_tokens: 123_456,
    output_tokens: 7_890,
    cache_read_tokens: 456_789,
    cache_creation_tokens: 12_345,
  };
  const baseline = pristineComputeCostUsd("claude-sonnet-4-6", tokens);
  assert.equal(typeof baseline, "number", "sanity: claude-sonnet-4-6 is priced");

  assert.equal(computeCostUsd("claude-sonnet-4-6", tokens), baseline);
  for (const ts of [PEAK, OFF, WED_OFF, HOLIDAY]) {
    assert.equal(
      computeCostUsd("claude-sonnet-4-6", tokens, ts),
      baseline,
      `claude-sonnet-4-6 must ignore ts=${new Date(ts).toISOString()}`,
    );
  }
});

// --- (6) Unknown model / all-zero tokens => null -----------------------------

test("unknown model and all-zero tokens return null", () => {
  const originalWarn = console.warn;
  console.warn = () => {}; // the module warns once per unknown id
  try {
    assert.equal(computeCostUsd("totally-unknown-model", ALL_BUCKETS), null);
    assert.equal(computeCostUsd("totally-unknown-model", ALL_BUCKETS, PEAK), null);
    assert.equal(computeCostUsd("no-such-vendor/no-such-model", ALL_BUCKETS), null);
  } finally {
    console.warn = originalWarn;
  }

  const zeros = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  assert.equal(computeCostUsd("deepseek-flash", zeros), null);
  assert.equal(computeCostUsd("deepseek-flash", zeros, OFF), null);
  assert.equal(computeCostUsd("deepseek-flash", {}), null);
  assert.equal(computeCostUsd("deepseek-flash", {}, PEAK), null);
  assert.equal(computeCostUsd("claude-sonnet-4-6", {}), null);
});

// --- (7) NaN ts behaves like no ts -------------------------------------------

test("NaN ts behaves like an absent ts", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
    assert.equal(
      computeCostUsd(model, ALL_BUCKETS, Number.NaN),
      computeCostUsd(model, ALL_BUCKETS),
      `${model}: NaN ts must equal the static peak row`,
    );
  }
});

// --- Pristine fixture integrity ---------------------------------------------

const INSTALLED_DIR = join(
  homedir(),
  ".pi/agent/npm/node_modules/context-mode/build/session",
);
const installedPresent =
  existsSync(join(INSTALLED_DIR, "pricing.js")) &&
  existsSync(join(INSTALLED_DIR, "model-prices.json"));

/**
 * Newest phase-3 pre-patch backup in the installed session dir, or null.
 * scripts/patch-ctxmode.sh writes pricing.js.pre-ds-pricing.<epoch>.bak
 * immediately before overwriting the installed module, so once the patch has
 * been applied this backup — not the patched live file — is the unmodified
 * reference the pristine fixture must match.
 */
function newestInstalledBackup(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; epoch: number } | null = null;
  for (const name of names) {
    const match = /^pricing\.js\.pre-ds-pricing\.(\d+)\.bak$/.exec(name);
    if (!match) continue;
    const epoch = Number(match[1]);
    if (!best || epoch > best.epoch) best = { path: join(dir, name), epoch };
  }
  return best ? best.path : null;
}

test(
  "pristine fixture matches the unmodified (pre-patch) installed module",
  {
    skip: installedPresent
      ? false
      : `installed context-mode not found under ${INSTALLED_DIR}`,
  },
  () => {
    const fixtureDir = new URL("../stage/context-mode-pristine/", import.meta.url);
    const backup = newestInstalledBackup(INSTALLED_DIR);
    for (const file of ["pricing.js", "model-prices.json"]) {
      // pricing.js: compare against the newest pre-patch backup once the patch
      // has been applied, otherwise against the still-unmodified installed file.
      // model-prices.json is never patched, so it always compares to installed.
      const referencePath =
        file === "pricing.js" && backup ? backup : join(INSTALLED_DIR, file);
      const reference = readFileSync(referencePath);
      const fixture = readFileSync(new URL(file, fixtureDir));
      assert.ok(
        reference.equals(fixture),
        `stage/context-mode-pristine/${file} differs from ${
          file === "pricing.js" && backup ? backup : "the installed file"
        }`,
      );
    }
  },
);
