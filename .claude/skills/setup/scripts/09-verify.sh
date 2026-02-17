#!/bin/bash
set -uo pipefail
# NOTE: We intentionally omit -e because check commands may return non-zero

# 09-verify.sh — Doctor/verify script: checks all prerequisites and running state
# Run anytime to diagnose issues. No arguments needed.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"

cd "$PROJECT_ROOT" || exit 1

pass=0
warn=0
fail=0

check_pass() { echo "  ✓ $1"; ((pass++)); }
check_warn() { echo "  ⚠ $1"; ((warn++)); }
check_fail() { echo "  ✗ $1"; ((fail++)); }

echo "NanoClaw Health Check"
echo "====================="
echo ""

# --- System ---
echo "System"
echo "------"

# Node.js
if command -v node &>/dev/null; then
  NODE_V="$(node --version)"
  NODE_MAJOR="${NODE_V#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    check_pass "Node.js ${NODE_V}"
  else
    check_fail "Node.js ${NODE_V} (need v20+)"
  fi
else
  check_fail "Node.js not found"
fi

# Docker
if command -v docker &>/dev/null; then
  if docker info &>/dev/null; then
    check_pass "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
  else
    check_fail "Docker installed but daemon not running"
  fi
else
  check_fail "Docker not installed"
fi

# Docker group
if groups | grep -qw docker 2>/dev/null; then
  check_pass "User in docker group"
else
  check_warn "User not in docker group (may need sudo)"
fi

# Linger
CURRENT_USER="$(whoami)"
if command -v loginctl &>/dev/null; then
  LINGER="$(loginctl show-user "$CURRENT_USER" --property=Linger 2>/dev/null || echo "Linger=unknown")"
  if [[ "$LINGER" == "Linger=yes" ]]; then
    check_pass "loginctl linger enabled"
  else
    check_warn "loginctl linger disabled — service won't start at boot (fix: sudo loginctl enable-linger ${CURRENT_USER})"
  fi
fi

echo ""

# --- Project ---
echo "Project"
echo "-------"

# package.json
if [[ -f package.json ]]; then
  check_pass "package.json exists"
else
  check_fail "package.json not found"
fi

# node_modules
if [[ -d node_modules ]]; then
  check_pass "node_modules installed"
else
  check_fail "node_modules missing (run: npm install)"
fi

# TypeScript build
if [[ -f dist/index.js ]]; then
  SRC_TIME="$(stat -c %Y src/index.ts 2>/dev/null || echo 0)"
  DIST_TIME="$(stat -c %Y dist/index.js 2>/dev/null || echo 0)"
  if [[ "$SRC_TIME" -gt "$DIST_TIME" ]]; then
    check_warn "dist/index.js is stale (run: npm run build)"
  else
    check_pass "dist/index.js compiled"
  fi
else
  check_fail "dist/index.js not found (run: npm run build)"
fi

# Container image
if docker image inspect nanoclaw-agent:latest &>/dev/null; then
  IMAGE_AGE="$(docker image inspect nanoclaw-agent:latest --format '{{.Created}}' 2>/dev/null | cut -dT -f1)"
  check_pass "Container image: nanoclaw-agent:latest (built ${IMAGE_AGE})"
else
  check_fail "Container image not built (run: ./container/build.sh)"
fi

echo ""

# --- Configuration ---
echo "Configuration"
echo "-------------"

# .env file
if [[ -f .env ]]; then
  check_pass ".env file exists"

  # Claude auth
  if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null; then
    TOKEN="$(grep "^CLAUDE_CODE_OAUTH_TOKEN=" .env | cut -d= -f2)"
    check_pass "Claude OAuth token: ${TOKEN:0:15}..."
  elif grep -q "^ANTHROPIC_API_KEY=" .env 2>/dev/null; then
    KEY="$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)"
    check_pass "Anthropic API key: ${KEY:0:10}..."
  else
    check_fail "No Claude auth configured in .env"
  fi

  # Telegram
  if grep -q "^TELEGRAM_BOT_TOKEN=" .env 2>/dev/null; then
    TG_TOKEN="$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d= -f2)"
    # Validate token
    RESPONSE="$(curl -sf "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')"
    if echo "$RESPONSE" | grep -q '"ok":true'; then
      BOT_NAME="$(echo "$RESPONSE" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)"
      check_pass "Telegram bot: @${BOT_NAME}"
    else
      check_fail "Telegram bot token invalid (getMe failed)"
    fi
  else
    check_fail "TELEGRAM_BOT_TOKEN not set in .env"
  fi

  # Telegram mode
  if grep -q "^TELEGRAM_ONLY=true" .env 2>/dev/null; then
    check_pass "Telegram-only mode enabled"
  fi

  # Bot pool
  if grep -q "^TELEGRAM_BOT_POOL=" .env 2>/dev/null; then
    POOL="$(grep "^TELEGRAM_BOT_POOL=" .env | cut -d= -f2)"
    POOL_COUNT="$(echo "$POOL" | tr ',' '\n' | wc -l)"
    check_pass "Telegram bot pool: ${POOL_COUNT} bots"
  fi
else
  check_fail ".env file missing"
fi

echo ""

# --- Channels ---
echo "Channels"
echo "--------"

# Gmail
GMAIL_DIR="${HOME}/.gmail-mcp"
if [[ -d "$GMAIL_DIR" ]]; then
  if [[ -f "$GMAIL_DIR/gcp-oauth.keys.json" ]] && [[ -f "$GMAIL_DIR/credentials.json" ]]; then
    check_pass "Gmail credentials: ${GMAIL_DIR}"
  elif [[ -f "$GMAIL_DIR/gcp-oauth.keys.json" ]]; then
    check_warn "Gmail OAuth keys present but credentials.json missing (re-run authorization)"
  else
    check_warn "Gmail directory exists but incomplete"
  fi
else
  check_warn "Gmail not configured (optional — run /add-gmail to set up)"
fi

# Registered groups
if [[ -f store/messages.db ]]; then
  GROUP_COUNT="$(sqlite3 store/messages.db "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo "0")"
  if [[ "$GROUP_COUNT" -gt 0 ]]; then
    check_pass "Registered groups: ${GROUP_COUNT}"
    # List them
    sqlite3 store/messages.db "SELECT jid, name FROM registered_groups" 2>/dev/null | while IFS='|' read -r jid name; do
      echo "      ${name} (${jid})"
    done
  else
    check_warn "No groups registered"
  fi
elif [[ -f data/registered_groups.json ]]; then
  check_pass "Registered groups: data/registered_groups.json (will migrate on first run)"
else
  check_warn "No groups registered"
fi

# Mount allowlist
if [[ -f "${HOME}/.config/nanoclaw/mount-allowlist.json" ]]; then
  check_pass "Mount allowlist: ${HOME}/.config/nanoclaw/mount-allowlist.json"
else
  check_warn "Mount allowlist not configured (agents can only access their own group folder)"
fi

echo ""

# --- Groups ---
echo "Groups"
echo "------"

if [[ -d groups/main ]]; then
  check_pass "groups/main/ exists"
else
  check_warn "groups/main/ missing"
fi

if [[ -f groups/global/CLAUDE.md ]]; then
  check_pass "groups/global/CLAUDE.md exists"
else
  check_warn "groups/global/CLAUDE.md missing"
fi

if [[ -d data/ipc ]]; then
  check_pass "IPC directory exists"
else
  check_warn "IPC directory missing (created on first run)"
fi

echo ""

# --- Service ---
echo "Service"
echo "-------"

SYSTEMD_DIR="${HOME}/.config/systemd/user"
if [[ -f "${SYSTEMD_DIR}/nanoclaw.service" ]]; then
  check_pass "systemd unit: ${SYSTEMD_DIR}/nanoclaw.service"

  if systemctl --user is-enabled nanoclaw.service &>/dev/null; then
    check_pass "Service enabled (starts on login)"
  else
    check_warn "Service not enabled (run: systemctl --user enable nanoclaw)"
  fi

  if systemctl --user is-active nanoclaw.service &>/dev/null; then
    PID="$(systemctl --user show nanoclaw.service --property=MainPID --value 2>/dev/null || echo "?")"
    UPTIME="$(systemctl --user show nanoclaw.service --property=ActiveEnterTimestamp --value 2>/dev/null || echo "?")"
    check_pass "Service running (PID ${PID}, since ${UPTIME})"
  else
    check_fail "Service not running (start: systemctl --user start nanoclaw)"
    # Show recent errors
    echo "      Recent errors:"
    journalctl --user -u nanoclaw --no-pager -n 5 --output=short-iso 2>/dev/null | sed 's/^/      /' || true
  fi
else
  check_fail "systemd unit not found (run setup step 08)"
fi

# Check for log files
if [[ -f logs/nanoclaw.log ]]; then
  LOG_SIZE="$(du -h logs/nanoclaw.log | awk '{print $1}')"
  check_pass "Log file: ${LOG_SIZE} (logs/nanoclaw.log)"
else
  check_warn "No log file yet"
fi

if [[ -f logs/nanoclaw.error.log ]]; then
  ERR_SIZE="$(du -h logs/nanoclaw.error.log | awk '{print $1}')"
  ERR_LINES="$(wc -l < logs/nanoclaw.error.log)"
  if [[ "$ERR_LINES" -gt 0 ]]; then
    check_warn "Error log: ${ERR_SIZE}, ${ERR_LINES} lines (logs/nanoclaw.error.log)"
  else
    check_pass "Error log: empty"
  fi
fi

echo ""

# --- Network ---
echo "Network"
echo "-------"

HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.anthropic.com/v1/messages 2>/dev/null || echo "000")"
if [[ "$HTTP_CODE" != "000" ]]; then
  check_pass "Anthropic API reachable (HTTP ${HTTP_CODE})"
else
  check_fail "Cannot reach api.anthropic.com"
fi

HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.telegram.org 2>/dev/null || echo "000")"
if [[ "$HTTP_CODE" != "000" ]]; then
  check_pass "Telegram API reachable (HTTP ${HTTP_CODE})"
else
  check_fail "Cannot reach api.telegram.org"
fi

echo ""

# --- Summary ---
echo "Summary"
echo "-------"
echo "  ✓ ${pass} passed"
if [[ "$warn" -gt 0 ]]; then
  echo "  ⚠ ${warn} warnings"
fi
if [[ "$fail" -gt 0 ]]; then
  echo "  ✗ ${fail} failed"
fi

echo ""

if [[ "$fail" -gt 0 ]]; then
  echo "=== NANOCLAW VERIFY: ISSUES FOUND ==="
  echo "PASS: ${pass}"
  echo "WARN: ${warn}"
  echo "FAIL: ${fail}"
  echo "STATUS: failed"
  echo "=== END ==="
  exit 1
elif [[ "$warn" -gt 0 ]]; then
  echo "=== NANOCLAW VERIFY: OK WITH WARNINGS ==="
  echo "PASS: ${pass}"
  echo "WARN: ${warn}"
  echo "FAIL: ${fail}"
  echo "STATUS: success"
  echo "=== END ==="
  exit 0
else
  echo "=== NANOCLAW VERIFY: ALL CLEAR ==="
  echo "PASS: ${pass}"
  echo "WARN: ${warn}"
  echo "FAIL: ${fail}"
  echo "STATUS: success"
  echo "=== END ==="
  exit 0
fi
