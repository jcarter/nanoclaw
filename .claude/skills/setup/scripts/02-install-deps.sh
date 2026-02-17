#!/bin/bash
set -euo pipefail

# 02-install-deps.sh — Install Node.js dependencies

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"

status_block() {
  local phase="$1" status="$2"
  shift 2
  echo "=== NANOCLAW SETUP: ${phase} ==="
  while [[ $# -gt 0 ]]; do
    echo "$1"
    shift
  done
  echo "STATUS: ${status}"
  echo "=== END ==="
}

cd "$PROJECT_ROOT"

echo "Installing dependencies in ${PROJECT_ROOT}..."

if ! npm install 2>&1; then
  status_block "INSTALL_DEPS" "failed" \
    "ERROR: npm install failed"
  exit 1
fi

# Verify key packages
missing=()
for pkg in grammy googleapis better-sqlite3 pino cron-parser; do
  if [[ ! -d "node_modules/${pkg}" ]]; then
    missing+=("$pkg")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  status_block "INSTALL_DEPS" "failed" \
    "ERROR: Missing packages: ${missing[*]}"
  exit 1
fi

echo ""
status_block "INSTALL_DEPS" "success" \
  "PROJECT: ${PROJECT_ROOT}" \
  "PACKAGES: verified"
