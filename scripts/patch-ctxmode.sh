#!/usr/bin/env bash
#
# patch-ctxmode.sh — install the phase-3 time-aware DeepSeek pricing patch into
# the *installed* context-mode package (see docs/phase-specs/phase-3.md).
#
# context-mode ships a static per-model price catalog. For the two time-aware
# DeepSeek billing keys the effective rate depends on the request wall-clock
# (peak / off-peak). The staged module in this repo duplicates the tiny pure-UTC
# engine inline; this script copies it over the installed module. Every
# context-mode upgrade (or `ctx-upgrade`) wipes the patch — re-run this script.
#
# Usage: scripts/patch-ctxmode.sh [apply|check|verify]
#
#   apply   (default) copy the staged pricing.js over the installed one. The
#           previous installed file is backed up first (only when it differs
#           from staged) as
#             <installed>.pre-ds-pricing.<epoch>.bak
#           and the installed context-mode package version is printed. If the
#           installed file already hashes identically to staged the script is a
#           no-op and prints "ALREADY PATCHED" with exit 1 — this is the
#           documented idempotence convention, so callers MUST inspect the exit
#           code rather than treating non-zero as an outright failure.
#           Exit 0 = a fresh patch was applied.
#
#   check   No writes. Prints the installed package version and:
#             "PATCHED"     + exit 0 when installed sha256 == staged sha256
#             "NOT PATCHED" + exit 1 when they differ
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

CTXMODE_DIR="${CTXMODE_DIR:-$HOME/.pi/agent/npm/node_modules/context-mode}"
INSTALLED="$CTXMODE_DIR/build/session/pricing.js"
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

STAGED_SHA="$(sha "$STAGED")"
INSTALLED_SHA="$(sha "$INSTALLED")"

case "$MODE" in
    apply)
        printf 'context-mode version: %s\n' "$(package_version)"
        printf 'staged pricing.js    sha256 %s\n' "$STAGED_SHA"
        printf 'installed pricing.js sha256 %s\n' "$INSTALLED_SHA"
        if [ "$STAGED_SHA" = "$INSTALLED_SHA" ]; then
            printf 'ALREADY PATCHED\n'
            exit 1
        fi
        # Always back up the live file before overwriting it. "Modified by
        # someone else since our last backup" just means this backup captures
        # that other edit — it is never skipped.
        BACKUP="$INSTALLED.pre-ds-pricing.$(date +%s).bak"
        cp -p "$INSTALLED" "$BACKUP"
        printf 'backup: %s\n' "$BACKUP"
        cp "$STAGED" "$INSTALLED"
        printf 'PATCHED\n'
        ;;

    check)
        printf 'context-mode version: %s\n' "$(package_version)"
        printf 'staged pricing.js    sha256 %s\n' "$STAGED_SHA"
        printf 'installed pricing.js sha256 %s\n' "$INSTALLED_SHA"
        if [ "$STAGED_SHA" = "$INSTALLED_SHA" ]; then
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
            printf 'NOT PATCHED\n'
            exit 1
        fi
        printf 'PATCHED\n'
        run_smoke
        ;;

    -h|--help|help)
        printf 'usage: %s [apply|check|verify]\n' "$(basename "$0")"
        printf '  apply (default)  install the staged pricing.js (idempotent)\n'
        printf '  check            report PATCHED/NOT PATCHED, no writes\n'
        printf '  verify           check + live computeCostUsd smoke test\n'
        ;;

    *)
        die "unknown mode '$MODE' (expected apply|check|verify)"
        ;;
esac
