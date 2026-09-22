// Tests for the pure rate engine. Run with: node --test tests/
// Zero npm deps — node:test + node:assert only. Node >= 22.18 runs .ts natively.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PEAK_RATES,
  OFFPEAK_RATES,
  normalizeModelId,
  isHoliday,
  isPeak,
  rateFor,
  computeCost,
} from "../rates.ts";

const at = (iso: string): number => Date.parse(iso);
const closeTo = (actual: number, expected: number, msg?: string): void =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    msg ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );

// --- isPeak: window boundaries on a normal Monday (2026-03-02) ---------------

test("isPeak boundaries on Monday 2026-03-02", () => {
  assert.equal(isPeak(at("2026-03-02T00:59:00Z")), false, "00:59 off");
  assert.equal(isPeak(at("2026-03-02T01:00:00Z")), true, "01:00 peak");
  assert.equal(isPeak(at("2026-03-02T03:59:00Z")), true, "03:59 peak");
  assert.equal(isPeak(at("2026-03-02T04:00:00Z")), false, "04:00 off");
  assert.equal(isPeak(at("2026-03-02T05:59:00Z")), false, "05:59 off");
  assert.equal(isPeak(at("2026-03-02T06:00:00Z")), true, "06:00 peak");
  assert.equal(isPeak(at("2026-03-02T09:59:00Z")), true, "09:59 peak");
  assert.equal(isPeak(at("2026-03-02T10:00:00Z")), false, "10:00 off");
});

// --- isPeak: weekends are off all day ----------------------------------------

test("weekends are off all day", () => {
  assert.equal(isPeak(at("2026-03-07T02:00:00Z")), false, "Saturday 02:00 off");
  assert.equal(isPeak(at("2026-03-08T07:00:00Z")), false, "Sunday 07:00 off");
});

// --- isPeak / isHoliday: public holidays are off all day ---------------------

test("CN public holidays are off all day", () => {
  assert.equal(isHoliday(at("2026-02-16T02:00:00Z")), true, "Spring Festival day");
  assert.equal(isPeak(at("2026-02-16T02:00:00Z")), false, "Mon Spring Festival 02:00 off");

  assert.equal(isHoliday(at("2026-01-02T07:30:00Z")), true, "New Year rest day");
  assert.equal(isPeak(at("2026-01-02T07:30:00Z")), false, "Fri New Year 07:30 off");

  assert.equal(isHoliday(at("2026-10-05T06:15:00Z")), true, "National Day rest day");
  assert.equal(isPeak(at("2026-10-05T06:15:00Z")), false, "Mon National Day 06:15 off");
});

test("holiday range edges are inclusive", () => {
  assert.equal(isHoliday(at("2026-02-15T12:00:00Z")), true, "first day in range");
  assert.equal(isHoliday(at("2026-02-23T12:00:00Z")), true, "last day in range");
  assert.equal(isHoliday(at("2026-02-24T12:00:00Z")), false, "day after range");
});

test("non-holiday weekdays behave normally", () => {
  assert.equal(isHoliday(at("2026-03-02T02:00:00Z")), false);
});

// --- Make-up working day is still a weekend for the UTC weekday rule ---------

test("make-up working day 2026-02-14 (Sat) 02:00 is off", () => {
  assert.equal(isPeak(at("2026-02-14T02:00:00Z")), false);
});

// --- Normal Friday peak ------------------------------------------------------

test("normal Friday 2026-03-06 08:00 is peak", () => {
  assert.equal(isPeak(at("2026-03-06T08:00:00Z")), true);
});

// --- rateFor: peak vs off-peak (same clock hour, different days) -------------

test("rateFor returns peak vs off-peak cards", () => {
  const peak = at("2026-03-02T02:00:00Z"); // Monday
  const off = at("2026-03-07T02:00:00Z"); // Saturday, same hour

  assert.deepEqual(rateFor("deepseek-flash", peak), PEAK_RATES["deepseek-flash"]);
  assert.deepEqual(rateFor("deepseek-flash", off), OFFPEAK_RATES["deepseek-flash"]);
  assert.deepEqual(rateFor("deepseek-v4-pro", peak), PEAK_RATES["deepseek-v4-pro"]);
  assert.deepEqual(rateFor("deepseek-v4-pro", off), OFFPEAK_RATES["deepseek-v4-pro"]);
});

// --- normalizeModelId / legacy aliases / provider prefix ---------------------

test("normalizeModelId maps aliases and provider prefixes", () => {
  assert.equal(normalizeModelId("deepseek-flash"), "deepseek-flash");
  assert.equal(normalizeModelId("DeepSeek-Flash"), "deepseek-flash");
  assert.equal(normalizeModelId("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeModelId("deepseek-v4-flash"), "deepseek-flash");
  assert.equal(normalizeModelId("deepseek-v4-flash-vision-exp"), "deepseek-flash");
  assert.equal(normalizeModelId("deepseek/deepseek-flash"), "deepseek-flash");
  assert.equal(normalizeModelId("deepseek/deepseek-v4-flash-vision-exp"), "deepseek-flash");
});

test("rateFor honors legacy aliases and prefixed ids", () => {
  const peak = at("2026-03-02T02:00:00Z");
  assert.deepEqual(rateFor("deepseek-v4-flash", peak), PEAK_RATES["deepseek-flash"]);
  assert.deepEqual(
    rateFor("deepseek-v4-flash-vision-exp", peak),
    PEAK_RATES["deepseek-flash"],
  );
  assert.deepEqual(rateFor("deepseek/deepseek-flash", peak), PEAK_RATES["deepseek-flash"]);
});

test("unknown / non-deepseek models return null", () => {
  const peak = at("2026-03-02T02:00:00Z");
  assert.equal(normalizeModelId("gpt-4o"), null);
  assert.equal(normalizeModelId("openai/gpt-4o"), null);
  assert.equal(normalizeModelId("constructor"), null, "prototype keys rejected");
  // A DeepSeek-family id passes normalization but has no rate card.
  assert.equal(normalizeModelId("deepseek-unknown"), "deepseek-unknown");
  assert.equal(rateFor("gpt-4o", peak), null);
  assert.equal(rateFor("anthropic/claude-sonnet-4", peak), null);
  assert.equal(rateFor("deepseek-unknown", peak), null);
});

// --- computeCost math --------------------------------------------------------

test("computeCost: 1M tokens of each bucket, peak vs off-peak", () => {
  const peak = at("2026-03-02T02:00:00Z");
  const off = at("2026-03-07T02:00:00Z");
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

  const flashPeak = computeCost("deepseek-flash", usage, peak)!;
  assert.equal(flashPeak.input, 0.3);
  assert.equal(flashPeak.output, 1.2);
  closeTo(flashPeak.cacheRead, 0.006);
  assert.equal(flashPeak.cacheWrite, 0);
  closeTo(flashPeak.total, 1.506);

  const flashOff = computeCost("deepseek-flash", usage, off)!;
  assert.equal(flashOff.input, 0.15);
  assert.equal(flashOff.output, 0.6);
  closeTo(flashOff.cacheRead, 0.003);
  assert.equal(flashOff.cacheWrite, 0);
  closeTo(flashOff.total, 0.753);

  const proPeak = computeCost("deepseek-v4-pro", usage, peak)!;
  assert.equal(proPeak.input, 1.32);
  assert.equal(proPeak.output, 3.96);
  closeTo(proPeak.cacheRead, 0.044);
  assert.equal(proPeak.cacheWrite, 0);
  closeTo(proPeak.total, 5.324);

  const proOff = computeCost("deepseek-v4-pro", usage, off)!;
  assert.equal(proOff.input, 0.66);
  assert.equal(proOff.output, 1.98);
  closeTo(proOff.cacheRead, 0.022);
  assert.equal(proOff.cacheWrite, 0);
  closeTo(proOff.total, 2.662);
});

test("computeCost: missing buckets count as 0", () => {
  const peak = at("2026-03-02T02:00:00Z");
  const cost = computeCost("deepseek-flash", { input: 1_000_000 }, peak)!;
  assert.equal(cost.input, 0.3);
  assert.equal(cost.output, 0);
  assert.equal(cost.cacheRead, 0);
  assert.equal(cost.cacheWrite, 0);
  assert.equal(cost.total, 0.3);

  const empty = computeCost("deepseek-v4-pro", {}, peak)!;
  assert.deepEqual(empty, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("computeCost: unknown model returns null", () => {
  const peak = at("2026-03-02T02:00:00Z");
  assert.equal(computeCost("gpt-4o", { input: 1_000_000 }, peak), null);
  assert.equal(computeCost("deepseek-unknown", { input: 1_000_000 }, peak), null);
});

test("computeCost: total equals sum of the four buckets", () => {
  const peak = at("2026-03-02T02:00:00Z");
  const usage = { input: 123_456, output: 7_890, cacheRead: 456_789, cacheWrite: 0 };
  const cost = computeCost("deepseek-v4-pro", usage, peak)!;
  closeTo(
    cost.total,
    cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
  );
});

// --- Sanity invariants -------------------------------------------------------

test("off-peak is exactly half of peak for every bucket/model", () => {
  for (const model of Object.keys(PEAK_RATES)) {
    const peak = PEAK_RATES[model];
    const off = OFFPEAK_RATES[model];
    for (const bucket of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      closeTo(off[bucket], peak[bucket] / 2, `${model}.${bucket}`);
    }
  }
});
