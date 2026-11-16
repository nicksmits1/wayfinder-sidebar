// Pure parsing and status logic for wayfinder maps. No `$` in here, so it is easy to test.
import type { Ticket, TicketType, WfMap } from '../types'

export const TYPES: readonly TicketType[] = ['grilling', 'prototype', 'research', 'task']

export function normalizeType(raw: string | undefined): TicketType {
  const v = (raw ?? '').toLowerCase().replace(/^wayfinder:/, '').trim()
  for (const t of TYPES) if (v.startsWith(t)) return t
  return 'unknown'
}

// grilling and prototype are always HITL, research always AFK; tasks default to AFK.
export function defaultHitl(type: TicketType, explicit: boolean | undefined): boolean {
  if (type === 'grilling' || type === 'prototype') return true
  if (type === 'research') return false
  return explicit === true
}

/** "02-extra-properties.md" → "02", "2" → "02", "#57" stays "#57". */
export function localId(ref: string): string {
  const s = ref.trim().replace(/^\.\/|^tickets\/|^issues\//, '')
  const m = /^(\d+)/.exec(s)
  return m?.[1] ? m[1].padStart(2, '0') : s
}

function splitList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  return inner.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

type Front = Record<string, string | string[]>

/** A small YAML-ish frontmatter reader: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines. */
export function readFrontmatter(text: string): { front: Front; body: string } {
  if (!text.startsWith('---')) return { front: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { front: {}, body: text }
  const front: Front = {}
  let listKey: string | null = null
  for (const line of text.slice(3, end).split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const cur = front[listKey]
      front[listKey] = [...(Array.isArray(cur) ? cur : []), (item[1] ?? '').trim()]
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] ?? ''
    const value = kv[2] ?? ''
    listKey = null
    if (value === '') { front[key] = []; listKey = key }
    else if (value.startsWith('[')) front[key] = splitList(value)
    else front[key] = value.trim().replace(/^["']|["']$/g, '')
  }
  return { front, body: text.slice(text.indexOf('\n', end + 1) + 1) }
}

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v ?? '')

/**
 * One ticket file. Accepts both shapes seen in the wild:
 * - frontmatter: title / type / status / assignee / blocked_by (/ hitl)
 * - the skill doc's: "# Title", "Type: …", "Status: claimed|resolved", "Blocked by: 01, 02"
 */
export function parseLocalTicket(fileName: string, text: string, path: string): Ticket {
  const { front, body } = readFrontmatter(text)
  const line = (name: string) => {
    const m = new RegExp(`^\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im').exec(body)
    return m?.[1] ? m[1].trim() : undefined
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const slugTitle = fileName.replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ')
  const title = str(front.title) || heading || slugTitle
  const typeRaw = str(front.type) || line('Type')
  const type = normalizeType(typeRaw)
  const statusRaw = (str(front.status) || line('Status') || 'open').toLowerCase()
  const closed = /closed|resolved|done|complete/.test(statusRaw)
  const assignee = str(front.assignee) || (/claimed/.test(statusRaw) ? 'claimed' : '')
  const blockedRaw = front.blocked_by ?? front.blockedBy ?? line('Blocked by')
  const blockedBy = (Array.isArray(blockedRaw) ? blockedRaw : splitList(blockedRaw ?? ''))
    .filter(b => !/^(none|-|\[\])$/i.test(b))
    .map(localId)
  const hitlFlag = str(front.hitl).toLowerCase() === 'true' || /\bHITL\b/.test(typeRaw ?? '')
  const warnings: string[] = []
  if (type === 'unknown') warnings.push('no ticket type found')
  return {
    id: localId(fileName),
    title,
    type,
    hitl: defaultHitl(type, hitlFlag),
    closed,
    assignee: closed ? '' : assignee,
    blockedBy,
    path,
    warning: warnings.join('; ') || undefined,
  }
}

function section(body: string, name: string): string {
  const re = new RegExp(`^##\\s+${name}\\s*$`, 'im')
  const m = re.exec(body)
  if (!m) return ''
  const rest = body.slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).replace(/<!--[\s\S]*?-->/g, '')
}
const bullets = (s: string) => s.split('\n').map(l => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x)

export type MapHeader = Pick<WfMap, 'title' | 'destination' | 'fog' | 'decisions'>

export function parseMapBody(text: string, fallbackTitle: string): MapHeader {
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? fallbackTitle).replace(/^Map:\s*/i, '').trim()
  const dest = section(text, 'Destination').split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
  const fogText = section(text, 'Not yet specified')
  const fog = bullets(fogText)
  const firstFogLine = fogText.split('\n').map(l => l.trim()).filter(Boolean)[0]
  return {
    title,
    destination: dest,
    fog: fog.length ? fog : firstFogLine ? [firstFogLine] : [],
    decisions: bullets(section(text, 'Decisions so far')).length,
  }
}

// ---------- GitHub ----------

export type GhIssue = {
  number: number
  title: string
  state: string
  html_url?: string
  url?: string
  body?: string | null
  labels?: ({ name?: string } | string)[]
  assignees?: { login: string }[]
}

const labelNames = (i: GhIssue) => (i.labels ?? []).map(l => (typeof l === 'string' ? l : l.name ?? ''))

/** Blockers from GitHub's native dependencies when given, else a "Blocked by: #1, #2" body line. */
export function ghTicket(i: GhIssue, nativeBlockers: number[] | undefined): Ticket {
  const labels = labelNames(i)
  const type = normalizeType(labels.find(l => l.startsWith('wayfinder:') && l !== 'wayfinder:map' && l !== 'wayfinder:hitl'))
  const body = i.body ?? ''
  const bodyBlockers = /^\s*Blocked by:\s*(.+)$/im.exec(body)?.[1]?.match(/#\d+/g)?.map(x => Number(x.slice(1))) ?? []
  const blockers = nativeBlockers ?? bodyBlockers
  const hitlFlag = labels.includes('wayfinder:hitl') || /^\s*hitl:\s*true\s*$/im.test(body)
  return {
    id: `#${i.number}`,
    title: i.title,
    type,
    hitl: defaultHitl(type, hitlFlag),
    closed: i.state.toLowerCase() === 'closed',
    assignee: i.assignees?.[0]?.login ?? '',
    blockedBy: blockers.map(n => `#${n}`),
    url: i.html_url ?? i.url,
    warning: type === 'unknown' ? 'no wayfinder:<type> label' : undefined,
  }
}

/** Child issues listed as a task list in the map body: "- [ ] #12". */
export function taskListNumbers(body: string): number[] {
  return [...body.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+.*?#(\d+)/gm)].map(m => Number(m[1]))
}

// GitHub is read over GraphQL: a map's children and their blockers arrive in one request. The REST
// sub-issue and dependency endpoints take a request per ticket and have a small rate limit of their own.

/** An issue as the queries below return it. */
export type GqlIssue = {
  number: number
  title: string
  state: string
  url?: string
  body?: string | null
  labels?: { nodes?: ({ name?: string } | null)[] | null } | null
  assignees?: { nodes?: ({ login: string } | null)[] | null } | null
  blockedBy?: { nodes?: ({ number: number } | null)[] | null } | null
}

const issueFields = (deps: boolean) =>
  `number title state url body labels(first:30){nodes{name}} assignees(first:5){nodes{login}}${deps ? ' blockedBy(first:50){nodes{number}}' : ''}`

/** A map issue's sub-issues, 100 a page. Variables: owner, name, number, after. */
export const SUB_ISSUES_QUERY =
  `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){subIssues(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${issueFields(true)}}}}}}`

/** The issues with these numbers (a map's task list). `deps` leaves out native blockers for a GitHub without them. Variables: owner, name. */
export const issuesQuery = (numbers: readonly number[], deps: boolean) =>
  `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map(n => `i${n}:issue(number:${n}){${issueFields(deps)}}`).join(' ')}}}`

const nodes = <T>(c: { nodes?: (T | null)[] | null } | null | undefined): T[] => (c?.nodes ?? []).filter((x): x is T => x != null)

export function subIssuesPage(data: unknown): { issues: GqlIssue[]; next?: string } {
  const issue = (data as { repository?: { issue?: { subIssues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (GqlIssue | null)[] } | null } | null } | null } | null)?.repository?.issue
  if (!issue) throw new Error('the map issue was not found')
  const page = issue.subIssues?.pageInfo
  return { issues: nodes(issue.subIssues), next: page?.hasNextPage && page.endCursor ? page.endCursor : undefined }
}

/** What `issuesQuery` found, in the order asked for; a number that names no issue (a pull request, say) is left out. */
export function issuesByNumber(data: unknown, numbers: readonly number[]): GqlIssue[] {
  const repo = (data as { repository?: Record<string, GqlIssue | null> | null } | null)?.repository ?? {}
  return numbers.map(n => repo[`i${n}`]).filter((x): x is GqlIssue => x != null)
}

/** A ticket from a GraphQL issue. With no native blockers, a "Blocked by: #n" body line counts. */
export function gqlTicket(i: GqlIssue): Ticket {
  const native = nodes(i.blockedBy).map(b => b.number)
  return ghTicket({ ...i, labels: nodes(i.labels), assignees: nodes(i.assignees) }, native.length ? native : undefined)
}

// ---------- status ----------

export type Status = 'closed' | 'claimed' | 'launching' | 'blocked' | 'ready'

export function openBlockers(t: Ticket, all: readonly Ticket[]): string[] {
  const byId = new Map(all.map(x => [x.id, x]))
  // A blocker id that names no ticket is ignored rather than blocking forever.
  return t.blockedBy.filter(b => byId.has(b) && !byId.get(b)!.closed)
}

/** `held`: ids a session works on before its claim reaches the ticket (from its `/wayfinder` prompt). */
export function statusOf(t: Ticket, all: readonly Ticket[], launching: ReadonlySet<string>, held: ReadonlySet<string> = new Set()): Status {
  if (t.closed) return 'closed'
  if (t.assignee || held.has(t.id)) return 'claimed'
  if (launching.has(t.id)) return 'launching'
  return openBlockers(t, all).length ? 'blocked' : 'ready'
}

export function unblocks(t: Ticket, all: readonly Ticket[]): Ticket[] {
  return all.filter(x => !x.closed && x.blockedBy.includes(t.id))
}

/**
 * What closing `t` unblocks, for the detail line: the ticket to tackle next (one that becomes
 * ready once `t` closes, else the first that still waits on something else), and how many more.
 */
export function nextUnblocked(t: Ticket, all: readonly Ticket[]): { next?: Ticket; alsoWaits: string[]; more: number } {
  const rest = (x: Ticket) => openBlockers(x, all).filter(b => b !== t.id)
  const byId = (a: Ticket, b: Ticket) => a.id.localeCompare(b.id, undefined, { numeric: true })
  const u = unblocks(t, all).sort((a, b) => rest(a).length - rest(b).length || byId(a, b))
  const next = u[0]
  return { next, alsoWaits: next ? rest(next) : [], more: Math.max(0, u.length - 1) }
}

/** Ids that are ready now but were not ready before: the tickets a resolution just unblocked. */
export function newlyReady(before: readonly Ticket[], after: readonly Ticket[]): string[] {
  const none = new Set<string>()
  const was = new Set(before.filter(t => statusOf(t, before, none) === 'ready').map(t => t.id))
  const known = new Set(before.map(t => t.id))
  return after.filter(t => statusOf(t, after, none) === 'ready' && known.has(t.id) && !was.has(t.id)).map(t => t.id)
}

// ---------- text helpers ----------

export const fit = (s: string, n: number) =>
  n <= 0 ? '' : s.length <= n ? s.padEnd(n) : s.slice(0, Math.max(0, n - 1)) + '…'

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const appleQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Markdown emphasis, code and links reduced to their text: "**a** [b](c) `d`" → "a b d". */
export const plainText = (s: string) =>
  s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** Word-wrap to at most `max` lines of `width` cells; the last line ends in … when text is left over. */
export function wrapLines(s: string, width: number, max: number): string[] {
  const w = Math.max(2, width)
  // Words longer than a line are split into line-sized pieces.
  const words = s.split(' ').filter(Boolean).flatMap(x => x.match(new RegExp(`.{1,${w}}`, 'gu')) ?? [])
  const lines: string[] = []
  let k = 0
  while (k < words.length && lines.length < max) {
    let line = words[k++]!
    while (k < words.length && line.length + 1 + words[k]!.length <= w) line += ' ' + words[k++]
    lines.push(line)
  }
  if (k < words.length) {
    const last = lines.pop() ?? ''
    lines.push((last.length < w ? last : last.slice(0, w - 1).trimEnd()) + '…')
  }
  return lines
}

// ---------- context budget ----------

/** 92_400 → "92k", 1_250_000 → "1.3M", undefined → "–". */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '–'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export type Level = 'ok' | 'warn' | 'over'

/** How full a session is against the per-session budget: under 60% ok, under 100% warn, else over. */
export function budgetLevel(tokens: number | undefined, budget: number): Level {
  const f = (tokens ?? 0) / Math.max(1, budget)
  return f >= 1 ? 'over' : f >= 0.6 ? 'warn' : 'ok'
}

const EIGHTHS = ' ▏▎▍▌▋▊▉'
/** A bar `width` cells wide: filled with eighth-blocks for tokens/budget, the rest as the track. */
export function budgetBar(tokens: number | undefined, budget: number, width: number): { fill: string; track: string } {
  const w = Math.max(1, width)
  const cells = Math.min(1, Math.max(0, (tokens ?? 0) / Math.max(1, budget))) * w
  const whole = Math.floor(cells)
  const part = Math.round((cells - whole) * 8)
  const fill = '█'.repeat(whole) + (whole < w && part ? EIGHTHS[part] ?? '' : '')
  return { fill, track: '░'.repeat(w - fill.length) }
}
