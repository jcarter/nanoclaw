#!/bin/bash
set -euo pipefail

# 07-configure-assistant.sh — Configure assistant name and register main channel
# Usage: 07-configure-assistant.sh --name NAME --jid JID [--no-trigger]

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

ASSISTANT_NAME=""
MAIN_JID=""
REQUIRES_TRIGGER="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) ASSISTANT_NAME="$2"; shift 2 ;;
    --jid) MAIN_JID="$2"; shift 2 ;;
    --no-trigger) REQUIRES_TRIGGER="false"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$ASSISTANT_NAME" ]]; then
  echo "Assistant name is required."
  echo "Usage: $0 --name Juniper --jid tg:12345"
  status_block "CONFIGURE_ASSISTANT" "failed" \
    "ERROR: no_name_specified"
  exit 1
fi

if [[ -z "$MAIN_JID" ]]; then
  echo "Main channel JID is required."
  echo ""
  echo "For Telegram, send /chatid to your bot to get the chat ID."
  echo "The JID format is: tg:<chat_id>"
  echo ""
  echo "Usage: $0 --name ${ASSISTANT_NAME} --jid tg:12345"
  status_block "CONFIGURE_ASSISTANT" "waiting" \
    "NAME: ${ASSISTANT_NAME}" \
    "STATE: awaiting_jid"
  exit 2
fi

# Ensure groups directory exists
mkdir -p groups/main/logs
mkdir -p groups/global
mkdir -p data

# Write registered groups JSON (auto-migrated to DB on first run)
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

cat > data/registered_groups.json << EOF
{
  "${MAIN_JID}": {
    "name": "main",
    "folder": "main",
    "trigger": "@${ASSISTANT_NAME}",
    "added_at": "${TIMESTAMP}",
    "requiresTrigger": ${REQUIRES_TRIGGER}
  }
}
EOF

echo "Registered main channel: ${MAIN_JID}"
echo "  Name: ${ASSISTANT_NAME}"
echo "  Trigger: @${ASSISTANT_NAME}"
echo "  Requires trigger: ${REQUIRES_TRIGGER}"

# Update global CLAUDE.md if it exists
if [[ -f groups/global/CLAUDE.md ]]; then
  # Replace assistant name references
  sed -i "s/# Andy/# ${ASSISTANT_NAME}/g" groups/global/CLAUDE.md
  sed -i "s/You are Andy/You are ${ASSISTANT_NAME}/g" groups/global/CLAUDE.md
  echo "Updated groups/global/CLAUDE.md with name: ${ASSISTANT_NAME}"
fi

if [[ -f groups/main/CLAUDE.md ]]; then
  sed -i "s/# Andy/# ${ASSISTANT_NAME}/g" groups/main/CLAUDE.md
  sed -i "s/You are Andy/You are ${ASSISTANT_NAME}/g" groups/main/CLAUDE.md
  echo "Updated groups/main/CLAUDE.md with name: ${ASSISTANT_NAME}"
fi

status_block "CONFIGURE_ASSISTANT" "success" \
  "NAME: ${ASSISTANT_NAME}" \
  "JID: ${MAIN_JID}" \
  "TRIGGER: @${ASSISTANT_NAME}" \
  "REQUIRES_TRIGGER: ${REQUIRES_TRIGGER}"
