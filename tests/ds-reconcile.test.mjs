// Tests for ds-reconcile's incremental ledger-window reconciliation.
// Run with: node --test tests/
// Zero npm deps — node:test + node:assert only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the CLI's data dir at a fixture BEFORE importing it (its DATA_DIR is
// evaluated at module load).
const dir = mkdtempSync(join(tmpdir(), "ds-rw-"));
process.env.DS_PRICING_DIR = dir;
const { ledgerWindowSum } = await import("../scripts/ds-reconcile.mjs");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LEDGER = join(dir, "ledger.jsonl");

function fixture(lines) {
  writeFileSync(LEDGER, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

// Fixture sessions (see incrementalFor docstring for the rules):
//   A: cumulative branch, compaction reset, then a same-branch clamp
//   B: legacy line (no firstTs)
//   C: first line, branch fully inside window
//   D: first line, branch starts before window (partial coverage)
//   E: line preceded only by a legacy line
//   F: window-edge lines (ts exactly on sinceTs / untilTs)
const LINES = [
  { ts: 100, sessionId: "A", firstTs: 90, dynamicCost: 1.0 },
  { ts: 200, sessionId: "A", firstTs: 90, dynamicCost: 1.5 },
  { ts: 300, sessionId: "A", firstTs: 250, dynamicCost: 0.2 },
  { ts: 380, sessionId: "A", firstTs: 250, dynamicCost: 0.15 },
  { ts: 250, sessionId: "B", dynamicCost: 5 },
  { ts: 350, sessionId: "C", firstTs: 320, dynamicCost: 0.1 },
  { ts: 350, sessionId: "D", firstTs: 100, dynamicCost: 0.7 },
  { ts: 100, sessionId: "E", dynamicCost: 3 },
  { ts: 350, sessionId: "E", firstTs: 90, dynamicCost: 4 },
  { ts: 150, sessionId: "F", firstTs: 90, dynamicCost: 2.5 },
  { ts: 400, sessionId: "F", firstTs: 90, dynamicCost: 3 },
];

test("incremental window: deltas, compaction resets, exclusions, edges", () => {
  fixture(LINES);
  const w = ledgerWindowSum(150, 400);
  assert.equal(w.present, true);
  // A: 0.5 (delta) + 0.2 (compaction reset) + 0 (clamped 0.15-0.2) = 0.7
  // C: 0.1 (first line, fully in window) + F: 0.5 (edge at untilTs) = 1.3
  assert.equal(w.count, 5);
  assert.ok(Math.abs(w.sum - 1.3) < 1e-9, `sum ${w.sum}`);
  // B (legacy), D (partial coverage), E (legacy-preceded) excluded.
  assert.equal(w.excluded, 3);
});

test("same-branch delta never counts negative usage", () => {
  fixture(LINES);
  // Window containing only A's compaction-reset branch lines plus C/D/E@350.
  const w = ledgerWindowSum(250, 390);
  // A l3: new branch -> 0.2; A l4: same branch, cost dropped -> clamped 0;
  // C l1: first line fully in window -> 0.1. D (partial) and E (legacy-prev) excluded.
  assert.equal(w.count, 3);
  assert.equal(w.excluded, 2);
  assert.ok(Math.abs(w.sum - 0.3) < 1e-9, `sum ${w.sum}`);
});

test("first line of a session is fully counted when its branch starts in-window", () => {
  fixture(LINES);
  const w = ledgerWindowSum(0, 150);
  // A l1: firstTs 90 > 0 -> full 1.0. F l1: ts == untilTs -> included, full 2.5.
  // E l1: legacy -> excluded.
  assert.equal(w.count, 2);
  assert.equal(w.excluded, 1);
  assert.ok(Math.abs(w.sum - 3.5) < 1e-9, `sum ${w.sum}`);
});

test("absent ledger reports present=false and zero sum", () => {
  rmSync(LEDGER, { force: true });
  const w = ledgerWindowSum(0, 1000);
  assert.equal(w.present, false);
  assert.equal(w.sum, 0);
  assert.equal(w.count, 0);
});

test("malformed and non-numeric lines are ignored", () => {
  writeFileSync(
    LEDGER,
    "not json\n{\"ts\":\"bad\"}\n{\"ts\":200,\"dynamicCost\":\"x\"}\n{\"ts\":210,\"sessionId\":\"A\",\"firstTs\":90,\"dynamicCost\":0.25}\n",
    "utf8",
  );
  const w = ledgerWindowSum(0, 300);
  assert.equal(w.present, true);
  assert.equal(w.count, 1);
  assert.ok(Math.abs(w.sum - 0.25) < 1e-9, `sum ${w.sum}`);
  assert.equal(w.excluded, 0);
});
