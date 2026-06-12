---
name: configure
description: Set up the Discord channel — save the bot token and review access policy. Use when the user pastes a Discord bot token, asks to configure Discord, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /discord-plus:configure — Discord Channel Setup

Writes the bot token to `~/.claude/channels/discord/.env` and orients the
user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/discord/.env` for
   `DISCORD_BOT_TOKEN`. Show set/not-set; if set, show first 6 chars masked.

2. **Access** — read `~/.claude/channels/discord/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or snowflakes
   - Pending pairings: count, with codes and display names if any
   - Guild channels opted in: count

3. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/discord-plus:configure <token>` with your bot token from
     the Developer Portal → Bot → Reset Token."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Discord. It replies with a code; approve with `/discord-plus:access pair
     <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Default posture: loose for personal prototypes, explicit for shared use.**
`pairing` is a reasonable onboarding default for a personal bot because it lets
the owner collect sender IDs without hunting for snowflakes. For public servers,
busy shared channels, or bots with broad Claude Code permissions, recommend
switching to `allowlist` once the intended users are known.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask whether this is a personal prototype or a shared/public bot.
3. **If personal and policy is `pairing`** → confirm it is ready and mention
   they can switch to `allowlist` later.
4. **If shared/public and policy is still `pairing`** → recommend
   `/discord-plus:access policy allowlist` once the intended users are present.
5. **If people are missing** → *"Have them DM the bot; you'll approve
   each with `/discord-plus:access pair <code>`."* Or, if they can get snowflakes
   directly: *"Enable Developer Mode in Discord (User Settings → Advanced),
   right-click them → Copy User ID, then `/discord-plus:access allow <id>`."*
6. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   who should be able to reach it."*
7. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone, Copy User ID is the clean path — no need to
   reopen pairing.

Discord already gates reach (shared-server requirement + Public Bot toggle),
but that's not a substitute for thinking about who can talk to a bot that may
have broad Claude Code permissions. Keep the guidance clear about the tradeoff.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). Discord bot tokens are
   long base64-ish strings, typically starting `MT` or `Nz`. Generated from
   Developer Portal → Bot → Reset Token; only shown once.
2. `mkdir -p ~/.claude/channels/discord`
3. Read existing `.env` if present; update/add the `DISCORD_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/discord/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the token

Delete the `DISCORD_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/discord-plus:access` take effect immediately, no restart.
