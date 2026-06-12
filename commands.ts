/**
 * Native Discord slash commands for Claude Code skills.
 *
 * Discovers skills installed on this machine (personal ~/.claude/skills plus
 * enabled plugin skills), registers them as Discord application commands so
 * the user gets autocomplete instead of memorizing names, and translates
 * command interactions into the same channel notifications the message path
 * uses - the model sees "/<skill> <args>" as if the user typed it. Some
 * maintained native command facades send natural-language prompts instead,
 * so Discord can expose safe Claude-Code-like actions without handing the
 * channel session/config mutation commands.
 *
 * Config lives in ~/.claude/channels/discord/commands.json (created with
 * defaults on first boot). Registration is bulk-overwrite, cached by manifest
 * hash so we only hit Discord's API when the skill set actually changes.
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  ApplicationCommandOptionType,
  type Client,
  type ApplicationCommandDataResolvable,
} from 'discord.js'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const COMMANDS_FILE = join(STATE_DIR, 'commands.json')
const REGISTERED_FILE = join(STATE_DIR, 'commands-registered.json')
const CLAUDE_DIR = join(homedir(), '.claude')

/** Skills that must never be invocable from Discord — they manage who can
 * reach this channel. A slash command is exactly the vector a prompt
 * injection would use. */
const BLOCKED_SKILLS = [
  /(^|:)access$/,
  /(^|:)configure$/,
  /(^|:)commands$/,
  /^(login|logout|permissions|plugin|plugins|clear|compact|resume|memory|model)$/,
  /(^|:)native:(login|logout|permissions|plugin|plugins|clear|compact|resume|memory|model)$/,
]

export type SkillEntry = {
  /** Full skill identifier the model invokes, e.g. "compound-engineering:ce-plan". */
  skill: string
  /** Discord command name — lowercase [a-z0-9-], ≤32 chars, unique. */
  command: string
  description: string
  /** Optional prompt facade. Use "{args}" as the Discord args placeholder. */
  prompt?: string
}

export type CommandsConfig = {
  enabled: boolean
  /** null/absent → register globally. Set a guild ID for instant per-server updates. */
  guildId?: string | null
  /** Skill identifiers (or globs with *) to skip. */
  exclude: string[]
  /** Hand-maintained entries for skills discovery can't see (built-ins like
   * code-review live inside Claude Code, not on disk). */
  extra: SkillEntry[]
}

const BUILT_IN_COMMANDS: SkillEntry[] = [
  { skill: 'code-review', command: 'code-review', description: 'Review the current diff for bugs and cleanups (low/medium/high/max/ultra effort)' },
  { skill: 'security-review', command: 'security-review', description: 'Security review of pending changes on the current branch' },
  { skill: 'verify', command: 'verify', description: 'Run the app and verify a change actually works' },
  { skill: 'run', command: 'run', description: 'Launch the project app to see a change working' },
  { skill: 'deep-research', command: 'deep-research', description: 'Multi-source, fact-checked research report on any topic' },
  { skill: 'schedule', command: 'schedule', description: 'Create or manage scheduled cloud agents (cron routines)' },
  {
    skill: 'native:init',
    command: 'init',
    description: 'Inspect the project and create or update CLAUDE.md guidance',
    prompt: 'Run the safe equivalent of Claude Code /init for this workspace. Inspect the project, then create or update CLAUDE.md with concise guidance. User args: {args}',
  },
  {
    skill: 'native:status',
    command: 'status',
    description: 'Summarize current Claude session, cwd, plugins, and channel state',
    prompt: 'Summarize the current Claude Code session status for the user: model, cwd, active channel/plugin state, important limits, and any warnings. User args: {args}',
  },
  {
    skill: 'native:doctor',
    command: 'doctor',
    description: 'Run non-destructive Claude Code and Discord plugin diagnostics',
    prompt: 'Run non-destructive diagnostics for this Claude Code Discord setup and report issues and fixes. Do not mutate config. User args: {args}',
  },
  {
    skill: 'native:cost',
    command: 'cost',
    description: 'Summarize token and cost usage visible in this session',
    prompt: 'Summarize token and cost usage visible in this session. If exact cost is unavailable, say so and report available token/session metrics. User args: {args}',
  },
  {
    skill: 'native:help',
    command: 'help',
    description: 'Show available Discord Claude commands and how to use them',
    prompt: "Explain the available Discord slash commands exposed by this plugin and suggest the right one for the user's goal. User args: {args}",
  },
]

function defaultConfig(): CommandsConfig {
  return {
    enabled: true,
    guildId: null,
    exclude: [],
    extra: [],
  }
}

export function loadCommandsConfig(): CommandsConfig {
  try {
    const parsed = JSON.parse(readFileSync(COMMANDS_FILE, 'utf8')) as Partial<CommandsConfig>
    return {
      enabled: parsed.enabled ?? true,
      guildId: parsed.guildId ?? null,
      exclude: parsed.exclude ?? [],
      extra: parsed.extra ?? [],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`discord channel: commands.json unreadable, using defaults: ${err}\n`)
      return defaultConfig()
    }
    const cfg = defaultConfig()
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
      const tmp = COMMANDS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, COMMANDS_FILE)
    } catch {}
    return cfg
  }
}

// --- skill discovery ---------------------------------------------------

/** Parse name/description out of SKILL.md YAML frontmatter. Single-line
 * values only — enough for command registration, not a YAML parser. */
function parseFrontmatter(path: string): { name?: string; description?: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm) return {}
  const out: { name?: string; description?: string } = {}
  for (const key of ['name', 'description'] as const) {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm[1])
    if (m) out[key] = m[1].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function scanSkillsDir(dir: string, prefix: string): SkillEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: SkillEntry[] = []
  for (const sub of entries) {
    const fm = parseFrontmatter(join(dir, sub, 'SKILL.md'))
    if (!fm.description && !fm.name) continue
    const name = fm.name ?? sub
    out.push({
      skill: prefix ? `${prefix}:${name}` : name,
      command: name, // sanitized later
      description: fm.description ?? 'Claude Code skill',
    })
  }
  return out
}

/** Enabled plugins per settings.json; install paths per installed_plugins.json. */
function pluginSkillDirs(): Array<{ plugin: string; dir: string }> {
  let installed: Record<string, Array<{ installPath: string }>> = {}
  let enabled: Record<string, boolean> = {}
  try {
    installed = JSON.parse(readFileSync(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
  } catch {
    return []
  }
  try {
    enabled = JSON.parse(readFileSync(join(CLAUDE_DIR, 'settings.json'), 'utf8')).enabledPlugins ?? {}
  } catch {}
  const out: Array<{ plugin: string; dir: string }> = []
  for (const [key, installs] of Object.entries(installed)) {
    if (enabled[key] === false) continue
    const plugin = key.split('@')[0]
    const path = installs[0]?.installPath
    if (plugin && path) out.push({ plugin, dir: join(path, 'skills') })
  }
  return out
}

function matchesGlob(value: string, pattern: string): boolean {
  if (!pattern.includes('*')) return value === pattern
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(value)
}

function sanitizeCommandName(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  if (!base) base = 'skill'
  let candidate = base
  for (let i = 2; taken.has(candidate); i++) candidate = `${base.slice(0, 29)}-${i}`
  taken.add(candidate)
  return candidate
}

export function discoverSkills(cfg: CommandsConfig): SkillEntry[] {
  const raw: SkillEntry[] = [
    ...BUILT_IN_COMMANDS,
    ...cfg.extra,
    ...scanSkillsDir(join(CLAUDE_DIR, 'skills'), ''),
    ...pluginSkillDirs().flatMap(({ plugin, dir }) => scanSkillsDir(dir, plugin)),
  ]
  const taken = new Set<string>()
  const bySkill = new Map<string, SkillEntry>()
  for (const entry of raw) {
    if (bySkill.has(entry.skill)) continue
    if (BLOCKED_SKILLS.some(re => re.test(entry.skill))) continue
    if (cfg.exclude.some(p => matchesGlob(entry.skill, p))) continue
    bySkill.set(entry.skill, {
      skill: entry.skill,
      command: sanitizeCommandName(entry.command, taken),
      description: entry.description.slice(0, 100) || 'Claude Code skill',
      ...(entry.prompt ? { prompt: entry.prompt } : {}),
    })
  }
  return [...bySkill.values()]
}

// --- registration ------------------------------------------------------

/** Discord caps an app at 100 global commands. Keep headroom for /skill. */
const MAX_DEDICATED_COMMANDS = 99

export function isBlockedSkill(skill: string): boolean {
  return BLOCKED_SKILLS.some(re => re.test(skill))
}

function buildCommandData(skills: SkillEntry[]): ApplicationCommandDataResolvable[] {
  const dedicated = skills.slice(0, MAX_DEDICATED_COMMANDS)
  if (skills.length > dedicated.length) {
    process.stderr.write(
      `discord channel: ${skills.length} skills exceed Discord's command cap — ` +
      `${skills.length - dedicated.length} only reachable via /skill\n`,
    )
  }
  const argsOption = {
    type: ApplicationCommandOptionType.String as const,
    name: 'args',
    description: 'Arguments or prompt to pass to the skill',
    required: false,
  }
  return [
    {
      name: 'skill',
      description: 'Run any installed Claude Code skill by name',
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Skill to run',
          required: true,
          autocomplete: true,
        },
        argsOption,
      ],
    },
    ...dedicated.map(s => ({
      name: s.command,
      description: s.description,
      options: [argsOption],
    })),
  ]
}

function manifestHash(data: ApplicationCommandDataResolvable[], scope: string): string {
  return createHash('sha256').update(scope + JSON.stringify(data)).digest('hex')
}

/** Bulk-overwrite application commands when the discovered set changed.
 * Returns the active skill map (command name → entry) for interaction lookup. */
export async function syncSlashCommands(client: Client<true>): Promise<Map<string, SkillEntry>> {
  const cfg = loadCommandsConfig()
  const skills = cfg.enabled ? discoverSkills(cfg) : []
  const byCommand = new Map(skills.map(s => [s.command, s]))
  if (!cfg.enabled) return byCommand

  const data = buildCommandData(skills)
  const scope = cfg.guildId ?? 'global'
  const hash = manifestHash(data, scope)
  try {
    const prev = JSON.parse(readFileSync(REGISTERED_FILE, 'utf8'))
    if (prev.hash === hash) {
      process.stderr.write(`discord channel: slash commands unchanged (${skills.length} skills)\n`)
      return byCommand
    }
  } catch {}

  try {
    if (cfg.guildId) {
      const guild = await client.guilds.fetch(cfg.guildId)
      await guild.commands.set(data)
      // A stale global set would shadow guild commands with duplicates.
      await client.application.commands.set([])
    } else {
      await client.application.commands.set(data)
    }
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(REGISTERED_FILE, JSON.stringify({ hash, scope, count: data.length, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    process.stderr.write(`discord channel: registered ${data.length} slash commands (${scope})\n`)
  } catch (err) {
    process.stderr.write(`discord channel: slash command registration failed: ${err}\n`)
  }
  return byCommand
}
