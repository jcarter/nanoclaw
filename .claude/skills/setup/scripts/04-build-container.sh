#!/bin/bash
set -euo pipefail

# 04-build-container.sh — Build the Docker container image

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

# Verify Docker is available
if ! docker info &>/dev/null; then
  status_block "BUILD_CONTAINER" "failed" \
    "ERROR: Docker daemon not running"
  exit 1
fi

# Build the container
echo "Building nanoclaw-agent container image..."
if ! ./container/build.sh 2>&1; then
  status_block "BUILD_CONTAINER" "failed" \
    "ERROR: Container build failed"
  exit 1
fi

# Verify image exists
if docker image inspect nanoclaw-agent:latest &>/dev/null; then
  IMAGE_SIZE="$(docker image inspect nanoclaw-agent:latest --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}')"
  echo "Image built: nanoclaw-agent:latest (${IMAGE_SIZE})"
else
  status_block "BUILD_CONTAINER" "failed" \
    "ERROR: Image not found after build"
  exit 1
fi

# Quick smoke test
echo "Running smoke test..."
RESULT="$(echo '{}' | docker run -i --rm --entrypoint /bin/echo nanoclaw-agent:latest 'Container OK' 2>&1)" || true
if echo "$RESULT" | grep -q "Container OK"; then
  echo "Smoke test: passed"
else
  echo "Smoke test output: ${RESULT}"
  status_block "BUILD_CONTAINER" "failed" \
    "ERROR: Smoke test failed"
  exit 1
fi

status_block "BUILD_CONTAINER" "success" \
  "IMAGE: nanoclaw-agent:latest" \
  "SIZE: ${IMAGE_SIZE}"
