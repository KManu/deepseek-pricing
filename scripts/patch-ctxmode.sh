#!/usr/bin/env bash
#
# patch-ctxmode.sh — install the phase-3 time-aware DeepSeek pricing patch into
# the *installed* context-mode package (see docs/phase-specs/phase-3.md).
#
# context-mode ships a static per-model price catalog. For the two time-aware
# DeepSeek billing keys the effective rate depends on the request wall-clock
# (peak / off-peak). The staged module in this repo duplicates the tiny pure-UTC
# engine inline; this script copies it over the installed module. The staged
# catalog ships the DeepSeek rows the patched module resolves through
# (model-prices.json); those rows are merged into the installed catalog
# ADD-ONLY — existing rows (upstream values included) are never overwritten or
# removed, so catalog refreshes in newer context-mode releases survive. Every
# context-mode upgrade (or `ctx-upgrade`) wipes the patch — re-run this script.
#
# Usage: scripts/patch-ctxmode.sh [apply|check|verify]
#
#   apply   (default) deploy the staged pricing.js and the staged catalog rows.
#           Every file that gets replaced is backed up first (only when it
#           differs) as <file>.pre-ds-pricing.<epoch>.bak, and the installed
#           context-mode package version is printed. When both components are
#           already up to date the script is a no-op and prints
#           "ALREADY PATCHED" with exit 1 — this is the documented idempotence
#           convention, so callers MUST inspect the exit code rather than
#           treating non-zero as an outright failure.
#           Exit 0 = at least one fresh deployment was made.
#
#   check   No writes. Prints the installed package version and per-component
#           status, then:
#             "PATCHED"     + exit 0 when BOTH components are up to date
#             "NOT PATCHED" + exit 1 when either component differs
#
#   verify  check + a live smoke test: imports the installed module and asserts
#           computeCostUsd('deepseek-flash', { input_tokens: 1_000_000 },
#           2026-03-04T12:00:00Z) === 0.15 (off-peak = exactly half the 0.30
#           peak input rate). Prints "VERIFY-OK" on success, otherwise a
#           "VERIFY-FAIL:" line and a non-zero exit.
#
# Zero dependencies beyond node + coreutils (sha256sum, cp, date, awk).
# Override the installed package directory for testing with CTXMODE_DIR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGED="$REPO_ROOT/stage/context-mode/build/session/pricing.js"
STAGED_CATALOG="$REPO_ROOT/stage/context-mode/build/session/model-prices.json"

CTXMODE_DIR="${CTXMODE_DIR:-$HOME/.pi/agent/npm/node_modules/context-mode}"
INSTALLED="$CTXMODE_DIR/build/session/pricing.js"
INSTALLED_CATALOG="$CTXMODE_DIR/build/session/model-prices.json"
PKG_JSON="$CTXMODE_DIR/package.json"

MODE="${1:-apply}"

die() { printf 'patch-ctxmode: %s\n' "$*" >&2; exit 1; }

sha() { sha256sum "$1" | awk '{print $1}'; }

package_version() {
    if [ -f "$PKG_JSON" ]; then
        # process.argv[1] avoids shell-quoting the path inside the expression.
        node -p 'require(process.argv[1]).version' "$PKG_JSON" 2>/dev/null \
            || printf 'unknown\n'
    else
        printf 'unknown\n'
    fi
}

# --- catalog merge -----------------------------------------------------------
# The patched pricing.js resolves DeepSeek ids through the curated catalog, so
# the staged DeepSeek rows must exist in the installed model-prices.json.
# Add-only: staged rows missing from installed are appended; existing rows are
# never touched (upstream price refreshes in newer context-mode releases win).

catalog_missing_count() { # → number of staged keys absent from the installed catalog
    node -e 'const fs = require("fs");
const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const staged = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let missing = 0;
for (const k of Object.keys(staged)) if (!(k in inst)) missing++;
console.log(missing);' "$INSTALLED_CATALOG" "$STAGED_CATALOG"
}

catalog_deploy() { # → merged catalog written in place; prints rows added
    node -e 'const fs = require("fs");
const inst = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const staged = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let added = 0;
for (const k of Object.keys(staged)) {
    if (!(k in inst)) { inst[k] = staged[k]; added++; }
}
fs.writeFileSync(process.argv[3], JSON.stringify(inst, null, 2) + "\n");
console.log(added);' "$INSTALLED_CATALOG" "$STAGED_CATALOG" "$INSTALLED_CATALOG"
}

# The live smoke: the installed module must bill the 2026-03-04 12:00Z instant
# (Wednesday, outside the peak windows) at the off-peak input rate of $0.15/Mtok.
run_smoke() {
    local smoke_out
    local smoke_js
    smoke_js='import { pathToFileURL } from "node:url";
const { computeCostUsd } = await import(pathToFileURL(process.argv[1]).href);
const ts = new Date("2026-03-04T12:00:00Z").getTime();
const got = computeCostUsd("deepseek-flash", { input_tokens: 1000000 }, ts);
if (got !== 0.15) {
    console.error("VERIFY-FAIL: computeCostUsd returned " + got + ", expected 0.15");
    process.exit(2);
}
console.log("VERIFY-OK");'
    if smoke_out="$(node --input-type=module -e "$smoke_js" "$INSTALLED" 2>&1)"; then
        printf '%s\n' "$smoke_out"
    else
        printf '%s\n' "${smoke_out:-VERIFY-FAIL: node smoke test exited non-zero}" >&2
        exit 1
    fi
}

[ -f "$STAGED" ] || die "staged pricing.js not found: $STAGED"
[ -f "$INSTALLED" ] || die "installed pricing.js not found: $INSTALLED"
[ -f "$STAGED_CATALOG" ] || die "staged model-prices.json not found: $STAGED_CATALOG"
[ -f "$INSTALLED_CATALOG" ] || die "installed model-prices.json not found: $INSTALLED_CATALOG"

STAGED_SHA="$(sha "$STAGED")"
INSTALLED_SHA="$(sha "$INSTALLED")"

case "$MODE" in
    apply)
        printf 'context-mode version: %s\n' "$(package_version)"
        DEPLOYED=0
        printf 'staged pricing.js    sha256 %s\n' "$STAGED_SHA"
        printf 'installed pricing.js sha256 %s\n' "$INSTALLED_SHA"
        if [ "$STAGED_SHA" = "$INSTALLED_SHA" ]; then
            printf 'pricing.js: already patched\n'
        else
            # Always back up the live file before overwriting it. "Modified by
            # someone else since our last backup" just means this backup
            # captures that other edit — it is never skipped.
            BACKUP="$INSTALLED.pre-ds-pricing.$(date +%s).bak"
            cp -p "$INSTALLED" "$BACKUP"
            printf 'pricing.js: backup %s\n' "$BACKUP"
            cp "$STAGED" "$INSTALLED"
            printf 'pricing.js: patched\n'
            DEPLOYED=1
        fi
        CAT_MISSING="$(catalog_missing_count)"
        if [ "$CAT_MISSING" = "0" ]; then
            printf 'model-prices.json: all staged rows present\n'
        else
            BACKUP="$INSTALLED_CATALOG.pre-ds-pricing.$(date +%s).bak"
            cp -p "$INSTALLED_CATALOG" "$BACKUP"
            printf 'model-prices.json: %s staged row(s) missing, backup %s\n' "$CAT_MISSING" "$BACKUP"
            printf 'model-prices.json: added %s row(s)\n' "$(catalog_deploy)"
            DEPLOYED=1
        fi
        if [ "$DEPLOYED" = "0" ]; then
            printf 'ALREADY PATCHED\n'
            exit 1
        fi
        printf 'PATCHED\n'
        ;;

    check)
        printf 'context-mode version: %s\n' "$(package_version)"
        printf 'staged pricing.js    sha256 %s\n' "$STAGED_SHA"
        printf 'installed pricing.js sha256 %s\n' "$INSTALLED_SHA"
        OK=1
        if [ "$STAGED_SHA" = "$INSTALLED_SHA" ]; then
            printf 'pricing.js: PATCHED\n'
        else
            printf 'pricing.js: NOT PATCHED\n'
            OK=0
        fi
        CAT_MISSING="$(catalog_missing_count)"
        if [ "$CAT_MISSING" = "0" ]; then
            printf 'model-prices.json: PATCHED (all staged rows present)\n'
        else
            printf 'model-prices.json: NOT PATCHED (%s staged row(s) missing)\n' "$CAT_MISSING"
            OK=0
        fi
        if [ "$OK" = "1" ]; then
            printf 'PATCHED\n'
            exit 0
        fi
        printf 'NOT PATCHED\n'
        exit 1
        ;;

    verify)
        printf 'context-mode version: %s\n' "$(package_version)"
        printf 'staged pricing.js    sha256 %s\n' "$STAGED_SHA"
        printf 'installed pricing.js sha256 %s\n' "$INSTALLED_SHA"
        if [ "$STAGED_SHA" != "$INSTALLED_SHA" ]; then
            printf 'pricing.js: NOT PATCHED\n'
            printf 'NOT PATCHED\n'
            exit 1
        fi
        CAT_MISSING="$(catalog_missing_count)"
        if [ "$CAT_MISSING" != "0" ]; then
            printf 'model-prices.json: NOT PATCHED (%s staged row(s) missing)\n' "$CAT_MISSING"
            printf 'NOT PATCHED\n'
            exit 1
        fi
        printf 'PATCHED\n'
        run_smoke
        ;;

    -h|--help|help)
        printf 'usage: %s [apply|check|verify]\n' "$(basename "$0")"
        printf '  apply (default)  deploy staged pricing.js + staged catalog rows (idempotent)\n'
        printf '  check            report PATCHED/NOT PATCHED per component, no writes\n'
        printf '  verify           check + live computeCostUsd smoke test\n'
        ;;

    *)
        die "unknown mode '$MODE' (expected apply|check|verify)"
        ;;
esac
