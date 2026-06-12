# Discord CC Plus

Connect a Discord bot to your Claude Code with an MCP server — with **native Discord slash commands** for your installed Claude Code skills.

> **Prototype / use at your own risk.** This is an experimental fork published
> for people who are comfortable reading the code, running local Claude Code
> plugins, and managing their own Discord bot permissions. It is not an official
> Anthropic or Discord project, not production-hardened, and not supported as a
> service. Review the access model before connecting it to any server or bot
> token you care about.

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, and edit messages. On boot it also scans your installed skills and registers them as Discord application commands, so typing `/` in Discord gives you autocomplete over everything Claude can run — no memorizing skill names.

> Fork of the official [`discord` plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) (Apache-2.0). Same access control and tools; adds slash-command integration. **Don't run both plugins at once** — they'd open two gateway connections on the same token and double-reply. Disable `discord@claude-plugins-official` before enabling this one. State (token, pairing, allowlists) lives in the same `~/.claude/channels/discord/` directory, so switching over carries your config.

## What this is

Discord CC Plus is a Claude Code plugin that lets a Discord bot act as a channel
into a local Claude Code session. Discord messages arrive in Claude as channel
notifications, and Claude gets tools to send replies, edit its own messages, add
reactions, fetch recent history, and download attachments when needed.

The extra piece is slash commands. Discord CC Plus scans the skills available to
your Claude Code session and exposes them as Discord application commands, so a
Discord user can type `/` and discover what the assistant can do. It also
includes a catch-all `/skill` command with autocomplete for larger skill sets.

## Why this fork exists

Anthropic's official Discord plugin is a solid base for routing Discord messages
into Claude Code. This fork keeps that shape, but adds the parts we wanted for
long-running agent workflows:

- Native Discord slash-command registration for Claude Code skills.
- Access controls for DMs and opted-in guild channels.
- A typing loop and progress heartbeat for longer runs.
- Attachment download and recent-history helpers.
- Guardrails that keep access-management skills out of Discord-triggered slash
  commands.

This is intentionally still small and local-first. It is useful for experiments,
personal bots, and agent prototypes. It is not trying to be a hosted Discord bot
platform.

## Slash commands

At gateway connect, the server:

1. Scans `~/.claude/skills/` (personal skills) and every enabled plugin's `skills/` directory, reading each `SKILL.md`'s name and description.
2. Adds hand-configured `extra` entries for Claude Code built-ins and safe native facades the disk scan can't see (defaults include `code-review`, `security-review`, `verify`, `run`, `deep-research`, `schedule`, `init`, `status`, `doctor`, `cost`, `help`).
3. Registers each as a Discord application command (capped at Discord's 100-command limit), plus a catch-all **`/skill name:<autocomplete> args:`** command that searches all of them.
4. Caches the manifest hash in `commands-registered.json` — re-registration only happens when the skill set changes.

Invoking a command posts a visible "⏳ Running…" placeholder (the assistant edits it with progress). Most commands forward `/skill-name args` into your Claude session, which runs the skill and replies in-channel. Safe native facades translate to natural-language instructions instead of raw Claude Code slash commands.

Authorization mirrors messaging: DM slash commands require a paired sender; guild slash commands require the channel to be opted in. The plugin's own access-management skills (`access`, `configure`, `commands`) are hard-blocked from registration — access mutations must never be reachable from Discord. Session/configuration commands such as `login`, `logout`, `permissions`, `plugin`, `plugins`, `clear`, `compact`, `resume`, `memory`, and `model` should stay blocked unless they are implemented as explicit safe facades.

Configure via `/discord-plus:commands` in your terminal session (enable/disable, exclude skills, per-guild registration, add built-ins). Config lives in `~/.claude/channels/discord/commands.json`.

> **Tip:** global commands can take up to an hour to appear the first time. For instant updates while testing, set a guild ID: `/discord-plus:commands guild <server-id>`.

## Recommended Claude Code settings

Discord bots feel best when Claude Code can work without repeatedly asking the
Discord user to approve routine tool calls. Run the session from the project
directory you want the bot to work in, and choose a permission mode that matches
how much you trust that workspace.

Good default for a personal bot in a trusted repo:

```sh
claude --channels plugin:discord-plus@discord-plus \
  --permission-mode auto \
  --effort high
```

More open, for disposable sandboxes or machines where you are comfortable with
the bot acting without permission prompts:

```sh
claude --channels plugin:discord-plus@discord-plus \
  --permission-mode bypassPermissions \
  --effort max
```

`bypassPermissions` is intentionally powerful. Use it only in a workspace and
machine context where Discord-triggered requests are allowed to read, edit, and
run commands without a local confirmation step. For shared servers, keep channel
access tight even if the Claude session itself is permissive.

For long-running coding-agent behavior, use a persistent terminal/tmux session
or a process manager, start Claude in the target repo, and opt in only the
Discord channels that should be able to drive that workspace.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` **and `applications.commands`** scopes (the second one is what allows slash commands). Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> Already invited the bot without `applications.commands`? Re-run the OAuth URL with both scopes — no need to kick the bot first.

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

```
/plugin marketplace add davefano/discord-cc-plus
/plugin install discord-plus@discord-plus
/reload-plugins
```

**5. Give the server the token.**

```
/discord-plus:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:discord-plus@discord-plus
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/discord-plus:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/discord-plus:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default DM policy is `pairing`. Guild channels are opt-in per channel ID and ambient by default once enabled.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to any message by ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; messages with attachments are marked `+Natt`. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works on a response.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).
