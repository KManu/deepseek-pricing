#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.pi/agent/extensions/deepseek-pricing"
mkdir -p "$DEST" "$HOME/.pi/deepseek-pricing" "$HOME/.local/bin"
cp "$REPO/index.ts" "$REPO/rates.ts" "$REPO/cn-holidays.json" "$DEST/"
cp "$REPO/scripts/ds-reconcile.mjs" "$HOME/.local/bin/ds-reconcile" 2>/dev/null || true
chmod +x "$HOME/.local/bin/ds-reconcile" 2>/dev/null || true
if [ -x "$HOME/.local/bin/ds-reconcile" ]; then
  echo "installed: $HOME/.local/bin/ds-reconcile"
fi
echo "installed: $DEST"
