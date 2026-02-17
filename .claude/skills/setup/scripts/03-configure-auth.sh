#!/bin/bash
set -euo pipefail

# 03-configure-auth.sh — Configure Claude authentication
# Usage: 03-configure-auth.sh --mode oauth|apikey [--token TOKEN]

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

MODE=""
TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check if already configured
if [[ -f .env ]]; then
  if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null; then
    EXISTING="$(grep "^CLAUDE_CODE_OAUTH_TOKEN=" .env | cut -d= -f2)"
    echo "Existing OAuth token found: ${EXISTING:0:15}..."
    status_block "CONFIGURE_AUTH" "success" \
      "MODE: oauth" \
      "STATE: already_configured"
    exit 0
  fi
  if grep -q "^ANTHROPIC_API_KEY=" .env 2>/dev/null; then
    EXISTING="$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)"
    echo "Existing API key found: ${EXISTING:0:10}..."
    status_block "CONFIGURE_AUTH" "success" \
      "MODE: apikey" \
      "STATE: already_configured"
    exit 0
  fi
fi

if [[ -z "$MODE" ]]; then
  echo "No auth mode specified and no existing config found."
  echo "Usage: $0 --mode oauth|apikey [--token TOKEN]"
  status_block "CONFIGURE_AUTH" "failed" \
    "ERROR: no_mode_specified"
  exit 1
fi

case "$MODE" in
  oauth)
    if [[ -z "$TOKEN" ]]; then
      echo "OAuth mode selected but no token provided."
      echo "Run 'claude setup-token' in another terminal to get a token."
      status_block "CONFIGURE_AUTH" "waiting" \
        "MODE: oauth" \
        "STATE: awaiting_token"
      exit 2
    fi
    # Append or create .env
    if [[ -f .env ]]; then
      # Remove any existing line and append
      grep -v "^CLAUDE_CODE_OAUTH_TOKEN=" .env > .env.tmp || true
      mv .env.tmp .env
      echo "CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}" >> .env
    else
      echo "CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}" > .env
    fi
    echo "OAuth token configured."
    status_block "CONFIGURE_AUTH" "success" \
      "MODE: oauth" \
      "STATE: configured"
    ;;
  apikey)
    if [[ -z "$TOKEN" ]]; then
      echo "API key mode selected but no key provided."
      echo "Get your key from https://console.anthropic.com/"
      status_block "CONFIGURE_AUTH" "waiting" \
        "MODE: apikey" \
        "STATE: awaiting_key"
      exit 2
    fi
    if [[ -f .env ]]; then
      grep -v "^ANTHROPIC_API_KEY=" .env > .env.tmp || true
      mv .env.tmp .env
      echo "ANTHROPIC_API_KEY=${TOKEN}" >> .env
    else
      echo "ANTHROPIC_API_KEY=${TOKEN}" > .env
    fi
    echo "API key configured."
    status_block "CONFIGURE_AUTH" "success" \
      "MODE: apikey" \
      "STATE: configured"
    ;;
  *)
    echo "Unknown mode: ${MODE}"
    status_block "CONFIGURE_AUTH" "failed" \
      "ERROR: unknown_mode"
    exit 1
    ;;
esac
