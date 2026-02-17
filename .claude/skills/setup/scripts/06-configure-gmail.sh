#!/bin/bash
set -euo pipefail

# 06-configure-gmail.sh — Configure Gmail OAuth credentials
# This script verifies Gmail credentials exist and are valid.
# Actual OAuth setup requires interactive browser flow (handled by SKILL.md).

GMAIL_DIR="${HOME}/.gmail-mcp"

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

# Check if Gmail credentials directory exists
if [[ ! -d "$GMAIL_DIR" ]]; then
  echo "Gmail credentials directory not found: ${GMAIL_DIR}"
  echo ""
  echo "Gmail integration requires:"
  echo "  1. GCP project with Gmail API enabled"
  echo "  2. OAuth credentials (gcp-oauth.keys.json)"
  echo "  3. Authorized token (credentials.json)"
  echo ""
  echo "Run /add-gmail to set up Gmail integration."
  status_block "CONFIGURE_GMAIL" "skipped" \
    "STATE: not_configured"
  exit 0
fi

# Check for OAuth keys
if [[ ! -f "$GMAIL_DIR/gcp-oauth.keys.json" ]]; then
  echo "Missing: ${GMAIL_DIR}/gcp-oauth.keys.json"
  echo "Download OAuth credentials from GCP Console and save them here."
  status_block "CONFIGURE_GMAIL" "failed" \
    "ERROR: missing_oauth_keys"
  exit 1
fi

# Check for authorized token
if [[ ! -f "$GMAIL_DIR/credentials.json" ]]; then
  echo "Missing: ${GMAIL_DIR}/credentials.json"
  echo "Run OAuth authorization to generate this file."
  echo ""
  echo "npx -y @gongrzhe/server-gmail-autoauth-mcp auth"
  status_block "CONFIGURE_GMAIL" "failed" \
    "ERROR: missing_credentials" \
    "FIX: Run OAuth authorization"
  exit 1
fi

# Validate JSON files
if ! python3 -c "import json; json.load(open('${GMAIL_DIR}/gcp-oauth.keys.json'))" 2>/dev/null; then
  echo "Invalid JSON: gcp-oauth.keys.json"
  status_block "CONFIGURE_GMAIL" "failed" \
    "ERROR: invalid_oauth_keys"
  exit 1
fi

if ! python3 -c "import json; json.load(open('${GMAIL_DIR}/credentials.json'))" 2>/dev/null; then
  echo "Invalid JSON: credentials.json"
  status_block "CONFIGURE_GMAIL" "failed" \
    "ERROR: invalid_credentials"
  exit 1
fi

# Check token expiry (if possible)
EXPIRY="$(python3 -c "
import json, sys
try:
    t = json.load(open('${GMAIL_DIR}/credentials.json'))
    if 'refresh_token' in t:
        print('has_refresh_token')
    elif 'expiry_date' in t:
        print(t['expiry_date'])
    else:
        print('unknown')
except:
    print('error')
" 2>/dev/null || echo "unknown")"

echo "Gmail credentials found:"
echo "  OAuth keys: ${GMAIL_DIR}/gcp-oauth.keys.json"
echo "  Token: ${GMAIL_DIR}/credentials.json"
echo "  Refresh token: ${EXPIRY}"

status_block "CONFIGURE_GMAIL" "success" \
  "CREDENTIALS_DIR: ${GMAIL_DIR}" \
  "STATE: configured" \
  "REFRESH_TOKEN: ${EXPIRY}"
