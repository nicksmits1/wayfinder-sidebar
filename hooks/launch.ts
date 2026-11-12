// Building the handoff prompt and the commands that open a new session. Pure strings.
import type { Ticket, WfMap } from '../types'
import { appleQuote, shellQuote } from './tracker'

export const mapRef = (m: WfMap) => (m.tracker === 'local' ? m.relPath ?? m.key : m.url ?? m.key)
export const ticketRef = (t: Ticket) => t.id

/** What ▶ asks a new session to do on a plain plan's ticket. `{ticket}` and `{plan}` are paths relative to the root. */
export const DEFAULT_PLAN_PROMPT =
  'Work on the ticket {ticket} from the plan in {plan}/. Read the other tickets in that folder for context, then do this one and tick its checklist as you go.'

/** A plan ticket's file relative to the session root: the plan's relPath plus the file's place under the plan folder. */
export function ticketPath(m: WfMap, t: Ticket): string {
  const base = m.relPath ?? m.key
  if (!t.path) return `${base}/${t.id}`
  return t.path.startsWith(`${m.key}/`) ? `${base}/${t.path.slice(m.key.length + 1)}` : t.path
}

function planBase(m: WfMap, t: Ticket, template: string): string {
  const plan = m.relPath ?? m.key
  return template.split('{ticket}').join(ticketPath(m, t)).split('{plan}').join(plan)
}

/** The skill body without its frontmatter, minus the line about where to save (the mod picks the path). */
export function handoffRules(skillText: string | undefined): string {
  if (!skillText) {
    return [
      'Include a "Suggested skills" section naming which skills the next agent should call.',
      'Do not duplicate what is already in the map, tickets, specs, commits or diffs: reference them by path or URL.',
      'Redact sensitive information such as API keys, passwords or personal data.',
    ].join('\n')
  }
  const body = skillText.startsWith('---') ? skillText.slice(skillText.indexOf('\n---', 3) + 4) : skillText
  return body
    .split('\n')
    .filter(l => !/save to|temporary directory/i.test(l))
    .join('\n')
    .trim()
}

export function handoffPrompt(m: WfMap, tickets: readonly Ticket[], path: string, skillText: string | undefined): string {
  const list = tickets.map(t => `- ${t.id} ${t.title}`).join('\n')
  const many = tickets.length > 1
  return [
    `The wayfinder sidebar is about to start ${many ? `${tickets.length} new sessions` : 'a new session'} on the map "${m.title}" (${mapRef(m)}):`,
    list,
    '',
    `Before they start, write a handoff note for ${many ? 'them' : 'it'} from what you learned in this session.`,
    `Save it to exactly this path, creating folders as needed: ${path}`,
    many
      ? 'Use one section per ticket, headed "## <id> <title>", so each new session reads only its own section.'
      : 'Head it "## <id> <title>".',
    'In each section: what you found here that matters for that ticket, decisions or constraints it must respect, open threads, and what to read first.',
    'Keep it short. Do not start work on the tickets yourself, and do not claim them.',
    '',
    'Rules for the note (from the handoff skill):',
    handoffRules(skillText),
    '',
    'When the file is saved, reply with one line saying so.',
  ].join('\n')
}

export function sessionPrompt(m: WfMap, t: Ticket, handoffPath: string | undefined, planPrompt: string = DEFAULT_PLAN_PROMPT): string {
  const base = m.kind === 'plan' ? planBase(m, t, planPrompt) : `/wayfinder ${mapRef(m)} ${ticketRef(t)}`
  if (!handoffPath) return base
  return `${base}  Context from the session that launched this one: read the "## ${t.id}" section of ${handoffPath} before anything else.`
}

/**
 * The plan ticket a prompt starts work on: only a prompt that begins with exactly what ▶ sends for
 * an open plan ticket counts, so mentioning a ticket's file in passing claims nothing.
 */
export function planTicket(text: string, maps: readonly WfMap[], planPrompt: string = DEFAULT_PLAN_PROMPT): { mapKey: string; id: string } | undefined {
  const s = text.trim()
  for (const m of maps) {
    if (m.kind !== 'plan') continue
    for (const t of m.tickets) {
      if (t.closed) continue
      const base = planBase(m, t, planPrompt)
      if (s === base || s.startsWith(`${base} `)) return { mapKey: m.key, id: t.id }
    }
  }
  return undefined
}

/**
 * The ticket a `/wayfinder <map> <ticket>` session works on, read from the command's arguments
 * (the inverse of sessionPrompt). Only an exact map reference followed by an open ticket's id counts.
 */
export function sessionTicket(args: string, maps: readonly WfMap[]): { mapKey: string; id: string } | undefined {
  const [ref, id] = args.trim().split(/\s+/)
  if (!ref || !id) return undefined
  const m = maps.find(x => mapRef(x) === ref)
  const t = m?.tickets.find(x => ticketRef(x) === id)
  return m && t && !t.closed ? { mapKey: m.key, id: t.id } : undefined
}

export function shellCommand(root: string, prompt: string): string {
  return `cd ${shellQuote(root)} && claude ${shellQuote(prompt)}`
}

export type Launcher = 'iterm' | 'terminal' | 'copy'

/** osascript argv for a new tab running `cmd`. */
export function launchArgv(launcher: Launcher, cmd: string): string[] | undefined {
  if (launcher === 'iterm') {
    return [
      'osascript',
      '-e', 'tell application "iTerm"',
      '-e', 'activate',
      '-e', 'if (count of windows) = 0 then',
      '-e', 'create window with default profile',
      '-e', 'else',
      '-e', 'tell current window to create tab with default profile',
      '-e', 'end if',
      '-e', `tell current session of current window to write text ${appleQuote(cmd)}`,
      '-e', 'end tell',
    ]
  }
  if (launcher === 'terminal') {
    return ['osascript', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${appleQuote(cmd)}`, '-e', 'end tell']
  }
  return undefined
}

const two = (n: number) => String(n).padStart(2, '0')
export function handoffFile(tmp: string, m: WfMap, ids: readonly string[], now: number): string {
  const d = new Date(now)
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  const slug = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'map'
  const idPart = ids.map(i => i.replace('#', '')).join('-').slice(0, 40)
  return `${tmp.replace(/\/$/, '')}/wayfinder-handoffs/${slug}-${idPart}-${stamp}.md`
}

/** `uname -s` output: "Darwin" on macOS, "Linux" on Linux. */
export const isMac = (platform: string) => platform === 'Darwin'

/** iTerm and Terminal.app exist only on macOS; elsewhere launches fall back to copying the command. */
export function effectiveLauncher(launcher: Launcher, platform: string): Launcher {
  return launcher === 'copy' || isMac(platform) ? launcher : 'copy'
}

/** argv that opens a ticket file or issue URL: the configured editor for files, else the system opener. */
export function openArgv(target: string, editor: string, platform: string): string[] {
  if (editor && !/^https?:\/\//.test(target)) return [...editor.split(/\s+/), target]
  return [isMac(platform) ? 'open' : 'xdg-open', target]
}
