#!/bin/bash
set -euo pipefail

# 08-configure-service.sh — Create systemd user service and enable it
# Usage: 08-configure-service.sh [--enable-linger]

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

ENABLE_LINGER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-linger) ENABLE_LINGER=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve paths
NODE_PATH="$(command -v node)"
CURRENT_USER="$(whoami)"
SYSTEMD_DIR="${HOME}/.config/systemd/user"

# Build TypeScript first
echo "Compiling TypeScript..."
npm run build 2>&1

# Create logs directory
mkdir -p logs

# Create systemd user directory
mkdir -p "$SYSTEMD_DIR"

# Construct PATH that includes node's directory and common paths
NODE_DIR="$(dirname "$NODE_PATH")"
ASDF_SHIMS=""
if [[ -d "${HOME}/.asdf/shims" ]]; then
  ASDF_SHIMS="${HOME}/.asdf/shims:"
fi

SERVICE_PATH="${ASDF_SHIMS}${NODE_DIR}:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin"

# Write the service file
cat > "${SYSTEMD_DIR}/nanoclaw.service" << EOF
[Unit]
Description=NanoClaw - Personal Claude Assistant
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${NODE_PATH} ${PROJECT_ROOT}/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=${PROJECT_ROOT}/.env
Environment=HOME=${HOME}
Environment=PATH=${SERVICE_PATH}
StandardOutput=append:${PROJECT_ROOT}/logs/nanoclaw.log
StandardError=append:${PROJECT_ROOT}/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

echo "Service file written: ${SYSTEMD_DIR}/nanoclaw.service"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_ROOT}"

# Reload systemd
systemctl --user daemon-reload

# Enable the service (starts on login / boot with linger)
systemctl --user enable nanoclaw.service
echo "Service enabled"

# Start it now
systemctl --user start nanoclaw.service
echo "Service started"

# Check linger
LINGER_STATUS="$(loginctl show-user "$CURRENT_USER" --property=Linger 2>/dev/null || echo "Linger=unknown")"
LINGER_MSG=""
if [[ "$LINGER_STATUS" != "Linger=yes" ]]; then
  if [[ "$ENABLE_LINGER" == "true" ]]; then
    sudo loginctl enable-linger "$CURRENT_USER" 2>/dev/null && \
      echo "Linger enabled for ${CURRENT_USER}" || \
      echo "Warning: Could not enable linger (needs sudo)"
    LINGER_MSG="LINGER: enabled"
  else
    echo ""
    echo "WARNING: loginctl linger is not enabled."
    echo "Without linger, the service will NOT start at boot — only when you log in."
    echo "Fix: sudo loginctl enable-linger ${CURRENT_USER}"
    LINGER_MSG="LINGER: disabled (service won't start at boot)"
  fi
else
  LINGER_MSG="LINGER: enabled"
fi

# Verify service is running
sleep 2
if systemctl --user is-active nanoclaw.service &>/dev/null; then
  echo ""
  echo "Service is running."
  status_block "CONFIGURE_SERVICE" "success" \
    "SERVICE: nanoclaw.service" \
    "STATE: running" \
    "$LINGER_MSG"
else
  echo ""
  echo "Service failed to start. Check logs:"
  echo "  journalctl --user -u nanoclaw -n 20"
  echo "  cat ${PROJECT_ROOT}/logs/nanoclaw.error.log"
  status_block "CONFIGURE_SERVICE" "failed" \
    "SERVICE: nanoclaw.service" \
    "STATE: failed" \
    "ERROR: service_not_running"
  exit 1
fi
