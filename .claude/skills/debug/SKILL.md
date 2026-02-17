---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

**Quick health check first:** Run `bash .claude/skills/setup/scripts/09-verify.sh` for a broad system overview. This skill goes deeper into container-specific issues.

## Architecture Overview

```
Host (Linux / systemd)                Container (Docker)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns Docker container              │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/ (isolated per-group)
    ├── container/agent-runner/src ─> /app/src (readonly, recompiled on startup)
    ├── ~/.gmail-mcp ─────────────> /home/node/.gmail-mcp (if exists)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

**Secrets handling:** Auth tokens are passed via stdin JSON, never written to disk on the host or mounted as files. Inside the container, the entrypoint writes stdin to `/tmp/input.json` which the agent-runner immediately deletes after parsing. The `createSanitizeBashHook` strips secret env vars from any Bash commands the agent runs. See `readSecrets()` in `container-runner.ts`.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side routing, container spawning, Telegram |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **systemd journal** | `journalctl --user -u nanoclaw` | Service lifecycle, crashes, restarts |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For systemd service, add to .env:
echo "LOG_LEVEL=debug" >> .env
systemctl --user restart nanoclaw
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
grep -c "CLAUDE_CODE_OAUTH_TOKEN\|ANTHROPIC_API_KEY" .env
# Should output 1 or more
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables / Secrets

Auth secrets are passed via stdin JSON (not env vars or mounted files). The `readSecrets()` function in `container-runner.ts` reads only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from `.env`.

To verify secrets reach the container, check a container run log:
```bash
# Find the most recent container log
ls -t groups/main/logs/container-*.log | head -1
```

The input JSON in the log will NOT contain secrets (they're stripped before logging), but the stderr section may show auth-related errors.

To test secret passing manually:
```bash
echo '{"prompt":"Say hello","groupFolder":"test","chatJid":"test","isMain":false,"secrets":{"CLAUDE_CODE_OAUTH_TOKEN":"'$(grep CLAUDE_CODE_OAUTH_TOKEN .env | cut -d= -f2)'"}}' | \
  docker run -i --rm \
  -v $(pwd)/groups/main:/workspace/group \
  nanoclaw-agent:latest
```

### 3. Mount Issues

Docker volume mount syntax:
```bash
# Read-write
-v /host/path:/container/path

# Readonly
--mount type=bind,source=/host/path,target=/container/path,readonly
```

To check what's mounted inside a running container:
```bash
# Find running container
docker ps --filter name=nanoclaw

# Inspect mounts
docker inspect $(docker ps -q --filter name=nanoclaw) --format '{{json .Mounts}}' | python3 -m json.tool
```

Or start an interactive shell:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only, readonly)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages (agent writes)
│   ├── tasks/            # Task operations (agent writes)
│   ├── input/            # Inbound commands
│   ├── current_tasks.json    # Readonly: scheduled tasks snapshot
│   └── available_groups.json # Readonly: groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  id
  ls -la /workspace/ 2>/dev/null
  ls -la /app/
'
```

If host files are owned by a different uid, Docker bind mounts will reflect the host uid. Ensure `groups/` and `data/` directories are writable by your user (uid 1000 on most single-user Linux systems).

### 5. Session Not Resuming

If sessions aren't being resumed (new session ID every time), or Claude Code exits with code 1 when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Check the mount path:**
```bash
grep -A3 "Claude sessions" src/container-runner.ts
# Should show containerPath: '/home/node/.claude'
```

**Verify sessions directory exists:**
```bash
ls data/sessions/main/.claude/
# Should show settings.json, projects/, skills/
```

**Verify session continuity in logs:**
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Same session ID across consecutive messages = working
```

**Clear sessions if corrupted:**
```bash
# Clear for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from tracking
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors:
```bash
grep -i "mcp\|server" groups/main/logs/container-*.log | tail -20
```

### 7. Container Timeout / Idle Cleanup

The container-runner has two timeout mechanisms:
- **Hard timeout:** `CONTAINER_TIMEOUT` (default from config, minimum `IDLE_TIMEOUT + 30s`)
- **Idle timeout:** Container stays alive after output for IPC message piping, then gets cleaned up

If you see "Container timed out after output (idle cleanup)" in logs, this is **normal** — the agent finished and the container was reaped after the idle period.

If you see "Container timed out with no output", the agent hung. Check:
- API reachability: `curl -s https://api.anthropic.com/v1/messages -o /dev/null -w '%{http_code}'`
- Container stderr in the log file
- Whether Docker itself is healthy: `docker info`

### 8. Docker Daemon Issues

```bash
# Check Docker is running
docker info

# If not running
sudo systemctl start docker

# Check Docker disk usage (large images/containers can fill disk)
docker system df

# Clean up old containers and images
docker system prune -f
```

## Manual Container Testing

### Test the full agent flow:
```bash
mkdir -p groups/test data/ipc/test/{messages,tasks,input}

echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test","isMain":false,"secrets":{"CLAUDE_CODE_OAUTH_TOKEN":"'$(grep CLAUDE_CODE_OAUTH_TOKEN .env | cut -d= -f2)'"}}' | \
  docker run -i --rm \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc/test:/workspace/ipc \
  --mount type=bind,source=$(pwd)/container/agent-runner/src,target=/app/src,readonly \
  nanoclaw-agent:latest
```

### Test Claude Code directly inside container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest -c '
  export CLAUDE_CODE_OAUTH_TOKEN="YOUR_TOKEN_HERE"
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, Claude Code exits with code 1.

## Rebuilding After Changes

```bash
# Rebuild main app only (host-side TypeScript changes)
npm run build && systemctl --user restart nanoclaw

# Rebuild container (Dockerfile, package.json, or entrypoint changes)
./container/build.sh && npm run build && systemctl --user restart nanoclaw

# Agent-runner source changes (container/agent-runner/src/)
# No rebuild needed! Source is bind-mounted and recompiled on each container start.
# Just restart the service:
systemctl --user restart nanoclaw
```

## Checking Container Image

```bash
# List images
docker images | grep nanoclaw

# Check what's in the image
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version
  echo "=== Claude Code version ==="
  claude --version 2>/dev/null || echo "Not in PATH (installed globally)"
  echo "=== App files ==="
  ls /app/
'

# Check image build date
docker inspect nanoclaw-agent:latest --format '{{.Created}}'
```

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending outbound messages
ls -la data/ipc/main/messages/

# Check pending task operations
ls -la data/ipc/main/tasks/

# Read a specific IPC file
cat data/ipc/main/messages/*.json 2>/dev/null

# Check current tasks snapshot (host writes, agent reads)
cat data/ipc/main/current_tasks.json 2>/dev/null | python3 -m json.tool

# Check available groups (main only)
cat data/ipc/main/available_groups.json 2>/dev/null | python3 -m json.tool
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing Telegram messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `input/*.json` - Host writes: inbound commands to agent
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of groups (main only)

**IPC stuck?** Files in `messages/` or `tasks/` that aren't being processed may indicate the IPC watcher crashed:
```bash
# Check if the service is running
systemctl --user status nanoclaw

# Check for IPC-related errors
grep -i "ipc\|watcher" logs/nanoclaw.log | tail -20
```

## Service Management

```bash
# Status
systemctl --user status nanoclaw

# Logs (follow)
journalctl --user -u nanoclaw -f

# Logs (last 50 lines)
journalctl --user -u nanoclaw -n 50

# Restart
systemctl --user restart nanoclaw

# Stop
systemctl --user stop nanoclaw

# Check if enabled for boot
systemctl --user is-enabled nanoclaw

# View the unit file
systemctl --user cat nanoclaw
```
