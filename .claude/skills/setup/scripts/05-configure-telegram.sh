#!/bin/bash
set -euo pipefail

# 05-configure-telegram.sh — Configure Telegram bot token
# Usage: 05-configure-telegram.sh --token BOT_TOKEN [--pool TOKEN1,TOKEN2,...]

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

BOT_TOKEN=""
POOL_TOKENS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) BOT_TOKEN="$2"; shift 2 ;;
    --pool) POOL_TOKENS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check if already configured
if [[ -f .env ]] && grep -q "^TELEGRAM_BOT_TOKEN=" .env 2>/dev/null; then
  EXISTING="$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d= -f2)"
  echo "Existing Telegram bot token found: ${EXISTING:0:10}..."

  # Validate token by calling getMe
  RESPONSE="$(curl -sf "https://api.telegram.org/bot${EXISTING}/getMe" 2>/dev/null || echo '{"ok":false}')"
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    BOT_NAME="$(echo "$RESPONSE" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)"
    echo "Bot verified: @${BOT_NAME}"
    status_block "CONFIGURE_TELEGRAM" "success" \
      "BOT: @${BOT_NAME}" \
      "STATE: already_configured"
    exit 0
  else
    echo "Warning: Existing token failed validation"
  fi
fi

if [[ -z "$BOT_TOKEN" ]]; then
  echo "No token provided."
  echo ""
  echo "To create a Telegram bot:"
  echo "  1. Open Telegram and message @BotFather"
  echo "  2. Send /newbot and follow the prompts"
  echo "  3. Copy the bot token"
  echo ""
  echo "Usage: $0 --token YOUR_BOT_TOKEN"
  status_block "CONFIGURE_TELEGRAM" "waiting" \
    "STATE: awaiting_token"
  exit 2
fi

# Validate the provided token
RESPONSE="$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')"
if ! echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Token validation failed. Response: ${RESPONSE}"
  status_block "CONFIGURE_TELEGRAM" "failed" \
    "ERROR: invalid_token"
  exit 1
fi

BOT_NAME="$(echo "$RESPONSE" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)"
echo "Bot verified: @${BOT_NAME}"

# Write to .env
update_env_var() {
  local key="$1" value="$2"
  if [[ -f .env ]]; then
    grep -v "^${key}=" .env > .env.tmp || true
    mv .env.tmp .env
  fi
  echo "${key}=${value}" >> .env
}

update_env_var "TELEGRAM_BOT_TOKEN" "$BOT_TOKEN"
update_env_var "TELEGRAM_ONLY" "true"

if [[ -n "$POOL_TOKENS" ]]; then
  update_env_var "TELEGRAM_BOT_POOL" "$POOL_TOKENS"
  # Count pool bots
  POOL_COUNT="$(echo "$POOL_TOKENS" | tr ',' '\n' | wc -l)"
  echo "Bot pool configured: ${POOL_COUNT} additional bots"
fi

echo ""
echo "Telegram configuration written to .env"
echo "Bot username: @${BOT_NAME}"
echo ""
echo "Next: Send /chatid to @${BOT_NAME} in Telegram to get a chat's registration ID"

POOL_INFO=""
if [[ -n "$POOL_TOKENS" ]]; then
  POOL_INFO="POOL_SIZE: ${POOL_COUNT}"
fi

status_block "CONFIGURE_TELEGRAM" "success" \
  "BOT: @${BOT_NAME}" \
  "STATE: configured" \
  ${POOL_INFO:+"$POOL_INFO"}
