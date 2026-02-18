---
name: setup
description: Use when first installing NanoClaw, configuring channels, or setting up background services. Triggers on "setup", "install", "configure nanoclaw".
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (authentication, configuration choices).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

Each step has a corresponding script in `.claude/skills/setup/scripts/`. Run the scripts and parse their structured output blocks. If a script fails, show the user what went wrong before continuing.

## 1. Check Environment

```bash
bash .claude/skills/setup/scripts/01-check-environment.sh
```

This checks: Linux platform, Node.js v20+, Docker, loginctl linger, network connectivity.

If any **errors** are reported, help the user resolve them before continuing. **Warnings** (like linger disabled) can be addressed later in step 8.

## 2. Install Dependencies

```bash
bash .claude/skills/setup/scripts/02-install-deps.sh
```

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Paste it here and I'll add it to `.env` for you.

If they give you the token, run:
```bash
bash .claude/skills/setup/scripts/03-configure-auth.sh --mode oauth --token TOKEN_HERE
```

**Never echo the full token in commands or output.** Use the Write tool to write `.env` directly if the script approach doesn't work.

### Option 2: API Key

Ask for the key, then:
```bash
bash .claude/skills/setup/scripts/03-configure-auth.sh --mode apikey --token KEY_HERE
```

## 4. Build Container Image

```bash
bash .claude/skills/setup/scripts/04-build-container.sh
```

This builds the `nanoclaw-agent:latest` Docker image with Node.js, Chromium, Claude Code CLI, and agent-browser. Includes a smoke test.

## 5. Configure Telegram

Tell the user:
> NanoClaw uses Telegram as its messaging channel. You'll need a Telegram bot token.
>
> If you don't have one yet:
> 1. Open Telegram and message **@BotFather**
> 2. Send `/newbot` and follow the prompts
> 3. Copy the bot token it gives you

Once they provide the token:
```bash
bash .claude/skills/setup/scripts/05-configure-telegram.sh --token BOT_TOKEN
```

### Optional: Bot Pool (Agent Teams)

If the user wants multiple bot identities for agent teams:
> Do you have additional bot tokens for the agent pool? Each agent in a team gets its own bot identity in Telegram group chats.

If yes, collect the tokens as a comma-separated list:
```bash
bash .claude/skills/setup/scripts/05-configure-telegram.sh --token MAIN_TOKEN --pool TOKEN1,TOKEN2,TOKEN3
```

## 6. Configure Gmail (Optional)

```bash
bash .claude/skills/setup/scripts/06-configure-gmail.sh
```

If Gmail credentials aren't found, tell the user this is optional and they can run `/add-gmail` later to set it up.

If the script reports missing credentials, guide the user through GCP OAuth setup (see the `/add-gmail` skill for the full walkthrough).

## 7. Configure Assistant Name and Main Channel

### 7a. Ask for assistant name

Ask the user:
> What name do you want for your assistant? (default: `Andy`)
>
> In group chats, messages starting with `@Name` will trigger the agent.
> In your main channel, no prefix is needed — all messages are processed.

### 7b. Explain security model and ask about main channel

**Use the AskUserQuestion tool:**

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a private Telegram chat with just you and the bot.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Private chat with the bot (Recommended)
> 2. Telegram group (just me and the bot)
> 3. Telegram group with other people (I understand the security implications)

### 7c. Get the chat ID

Tell the user:
> Send `/chatid` to your bot in the chat you want to use as your main channel. It will reply with the chat ID.

The response format is `tg:<chat_id>`.

### 7d. Register the channel

For private chats (no trigger prefix needed):
```bash
bash .claude/skills/setup/scripts/07-configure-assistant.sh --name ASSISTANT_NAME --jid "tg:CHAT_ID" --no-trigger
```

For groups:
```bash
bash .claude/skills/setup/scripts/07-configure-assistant.sh --name ASSISTANT_NAME --jid "tg:CHAT_ID"
```

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write `~/.config/nanoclaw/mount-allowlist.json`:
```json
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

If **yes**, ask which directories and whether each should be read-write or read-only, then write the allowlist accordingly.

Tell the user:
> To grant a group access to a directory, add it to their config:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app" }
>   ]
> }
> ```
> The folder appears inside the container at `/workspace/extra/<folder-name>`.

## 9. Configure systemd Service

```bash
bash .claude/skills/setup/scripts/08-configure-service.sh
```

This creates a systemd user service, enables it, and starts it.

If linger was flagged as disabled in step 1, tell the user:
> Your service is running but won't auto-start on boot. To fix this:
> ```
> sudo loginctl enable-linger $(whoami)
> ```

Or run with `--enable-linger` (requires sudo):
```bash
bash .claude/skills/setup/scripts/08-configure-service.sh --enable-linger
```

## 10. Verify and Test

Run the doctor script to check everything is working:

```bash
bash .claude/skills/setup/scripts/09-verify.sh
```

Review the output with the user. If everything passes, tell them:
> Setup complete! Send a message to your bot in Telegram to test.
>
> **In your main channel:** Just send any message — no trigger prefix needed.
> **In group chats:** Start with `@ASSISTANT_NAME` to trigger the agent.

Monitor logs:
```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

**Service not starting:**
```bash
journalctl --user -u nanoclaw -n 50
cat logs/nanoclaw.error.log
```

**Container agent fails:**
- Ensure Docker is running: `docker info`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages:**
- Verify trigger pattern matches (e.g., `@Name` at start of message)
- Main channel doesn't require a prefix — all messages are processed
- Check registered groups: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`

**Service management:**
```bash
systemctl --user status nanoclaw     # Check status
systemctl --user restart nanoclaw    # Restart
systemctl --user stop nanoclaw       # Stop
journalctl --user -u nanoclaw -f     # Follow logs
```

**Run health check anytime:**
```bash
bash .claude/skills/setup/scripts/09-verify.sh
```
