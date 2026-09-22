#!/usr/bin/env node
// ds-reconcile — DeepSeek balance reconciliation CLI (zero-dep Node ESM).
//
// Polls the DeepSeek balance API (ground truth), appends a sample to
// ~/.pi/deepseek-pricing/balance.jsonl, and compares the balance drop between
// two samples against the sum of `dynamicCost` in ledger.jsonl for the same
// window. The difference is the "drift": negative means our time-aware pricing
// under-billed vs the account, positive means it over-billed.
//
// Facts + formulas: docs/research-notes.md section 7.
//   GET https://api.deepseek.com/user/balance  (Authorization: Bearer <key>)
//   topUp        = max(0, currToppedUp - prevToppedUp)
//   balanceSpend = prevTotal - currTotal + topUp
//   drift        = ledgerWindowSum - balanceSpend
//
// Key source: ~/.pi/agent/auth.json -> deepseek.key. The key is never printed.
//
// Modes:
//   --once                 one sample (default)
//   --daemon               sample immediately, then every --interval minutes
//   --interval <min>       daemon interval in minutes (float ok, default 60)
//   --stop                 SIGTERM the daemon recorded in the pidfile
//   --help                 usage
//
// Daemon pidfile: ~/.pi/deepseek-pricing/ds-reconcile.pid (AGENTS.md pattern).
// SIGTERM/SIGINT remove the pidfile before exit; a live pidfile refuses a
// second start.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".pi", "deepseek-pricing");
const BALANCE_FILE = join(DATA_DIR, "balance.jsonl");
const LEDGER_FILE = join(DATA_DIR, "ledger.jsonl");
const PID_FILE = join(DATA_DIR, "ds-reconcile.pid");
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_INTERVAL_MIN = 60;
const BODY_SNIPPET = 300;

// --- small helpers -----------------------------------------------------------

function fail(message, code = 1) {
  process.stderr.write(`ds-reconcile: ${message}\n`);
  process.exit(code);
}

function snippet(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_SNIPPET);
}

function amount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usd(value) {
  return value.toFixed(6);
}

function iso(ts) {
  return new Date(ts).toISOString();
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// --- key + API ---------------------------------------------------------------

/** Read deepseek.key without ever echoing it. Throws with a clear message. */
function readApiKey() {
  let raw;
  try {
    raw = readFileSync(AUTH_FILE, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${AUTH_FILE} (${err?.code ?? err?.message ?? err}); ` +
        "expected { \"deepseek\": { \"key\": \"...\" } }",
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${AUTH_FILE} is not valid JSON`);
  }

  const key = json?.deepseek?.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      `no DeepSeek API key at ${AUTH_FILE} (expected deepseek.key); ` +
        "add one or re-authenticate",
    );
  }
  return key;
}

/** GET /user/balance and pick the USD entry when several currencies exist. */
async function fetchBalance(key) {
  let res;
  try {
    res = await fetch(BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new Error(`balance request failed: ${err?.message ?? err}`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `balance API ${res.status} ${res.statusText}: ${snippet(text)}`,
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`balance API returned non-JSON: ${snippet(text)}`);
  }

  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) {
    throw new Error(`balance API returned no balance_infos: ${snippet(text)}`);
  }

  const info =
    infos.find(
      (i) => i && String(i.currency).toUpperCase() === "USD",
    ) ?? infos[0];

  return {
    isAvailable: body?.is_available !== false,
    currency: String(info.currency ?? "USD").toUpperCase(),
    totalBalance: amount(info.total_balance),
    grantedBalance: amount(info.granted_balance),
    toppedUpBalance: amount(info.topped_up_balance),
  };
}

// --- balance history ---------------------------------------------------------

/** Last well-formed sample, or null when balance.jsonl is absent/empty. */
function readPreviousSample() {
  let raw;
  try {
    raw = readFileSync(BALANCE_FILE, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      rec &&
      typeof rec.ts === "number" &&
      Number.isFinite(rec.ts) &&
      typeof rec.totalBalance === "number" &&
      typeof rec.grantedBalance === "number" &&
      typeof rec.toppedUpBalance === "number"
    ) {
      return rec;
    }
  }
  return null;
}

function appendSample(sample) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(BALANCE_FILE, `${JSON.stringify(sample)}\n`, "utf8");
  } catch (err) {
    throw new Error(
      `cannot append to ${BALANCE_FILE}: ${err?.message ?? err}`,
    );
  }
}

// --- ledger window -----------------------------------------------------------

/**
 * Sum `dynamicCost` over ledger lines in the half-open window
 * (sinceTs, untilTs]. Exclusive start avoids double-counting a line that sits
 * exactly on a previous sample boundary.
 */
function ledgerWindowSum(sinceTs, untilTs) {
  let raw;
  try {
    raw = readFileSync(LEDGER_FILE, "utf8");
  } catch {
    return { sum: 0, count: 0, present: false };
  }

  let sum = 0;
  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts = rec?.ts;
    const cost = rec?.dynamicCost;
    if (
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      typeof cost !== "number" ||
      !Number.isFinite(cost)
    ) {
      continue;
    }
    if (ts > sinceTs && ts <= untilTs) {
      sum += cost;
      count += 1;
    }
  }
  return { sum, count, present: true };
}

// --- report ------------------------------------------------------------------

function printReport(prev, curr) {
  const out = [];
  out.push(`DeepSeek balance @ ${iso(curr.ts)}`);
  out.push(`  availability: ${curr.isAvailable ? "available" : "UNAVAILABLE"}`);
  out.push(`  currency:     ${curr.currency}`);
  out.push(`  total:        ${usd(curr.totalBalance)}`);
  out.push(`  granted:      ${usd(curr.grantedBalance)}`);
  out.push(`  topped-up:    ${usd(curr.toppedUpBalance)}`);
  out.push("");

  if (!prev) {
    out.push("Spend since previous sample: n/a (first recorded sample)");
    out.push("Ledger window: n/a (no previous sample to bound the window)");
    out.push("drift: n/a");
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  if (prev.currency !== curr.currency) {
    out.push(
      `Spend since previous sample: n/a (currency changed ${prev.currency} -> ${curr.currency})`,
    );
    out.push("Ledger window: n/a (mixed currencies)");
    out.push("drift: n/a");
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  const topUp = Math.max(0, curr.toppedUpBalance - prev.toppedUpBalance);
  const balanceSpend = prev.totalBalance - curr.totalBalance + topUp;
  const window = ledgerWindowSum(prev.ts, curr.ts);
  const drift = window.sum - balanceSpend;

  out.push(
    `Spend since previous sample (${iso(prev.ts)} -> ${iso(curr.ts)}, ts in (prev, curr]):`,
  );
  out.push(
    `  balance spend: ${usd(balanceSpend)} ${curr.currency} (top-up detected: ${usd(topUp)})`,
  );
  out.push(
    `  ledger window sum: ${usd(window.sum)} USD (${window.count} run(s)${window.present ? "" : ", ledger absent"})`,
  );

  // The ledger is USD-only; a non-USD balance cannot be compared meaningfully.
  if (curr.currency !== "USD") {
    out.push(
      `  drift: n/a (balance currency ${curr.currency} is not comparable to the USD ledger)`,
    );
  } else {
    const note =
      drift < 0
        ? "negative: ledger under-billed vs the balance drop"
        : drift > 0
          ? "positive: ledger over-billed vs the balance drop"
          : "zero: ledger matched the balance drop";
    out.push(`  drift: ${usd(drift)} USD (${note})`);
  }

  process.stdout.write(out.join("\n") + "\n");
}

// --- sampling ----------------------------------------------------------------

async function sampleOnce() {
  const key = readApiKey();
  const balance = await fetchBalance(key);
  const prev = readPreviousSample();

  const sample = {
    ts: Date.now(),
    totalBalance: balance.totalBalance,
    grantedBalance: balance.grantedBalance,
    toppedUpBalance: balance.toppedUpBalance,
    currency: balance.currency,
  };
  appendSample(sample);
  printReport(prev, { ...balance, ts: sample.ts });
  return sample;
}

// --- daemon lifecycle --------------------------------------------------------

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the pid exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

function readPidFile() {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile() {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    // best effort
  }
}

/** Write our pid, refusing when a live instance already owns the pidfile. */
function acquirePidFile() {
  mkdirSync(DATA_DIR, { recursive: true });
  const existing = readPidFile();
  if (existing && isAlive(existing)) {
    throw new Error(
      `daemon already running (pid ${existing}); stop it with --stop`,
    );
  }
  removePidFile();
  writeFileSync(PID_FILE, `${process.pid}\n`, "utf8");
}

async function runDaemon(intervalMin) {
  acquirePidFile();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removePidFile();
  };
  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("exit", cleanup);

  process.stdout.write(
    `ds-reconcile daemon: pid ${process.pid}, interval ${intervalMin} min, pidfile ${PID_FILE}\n`,
  );

  const tick = async () => {
    try {
      await sampleOnce();
    } catch (err) {
      process.stderr.write(
        `ds-reconcile: sample failed: ${err?.message ?? err}\n`,
      );
    }
  };

  await tick();
  // A referenced interval keeps the process alive; signal handlers exit cleanly.
  setInterval(() => {
    void tick();
  }, intervalMin * 60_000);
}

function stopDaemon() {
  const pid = readPidFile();
  if (!pid || !isAlive(pid)) {
    removePidFile();
    process.stdout.write("ds-reconcile: not running\n");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new Error(`cannot signal pid ${pid}: ${err?.message ?? err}`);
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isAlive(pid)) sleepSync(100);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  removePidFile();
  process.stdout.write(`ds-reconcile: stopped (pid ${pid})\n`);
}

// --- CLI ---------------------------------------------------------------------

function parseInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    fail(
      `invalid --interval value ${JSON.stringify(value)} (expected a positive number of minutes)`,
      2,
    );
  }
  return n;
}

function parseArgs(argv) {
  const opts = { mode: "once", interval: DEFAULT_INTERVAL_MIN, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") {
      opts.mode = "once";
    } else if (arg === "--daemon") {
      opts.mode = "daemon";
    } else if (arg === "--stop") {
      opts.mode = "stop";
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--interval") {
      const value = argv[++i];
      if (value === undefined) fail("--interval requires a value in minutes", 2);
      opts.interval = parseInterval(value);
    } else if (arg.startsWith("--interval=")) {
      opts.interval = parseInterval(arg.slice("--interval=".length));
    } else {
      fail(`unknown argument: ${arg} (try --help)`, 2);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      "ds-reconcile — reconcile DeepSeek account balance against the local cost ledger",
      "",
      "Usage:",
      "  ds-reconcile [--once]              sample balance once (default)",
      "  ds-reconcile --daemon [--interval <min>]",
      "                                     sample immediately, then every <min> minutes",
      "                                     (float allowed; default 60)",
      "  ds-reconcile --stop                stop the daemon in the pidfile",
      "  ds-reconcile --help                show this help",
      "",
      "Files:",
      `  key:     ${AUTH_FILE} (deepseek.key; never logged)`,
      `  samples: ${BALANCE_FILE}`,
      `  ledger:  ${LEDGER_FILE}`,
      `  pidfile: ${PID_FILE}`,
      "",
      "drift = ledgerWindowSum - balanceSpend; negative means the local estimate",
      "under-billed vs the account, positive means it over-billed.",
    ].join("\n") + "\n",
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.mode === "stop") {
    stopDaemon();
    return;
  }
  if (opts.mode === "daemon") {
    await runDaemon(opts.interval);
    return;
  }
  await sampleOnce();
}

main().catch((err) => {
  process.stderr.write(`ds-reconcile: ${err?.message ?? err}\n`);
  process.exit(1);
});
