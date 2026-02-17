#!/bin/bash
set -euo pipefail

# 01-check-environment.sh — Verify system prerequisites for NanoClaw
# Checks: platform, Node.js, Docker, loginctl linger, network

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

errors=()
warnings=()

# --- Platform ---
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: ${PLATFORM} ${ARCH}"

if [[ "$PLATFORM" != "Linux" ]]; then
  errors+=("PLATFORM: Expected Linux, got ${PLATFORM}")
fi

# --- Node.js ---
if command -v node &>/dev/null; then
  NODE_PATH="$(command -v node)"
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  echo "Node.js: ${NODE_VERSION} (${NODE_PATH})"

  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    errors+=("NODE: Version ${NODE_VERSION} is below minimum v20")
  fi

  # Check if managed by asdf
  if command -v asdf &>/dev/null; then
    ASDF_NODE="$(asdf which node 2>/dev/null || echo "")"
    if [[ -n "$ASDF_NODE" ]]; then
      echo "Node manager: asdf"
    fi
  fi
else
  errors+=("NODE: Not found in PATH")
fi

# --- npm ---
if command -v npm &>/dev/null; then
  NPM_VERSION="$(npm --version)"
  echo "npm: ${NPM_VERSION}"
else
  errors+=("NPM: Not found in PATH")
fi

# --- Docker ---
if command -v docker &>/dev/null; then
  DOCKER_VERSION="$(docker --version 2>/dev/null || echo "unknown")"
  echo "Docker: ${DOCKER_VERSION}"

  if docker info &>/dev/null; then
    echo "Docker daemon: running"
  else
    errors+=("DOCKER: Daemon not running (try: sudo systemctl start docker)")
  fi

  # Check user is in docker group (no sudo needed)
  if groups | grep -qw docker; then
    echo "Docker group: yes"
  else
    warnings+=("DOCKER_GROUP: User not in docker group (may need sudo for docker commands)")
  fi
else
  errors+=("DOCKER: Not installed (install: https://docs.docker.com/engine/install/)")
fi

# --- loginctl linger ---
CURRENT_USER="$(whoami)"
if command -v loginctl &>/dev/null; then
  LINGER_STATUS="$(loginctl show-user "$CURRENT_USER" --property=Linger 2>/dev/null || echo "Linger=unknown")"
  if [[ "$LINGER_STATUS" == "Linger=yes" ]]; then
    echo "Linger: enabled"
  else
    warnings+=("LINGER: Not enabled — systemd user services won't start at boot (fix: sudo loginctl enable-linger ${CURRENT_USER})")
  fi
else
  warnings+=("LOGINCTL: Not found — cannot verify linger status")
fi

# --- Network ---
if curl -sf --max-time 5 https://api.anthropic.com >/dev/null 2>&1 || \
   curl -sf --max-time 5 https://api.anthropic.com/v1/messages >/dev/null 2>&1; then
  echo "Network (Anthropic API): reachable"
else
  # 401/403 is fine — means the host is reachable
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.anthropic.com/v1/messages 2>/dev/null || echo "000")"
  if [[ "$HTTP_CODE" != "000" ]]; then
    echo "Network (Anthropic API): reachable (HTTP ${HTTP_CODE})"
  else
    warnings+=("NETWORK: Cannot reach api.anthropic.com")
  fi
fi

if curl -sf --max-time 5 https://api.telegram.org >/dev/null 2>&1; then
  echo "Network (Telegram API): reachable"
else
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.telegram.org 2>/dev/null || echo "000")"
  if [[ "$HTTP_CODE" != "000" ]]; then
    echo "Network (Telegram API): reachable (HTTP ${HTTP_CODE})"
  else
    warnings+=("NETWORK: Cannot reach api.telegram.org")
  fi
fi

# --- Project directory ---
if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  echo "Project root: ${PROJECT_ROOT}"
else
  errors+=("PROJECT: package.json not found at ${PROJECT_ROOT}")
fi

# --- Summary ---
echo ""

if [[ ${#warnings[@]} -gt 0 ]]; then
  echo "Warnings:"
  for w in "${warnings[@]}"; do
    echo "  ⚠ ${w}"
  done
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "Errors:"
  for e in "${errors[@]}"; do
    echo "  ✗ ${e}"
  done
  status_block "CHECK_ENVIRONMENT" "failed" \
    "PLATFORM: ${PLATFORM}" \
    "ARCH: ${ARCH}" \
    "ERRORS: ${#errors[@]}" \
    "WARNINGS: ${#warnings[@]}"
  exit 1
fi

status_block "CHECK_ENVIRONMENT" "success" \
  "PLATFORM: ${PLATFORM}" \
  "ARCH: ${ARCH}" \
  "NODE: ${NODE_VERSION:-unknown}" \
  "DOCKER: installed" \
  "WARNINGS: ${#warnings[@]}"
