import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ctx, Flash, Flow, Launch, Ticket, WfMap } from '../types'
import {
  budgetBar,
  budgetLevel,
  fit,
  fmtTokens,
  gqlTicket,
  issuesByNumber,
  issuesQuery,
  localId,
  newlyReady,
  nextUnblocked,
  openBlockers,
  parseLocalTicket,
  parseMapBody,
  plainText,
  statusOf,
  subIssuesPage,
  SUB_ISSUES_QUERY,
  taskListNumbers,
  wrapLines,
  type GqlIssue,
  type Status,
} from './tracker'
import { effectiveLauncher, handoffFile, handoffPrompt, launchArgv, mapRef, openArgv, sessionPrompt, sessionTicket, shellCommand, ticketRef, type Launcher } from './launch'

const P = 'wayfinder-sidebar'
const PANE = 'wayfinder'
const TICK_MS = 150
const LAUNCH_TTL_MS = 10 * 60 * 1000
const FLASH_MS = 1600
const GH_BACKOFF_MAX_MS = 15 * 60 * 1000
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

// Change a shape tag when that value's fields change: it declines what an earlier version stored.
const mapsA = atom({ plugin: 'wayfinder-sidebar', key: 'maps' } as const, [] as WfMap[], { shape: 'maps-1' })
const activeA = atom({ plugin: 'wayfinder-sidebar', key: 'active' } as const, '')
const selA = atom({ plugin: 'wayfinder-sidebar', key: 'sel' } as const, '')
const flowA = atom({ plugin: 'wayfinder-sidebar', key: 'flow' } as const, null as Flow | null, { shape: 'flow-1' })
const pickedA = atom({ plugin: 'wayfinder-sidebar', key: 'picked' } as const, [] as string[])
const launchesA = atom({ plugin: 'wayfinder-sidebar', key: 'launches' } as const, [] as Launch[], { shape: 'launches-1' })
const flashA = atom({ plugin: 'wayfinder-sidebar', key: 'flash' } as const, null as Flash | null, { shape: 'flash-1' })
const mineA = atom({ plugin: 'wayfinder-sidebar', key: 'mine' } as const, [] as string[])
// The ticket this session was started on with `/wayfinder <map> <ticket>`, held before its claim lands in the file.
const workingA = atom({ plugin: 'wayfinder-sidebar', key: 'working' } as const, [] as string[])
const peersA = atom({ plugin: 'wayfinder-sidebar', key: 'peers' } as const, {} as Record<string, string>, { shape: 'peers-1' })
const showDoneA = atom({ plugin: 'wayfinder-sidebar', key: 'showDone' } as const, false)
const spinA = atom({ plugin: 'wayfinder-sidebar', key: 'spin' } as const, 0)
const contextsA = atom({ plugin: 'wayfinder-sidebar', key: 'contexts' } as const, [] as Ctx[], { shape: 'contexts-1' })
const selfCtxA = atom({ plugin: 'wayfinder-sidebar', key: 'selfCtx' } as const, null as { tokens?: number; window: number } | null, { shape: 'selfctx-1' })

// Colors: Tokyo Night (LazyVim). Row tints are each type color mixed 34% into the pane's grey (#262626).
const COLOR = { grilling: '#f7768e', prototype: '#bb9af7', research: '#7dcfff', task: '#ff9e64', unknown: '#a9b1d6' } as const
const TINT = { grilling: '#6d4149', prototype: '#594d6d', research: '#445f70', task: '#704f3b', unknown: '#535562' } as const
const WORD = { grilling: 'grill', prototype: 'proto', research: 'rsrch', task: 'task', unknown: '?' } as const
const INK = '#16161e'
const TEXT = '#c0caf5'
const DIM = '#737aa2'
const GREEN = '#9ece6a'
const FLASH_TINT = '#5c7245'
const BLUE = '#7aa2f7'
const YELLOW = '#e0af68'
const BTN = '#3b4261'
const BANNER = '#292e42'
const RED = '#db4b4b'
const LEVEL = { ok: GREEN, warn: YELLOW, over: RED } as const

type Opts = { launcher: Launcher; editor: string; pollSeconds: number; githubSeconds: number; contextBudget: number }

let opts: Opts = { launcher: 'iterm', editor: '', pollSeconds: 3, githubSeconds: 45, contextBudget: 200_000 }

function readOptions(options: unknown): Opts {
  const o = (options ?? {}) as Partial<Opts>
  return {
    launcher: o.launcher === 'terminal' || o.launcher === 'copy' ? o.launcher : 'iterm',
    editor: typeof o.editor === 'string' ? o.editor.trim() : '',
    pollSeconds: typeof o.pollSeconds === 'number' && o.pollSeconds > 0 ? o.pollSeconds : 3,
    githubSeconds: typeof o.githubSeconds === 'number' && o.githubSeconds >= 10 ? o.githubSeconds : 45,
    contextBudget: typeof o.contextBudget === 'number' && o.contextBudget >= 1000 ? o.contextBudget : 200_000,
  }
}

type Dollar = EngineInterface
// Module variables start over on a reload; everything drawn lives in $.state.
let root = ''
let sessionId = ''
let tmp = '/tmp'
let platform = '' // `uname -s`: Darwin, Linux, …
let skillText: string | undefined
let ghRepo: string | null | undefined // undefined: not checked yet; null: none
let ghAt = 0 // when the GitHub maps shown were last asked for, by this tab or another
let ghFails = 0 // failed reads in a row; each one doubles the wait before the next
let ghMaps: WfMap[] = []
let busy = false
let pendingWork: string | undefined // `/wayfinder` arguments waiting for the maps to load
let tick = 0
let focused: string | undefined // key of the pane element holding the focus ring
const localSig = new Map<string, { sig: string; map: WfMap }>()

// ---------- loading ----------

async function loadLocal($: Dollar): Promise<WfMap[]> {
  const scratch = `${root}/.scratch`
  if (!(await $.fs.exists(scratch))) return []
  const out: WfMap[] = []
  for (const dir of await $.fs.list(scratch)) {
    if (dir.kind !== 'dir') continue
    const base = `${scratch}/${dir.name}`
    const mapPath = `${base}/map.md`
    if (!(await $.fs.exists(mapPath))) continue
    let ticketDir = ''
    for (const name of ['tickets', 'issues']) if (await $.fs.exists(`${base}/${name}`)) { ticketDir = `${base}/${name}`; break }
    const files = ticketDir ? (await $.fs.list(ticketDir)).filter(f => f.kind === 'file' && f.name.endsWith('.md')) : []
    const mapStat = await $.fs.stat(mapPath)
    const sig = `${mapStat.mtimeMs}|${files.map(f => `${f.name}:${f.mtimeMs}`).join(',')}`
    const cached = localSig.get(mapPath)
    if (cached && cached.sig === sig) { out.push(cached.map); continue }
    try {
      const header = parseMapBody(await $.fs.read(mapPath), dir.name)
      const tickets: Ticket[] = []
      for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${ticketDir}/${f.name}`
        try { tickets.push(parseLocalTicket(f.name, await $.fs.read(path), path)) }
        catch { tickets.push({ id: localId(f.name), title: f.name, type: 'unknown', hitl: false, closed: false, assignee: '', blockedBy: [], path, warning: 'could not read the file' }) }
      }
      const map: WfMap = { key: mapPath, tracker: 'local', relPath: `.scratch/${dir.name}/map.md`, ...header, tickets }
      localSig.set(mapPath, { sig, map })
      out.push(map)
    } catch (err) {
      out.push({ key: mapPath, tracker: 'local', relPath: `.scratch/${dir.name}/map.md`, title: dir.name, destination: '', fog: [], decisions: 0, tickets: [], error: String(err) })
    }
  }
  return out
}

async function gh($: Dollar, args: string[]): Promise<unknown> {
  const r = await $.process.run(['gh', ...args], { cwd: root, timeoutMs: 20000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `gh ${args[0]} failed`)
  return JSON.parse(r.stdout)
}

/** One GraphQL request. `partial` accepts an answer that came with errors, such as a number that names no issue. */
async function ghQuery($: Dollar, repo: string, query: string, vars: Record<string, string | number> = {}, partial = false): Promise<unknown> {
  const [owner = '', name = ''] = repo.split('/')
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  const r = await $.process.run(['gh', ...args], { cwd: root, timeoutMs: 20000 })
  let data: unknown
  try { data = (JSON.parse(r.stdout) as { data?: unknown }).data } catch { /* no answer */ }
  if (data == null || (r.exitCode !== 0 && !partial)) throw new Error(r.stderr.trim() || 'gh api graphql failed')
  return data
}

/** A map's tickets: its sub-issues, else the task list in its body. */
async function loadChildren($: Dollar, repo: string, number: number, body: string): Promise<GqlIssue[]> {
  let children: GqlIssue[] = []
  let failed: unknown
  try {
    let after: string | undefined
    for (let page = 0; page < 10; page++) {
      const r = subIssuesPage(await ghQuery($, repo, SUB_ISSUES_QUERY, after ? { number, after } : { number }))
      children.push(...r.issues)
      if (!(after = r.next)) break
    }
  } catch (err) { children = []; failed = err }
  if (children.length) return children
  const listed = taskListNumbers(body)
  if (!listed.length) {
    if (failed) throw failed
    return []
  }
  // A GitHub that could not answer for sub-issues is not asked for native blockers either.
  return issuesByNumber(await ghQuery($, repo, issuesQuery(listed, !failed), {}, true), listed)
}

/** The repository's open maps. A map that could not be read keeps the tickets it had in `prev`, with the error. */
async function loadGithub($: Dollar, prev: readonly WfMap[]): Promise<WfMap[]> {
  if (!ghRepo) return []
  const repo = ghRepo
  const mapIssues = (await gh($, ['issue', 'list', '--repo', repo, '--label', 'wayfinder:map', '--state', 'open', '--json', 'number,title,url,body', '--limit', '20'])) as { number: number; title: string; url: string; body: string }[]
  const out: WfMap[] = []
  for (const mi of mapIssues) {
    const key = `github:${repo}#${mi.number}`
    const map = { key, tracker: 'github' as const, url: mi.url, repo, number: mi.number, ...parseMapBody(`# ${mi.title}\n${mi.body ?? ''}`, mi.title) }
    try { out.push({ ...map, tickets: (await loadChildren($, repo, mi.number, mi.body ?? '')).map(gqlTicket) }) }
    catch (err) { out.push({ ...map, tickets: prev.find(m => m.key === key)?.tickets ?? [], error: errorText(err) }) }
  }
  return out
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^gh:\s*/, '')

/** What the tabs share under `github:<owner>/<repo>`: the last read of that repository's maps, by whichever tab made it. */
type GhShared = { at: number; maps: WfMap[]; fails?: number }

const readShared = (v: unknown): GhShared | undefined => {
  const r = v as Partial<GhShared> | null | undefined
  return r && typeof r.at === 'number' && Array.isArray(r.maps) ? { at: r.at, maps: r.maps, fails: r.fails } : undefined
}

/**
 * Keeps `ghMaps` current. The tabs of one repository share a read through the store, so GitHub is
 * asked once per `githubSeconds` however many tabs are open, and a failed read doubles the wait.
 */
async function refreshGithub($: Dollar, now: number, force: boolean) {
  if (ghRepo === undefined) {
    try {
      const r = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: root, timeoutMs: 15000 })
      ghRepo = r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null
    } catch { ghRepo = null }
  }
  if (!ghRepo) return
  const storeKey = `github:${ghRepo}`
  const shared = readShared(await $.store.get(storeKey).catch(() => undefined))
  if (shared && shared.at > ghAt) { ghAt = shared.at; ghFails = shared.fails ?? 0; ghMaps = shared.maps }
  const wait = Math.min(opts.githubSeconds * 1000 * 2 ** ghFails, Math.max(GH_BACKOFF_MAX_MS, opts.githubSeconds * 1000))
  if (!force && now - ghAt <= wait) return
  // Stamp the store first, so the other tabs wait for this read instead of starting their own.
  ghAt = now
  await $.store.set(storeKey, { at: now, maps: ghMaps, fails: ghFails } satisfies GhShared).catch(() => undefined)
  let failed: boolean
  try { ghMaps = await loadGithub($, ghMaps); failed = ghMaps.some(m => m.error) }
  catch (err) { ghMaps = ghMaps.map(m => ({ ...m, error: errorText(err) })); failed = true }
  ghFails = failed ? ghFails + 1 : 0
  // A later stamp than the one above, so the tabs that saw that one take this read too.
  ghAt = Math.max(await $.clock.now(), now + 1)
  await $.store.set(storeKey, { at: ghAt, maps: ghMaps, fails: ghFails } satisfies GhShared).catch(() => undefined)
}

async function refresh($: Dollar, opt: { github?: boolean } = {}) {
  if (busy || !root) return
  busy = true
  try {
    const now = await $.clock.now()
    const local = await loadLocal($)
    await refreshGithub($, now, opt.github === true)
    const next = [...local, ...ghMaps]
    const prev = await read($, mapsA)
    // Tickets a resolution just unblocked flash once.
    const fresh: string[] = []
    for (const m of next) {
      const before = prev.find(p => p.key === m.key)
      if (before) fresh.push(...newlyReady(before.tickets, m.tickets).map(id => `${m.key}|${id}`))
    }
    await update($, mapsA, () => next)
    await resolveWork($)
    if (fresh.length) await update($, flashA, () => ({ ids: fresh, until: now + FLASH_MS }))
    const active = await read($, activeA)
    const first = next[0]
    if (!next.some(m => m.key === active) && first) await update($, activeA, () => first.key)
    // A launch stops showing once its ticket is claimed, or after ten minutes.
    await update($, launchesA, ls => ls.filter(l => {
      const t = next.find(m => m.key === l.mapKey)?.tickets.find(x => x.id === l.id)
      return t && !t.assignee && !t.closed && now - l.at < LAUNCH_TTL_MS
    }))
    await syncPeers($, next)
    await cleanHandoffs($, next)
  } finally {
    busy = false
  }
}

// ---------- which tab holds which ticket ----------

/** What each tab running the mod keeps in the shared store under `peer:<session id>`. */
type PeerRecord = { claims: string[]; working?: string[]; tokens?: number; window?: number; at?: number }

const readPeer = (v: unknown): PeerRecord =>
  Array.isArray(v) ? { claims: v as string[] } : ((v ?? { claims: [] }) as PeerRecord) // 0.1.0 stored a bare list

async function publishSelf($: Dollar, claims: string[]) {
  if (!sessionId) sessionId = await $.session.id().catch(() => '') // cleared after a /clear
  if (!sessionId) return
  const self = await read($, selfCtxA)
  const working = await read($, workingA)
  const rec: PeerRecord = { claims, working, tokens: self?.tokens, window: self?.window, at: await $.clock.now() }
  await $.store.set(`peer:${sessionId}`, rec)
}

async function syncPeers($: Dollar, maps: WfMap[]) {
  const mine = await read($, mineA)
  const open = new Set<string>()
  for (const m of maps) for (const t of m.tickets) if (t.assignee && !t.closed) open.add(`${m.key}|${t.id}`)
  const notClosed = new Set<string>()
  for (const m of maps) for (const t of m.tickets) if (!t.closed) notClosed.add(`${m.key}|${t.id}`)
  const kept = mine.filter(k => open.has(k))
  if (kept.length !== mine.length) await update($, mineA, () => kept)
  await update($, workingA, ws => (ws.every(k => notClosed.has(k)) ? ws : ws.filter(k => notClosed.has(k))))
  await publishSelf($, kept)
  const labels: Record<string, string> = {}
  const contexts: Ctx[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('peer:') || key === `peer:${sessionId}`) continue
    const rec = readPeer(await $.store.get(key))
    const sid = key.slice(5)
    const live = [...new Set([...(rec.working ?? []).filter(k => notClosed.has(k)), ...rec.claims.filter(k => open.has(k))])]
    if (!live.length) { await $.store.delete(key); continue }
    for (const k of live) labels[k] = 'tab'
    if (rec.window) contexts.push({ who: sid.slice(0, 3), keys: live, tokens: rec.tokens, window: rec.window, at: rec.at ?? 0 })
  }
  await update($, peersA, () => labels)
  await update($, contextsA, () => contexts)
}

/** Ticket ids on map `m` that a session holds: this one's, by claim or by its `/wayfinder` prompt, and other tabs'. */
async function heldSet($: Dollar, m: WfMap): Promise<Set<string>> {
  const keys = [...(await read($, workingA)), ...Object.keys(await read($, peersA))]
  return new Set(keys.filter(k => k.startsWith(`${m.key}|`)).map(k => k.slice(m.key.length + 1)))
}

/**
 * Holds the ticket a `/wayfinder <map> <ticket>` prompt names, so this session shows it as its own
 * from the first turn. Skipped when the arguments name no open ticket, or another tab holds it.
 */
async function resolveWork($: Dollar) {
  if (pendingWork === undefined) return
  const maps = await read($, mapsA)
  if (!maps.length) return // not loaded yet: the next refresh tries again
  const hit = sessionTicket(pendingWork, maps)
  pendingWork = undefined
  if (!hit) return
  const key = `${hit.mapKey}|${hit.id}`
  if (key in (await read($, peersA))) return
  await update($, workingA, () => [key])
  await update($, activeA, () => hit.mapKey)
  await publishSelf($, await read($, mineA))
}

async function noteClaim($: Dollar, mapKey: string, id: string) {
  await update($, mineA, ms => (ms.includes(`${mapKey}|${id}`) ? ms : [...ms, `${mapKey}|${id}`]))
}

// ---------- handoffs ----------

type HandoffRecord = { path: string; mapKey: string; ids: string[]; at: number }

async function cleanHandoffs($: Dollar, maps: WfMap[]) {
  if (tick % 200 !== 0) return // every ~30s
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('handoff:')) continue
    const rec = (await $.store.get(key)) as HandoffRecord | undefined
    if (!rec) continue
    const m = maps.find(x => x.key === rec.mapKey)
    const allClosed = m ? rec.ids.every(id => m.tickets.find(t => t.id === id)?.closed ?? true) : false
    const stale = now - rec.at > 7 * 24 * 3600 * 1000
    if (allClosed || stale) {
      try { await $.process.run(['rm', '-f', rec.path]) } catch { /* already gone */ }
      await $.store.delete(key)
    }
  }
}

// ---------- actions ----------

const activeMap = async ($: Dollar) => {
  const [maps, key] = [await read($, mapsA), await read($, activeA)]
  return maps.find(m => m.key === key) ?? maps[0]
}

async function launchSet($: Dollar): Promise<Set<string>> {
  const m = await activeMap($)
  return new Set((await read($, launchesA)).filter(l => l.mapKey === m?.key).map(l => l.id))
}

async function openPath($: Dollar, target: string) {
  const argv = openArgv(target, opts.editor, platform)
  try {
    const r = await $.process.run(argv)
    if (r.exitCode !== 0) $.ui.toast(`Could not open ${target}: ${r.stderr.trim() || 'exit ' + r.exitCode}`)
  } catch (err) {
    $.ui.toast(`Could not run ${argv[0]}: ${String(err)}`)
  }
}

async function openTicket($: Dollar, id: string) {
  const m = await activeMap($)
  const t = m?.tickets.find(x => x.id === id)
  if (!t) return
  const target = t.path ?? t.url
  if (target) await openPath($, target)
}

async function startPressed($: Dollar, id: string) {
  const m = await activeMap($)
  if (!m) return
  if (await read($, flowA)) { $.ui.toast('Finish or cancel the start in progress first.'); return }
  const launching = await launchSet($)
  const held = await heldSet($, m)
  const picked = (await read($, pickedA)).filter(p => {
    const t = m.tickets.find(x => x.id === p)
    return t && statusOf(t, m.tickets, launching, held) === 'ready'
  })
  const t = m.tickets.find(x => x.id === id)
  const ids = picked.length ? picked : t && statusOf(t, m.tickets, launching, held) === 'ready' ? [t.id] : []
  if (!ids.length) {
    const s = t ? statusOf(t, m.tickets, launching, held) : 'closed'
    $.ui.toast(s === 'blocked' && t ? `${t.id} is waiting on ${openBlockers(t, m.tickets).join(', ')}.` : `${id} is not ready to start.`)
    return
  }
  await update($, selA, () => ids[0])
  const flow: Flow = { mapKey: m.key, ids, stage: 'ask', startedAt: 0 }
  await update($, flowA, () => flow)
  focusKey($, stripButtons(flow, await recommendHere($)).primary)
}

/** Closes the start strip and puts the focus back on the selected row. */
async function closeFlow($: Dollar) {
  await update($, flowA, () => null)
  const sel = await read($, selA)
  if (sel) focusKey($, `sel:${sel}`)
}

/** Works the ticket in this session by running `/wayfinder <map> <ticket>` here. */
async function launchHere($: Dollar) {
  const flow = await read($, flowA)
  const m = await activeMap($)
  const t = flow?.ids.length === 1 ? m?.tickets.find(x => x.id === flow.ids[0]) : undefined
  if (!m || !t) return
  await update($, pickedA, () => [])
  await closeFlow($)
  // A mod may not submit a "/..." prompt; it runs the command instead, which skips the prompt.submit hook.
  const args = `${mapRef(m)} ${ticketRef(t)}`
  pendingWork = args
  await resolveWork($)
  try {
    await $.command.run({ command: 'wayfinder', args })
  } catch (err) {
    $.ui.toast(`Could not run /wayfinder here: ${String(err).slice(0, 160)}`)
  }
}

async function beginHandoff($: Dollar) {
  const flow = await read($, flowA)
  const m = await activeMap($)
  if (!flow || !m) return
  const now = await $.clock.now()
  const path = handoffFile(tmp, m, flow.ids, now)
  const tickets = flow.ids.map(id => m.tickets.find(t => t.id === id)).filter((t): t is Ticket => !!t)
  await update($, flowA, (): Flow => ({ ...flow, stage: 'writing', handoffPath: path, startedAt: now }))
  focusKey($, `sel:${flow.ids[0]}`)
  const rec: HandoffRecord = { path, mapKey: m.key, ids: flow.ids, at: now }
  await $.store.set(`handoff:${path}`, rec)
  void $.prompt.submit({ text: handoffPrompt(m, tickets, path, skillText) })
}

async function launchAll($: Dollar, withHandoff: boolean) {
  const flow = await read($, flowA)
  const m = await activeMap($)
  if (!flow || !m) return
  const path = withHandoff ? flow.handoffPath : undefined
  const cmds = flow.ids.map(id => {
    const t = m.tickets.find(x => x.id === id)!
    return shellCommand(root, sessionPrompt(m, t, path))
  })
  let ok = 0
  const launcher = effectiveLauncher(opts.launcher, platform)
  if (launcher === 'copy') {
    const r = await $.ui.copy({ text: cmds.join('\n') })
    const why = opts.launcher === 'copy' ? '' : ` (${opts.launcher === 'iterm' ? 'iTerm' : 'Terminal'} launching is macOS only)`
    $.ui.toast(r.isCopied ? `Copied ${cmds.length} launch command${cmds.length > 1 ? 's' : ''}${why}.` : 'Could not copy the launch command.')
    ok = r.isCopied ? cmds.length : 0
  } else {
    for (const cmd of cmds) {
      const argv = launchArgv(launcher, cmd)!
      try {
        const r = await $.process.run(argv, { timeoutMs: 20000 })
        if (r.exitCode === 0) ok++
        else $.ui.toast(`Could not open a tab: ${r.stderr.trim().slice(0, 160)}. macOS may be asking to let Claude Code control ${launcher === 'iterm' ? 'iTerm' : 'Terminal'}.`)
      } catch (err) { $.ui.toast(`Could not run osascript: ${String(err)}`) }
    }
    if (ok) $.ui.toast(`Started ${ok} session${ok > 1 ? 's' : ''}${path ? ' with the handoff' : ''}.`)
  }
  const now = await $.clock.now()
  if (ok) await update($, launchesA, ls => [...ls, ...flow.ids.map(id => ({ mapKey: m.key, id, at: now }))])
  await update($, pickedA, () => [])
  await closeFlow($)
}

async function discard($: Dollar) {
  const flow = await read($, flowA)
  if (flow?.handoffPath) {
    try { await $.process.run(['rm', '-f', flow.handoffPath]) } catch { /* gone */ }
    await $.store.delete(`handoff:${flow.handoffPath}`)
  }
  await closeFlow($)
}

// ---------- keyboard ----------

const focusKey = ($: Dollar, key: string) => {
  try { void $.ui.focus({ requestId: PANE, key }).catch(() => undefined) } catch { /* no surface draws the pane */ }
}

/** The start strip's buttons, left to right, and which one is recommended. */
function stripButtons(f: Flow, recommendHere: boolean): { keys: string[]; primary: string } {
  if (f.stage === 'ask') {
    const keys = f.ids.length === 1 ? ['handoff', 'fresh', 'here', 'cancel'] : ['handoff', 'fresh', 'cancel']
    return { keys, primary: recommendHere && keys.includes('here') ? 'here' : 'handoff' }
  }
  if (f.stage === 'writing') return { keys: ['fresh', 'cancel'], primary: 'cancel' }
  return { keys: ['launch', 'view', 'discard'], primary: 'launch' }
}

/** Starting here is recommended when this session holds no open ticket and is under 60% of its budget. */
async function recommendHere($: Dollar): Promise<boolean> {
  const self = await read($, selfCtxA)
  if (budgetLevel(self?.tokens, Math.min(opts.contextBudget, self?.window ?? opts.contextBudget)) !== 'ok') return false
  return (await ownOpenTickets($)).length === 0
}

/** Open tickets this session holds, by id, across maps. */
async function ownOpenTickets($: Dollar): Promise<string[]> {
  const keys = new Set([...(await read($, mineA)), ...(await read($, workingA))])
  const out: string[] = []
  for (const m of await read($, mapsA)) for (const t of m.tickets) if (!t.closed && keys.has(`${m.key}|${t.id}`)) out.push(t.id)
  return out
}

/** i / k: move between lines, where a line is a ticket row or the start strip under its ticket. */
async function move($: Dollar, by: 1 | -1) {
  const m = await activeMap($)
  if (!m) return
  const order = visibleOrder(m, await launchSet($), await heldSet($, m))
  if (!order.length) return
  const flow = await read($, flowA)
  const strip = flow && flow.mapKey === m.key ? stripButtons(flow, await recommendHere($)) : undefined
  const lines: string[] = []
  for (const id of order) {
    lines.push(id)
    if (strip && flow!.ids[0] === id) lines.push('')
  }
  const cur = strip && focused && strip.keys.includes(focused) ? '' : await read($, selA)
  const i = lines.indexOf(cur)
  const next = lines[Math.max(0, Math.min(lines.length - 1, i < 0 ? 0 : i + by))]!
  if (next === '') { focusKey($, strip!.primary); return }
  await update($, selA, () => next)
  focusKey($, `sel:${next}`)
  void $.ui.scroll({ to: { key: `row:${next}` }, in: PANE })
}

/** j / l: move across the buttons of the focused line. */
async function side($: Dollar, by: 1 | -1) {
  const flow = await read($, flowA)
  const strip = flow ? stripButtons(flow, await recommendHere($)) : undefined
  let lane: string[]
  if (strip && focused && strip.keys.includes(focused)) lane = strip.keys
  else {
    const sel = await read($, selA)
    if (!sel) { await move($, 1); return }
    lane = [`sel:${sel}`, `open:${sel}`, `run:${sel}`]
  }
  const i = focused ? lane.indexOf(focused) : -1
  focusKey($, lane[Math.max(0, Math.min(lane.length - 1, i < 0 ? 0 : i + by))]!)
}

async function onTick($: Dollar) {
  tick++
  const now = await $.clock.now()
  const flash = await read($, flashA)
  if (flash && now > flash.until) await update($, flashA, () => null)
  const flow = await read($, flowA)
  if (flow?.stage === 'writing' && flow.handoffPath && tick % 7 === 0) {
    if (await $.fs.exists(flow.handoffPath)) {
      const st = await $.fs.stat(flow.handoffPath)
      if (st.size > 0) {
        await update($, flowA, (f): Flow | null => (f ? { ...f, stage: 'ready' } : f))
        focusKey($, 'launch')
      }
    }
  }
  // Only spin while something on screen spins.
  const m = await activeMap($)
  const spinning = flow?.stage === 'writing' || (m?.tickets.some(t => t.assignee && !t.closed) ?? false)
  if (spinning) await update($, spinA, n => (n + 1) % 1000)
  if (tick % Math.max(1, Math.round((opts.pollSeconds * 1000) / TICK_MS)) === 0) await refresh($)
}

function visibleOrder(m: WfMap, launching: Set<string>, held: Set<string>): string[] {
  const by = (s: Status) => m.tickets.filter(t => statusOf(t, m.tickets, launching, held) === s).map(t => t.id)
  return [...by('ready'), ...by('claimed'), ...by('launching'), ...by('blocked')]
}

async function afterToolCall($: Dollar, path: string, cmd: string) {
  const before = await read($, mapsA)
  await refresh($, { github: cmd !== '' })
  const after = await read($, mapsA)
  for (const m of after) {
    const old = before.find(b => b.key === m.key)
    for (const t of m.tickets) {
      const was = old?.tickets.find(x => x.id === t.id)
      const claimedNow = t.assignee && !t.closed && (!was || !was.assignee)
      const byThisCall = (t.path !== undefined && t.path === path) ||
        (m.tracker === 'github' && new RegExp(`gh\\s+issue\\s+edit\\s+${t.id.slice(1)}\\b.*--add-assignee`).test(cmd))
      if (claimedNow && byThisCall) await noteClaim($, m.key, t.id)
    }
  }
}

async function startup($: Dollar) {
  await refresh($, { github: true })
  const maps = await read($, mapsA)
  const first = maps.find(m => m.tracker === 'local') ?? maps[0]
  if (first) void $.ui.open({ id: PANE, title: first.title })
}

export const register: Register = (on, options) => {
  opts = readOptions(options)

  // ---------- events ----------

  on('session.start', async ($, e, next) => {
    root = (await $.session.root().catch(() => e.cwd)) || e.cwd
    sessionId = await $.session.id().catch(() => '')
    tmp = (await $.env.get('TMPDIR')) || '/tmp'
    try { platform = (await $.process.run(['uname', '-s'], { timeoutMs: 5000 })).stdout.trim() } catch { platform = '' }
    const home = await $.env.get('HOME')
    for (const p of [`${home}/.claude/skills/handoff/SKILL.md`, `${home}/.agents/skills/handoff/SKILL.md`]) {
      try { skillText = await $.fs.read(p); break } catch { /* not installed there */ }
    }
    await $.command.register({ name: 'wayfinder-map', description: 'Show the wayfinder map sidebar', argumentHint: '[refresh]' })
    $.clock.every(TICK_MS, () => { void onTick($) })
    void $.session.usage().then(u => update($, selfCtxA, () => ({ tokens: u.context.tokens, window: u.context.window }))).catch(() => undefined)
    void startup($)
    return next(e)
  })

  // This session's context fill, for the budget bars: kept here and shared with the other tabs.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, selfCtxA, () => ({ tokens: e.context.tokens, window: e.context.window }))
      await publishSelf($, await read($, mineA))
    }
    return next(e)
  })

  on('command.run', { command: 'wayfinder-map' }, async $ => {
    await refresh($, { github: true })
    const maps = await read($, mapsA)
    if (!maps.length) return { text: 'No wayfinder map found: looked for .scratch/<effort>/map.md and open GitHub issues labelled wayfinder:map.' }
    const r = await $.ui.open({ id: PANE, title: (await activeMap($))?.title ?? 'Wayfinder' })
    return { text: r.isPlaced ? `Wayfinder sidebar open (${maps.length} map${maps.length > 1 ? 's' : ''}).` : `Wayfinder sidebar is waiting for room: ${r.reason}` }
  })

  // A session started with `/wayfinder <map> <ticket>` (as ▶ starts them) works on that ticket.
  on('prompt.submit', async ($, e, next) => {
    const args = e.command
      ? (e.command.name === 'wayfinder' ? e.command.args : undefined)
      : /^\/wayfinder\s/.test(e.text) ? e.text.replace(/^\/wayfinder\s+/, '') : undefined
    if (args !== undefined) { pendingWork = args; void resolveWork($) }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After a /clear the conversation that held the ticket is gone; the process goes on under a new id.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      pendingWork = undefined
      await update($, workingA, () => [])
      await $.store.delete(`peer:${e.sessionId}`).catch(() => undefined)
      sessionId = ''
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // This session's own edits to ticket files: refresh at once, and remember claims it made.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'Bash') return ran
    const path = e.tool === 'Bash' ? '' : e.file_path
    const cmd = e.tool === 'Bash' ? e.command : ''
    if (path.includes('/.scratch/') || /\bgh\s+(issue|api)\b/.test(cmd)) void afterToolCall($, path, cmd)
    return ran
  }).catch(($, e, next) => next(e))

  // Track the focus ring for j / l, and let the selection follow it onto a ticket's row.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny) return r
    focused = e.element
    const id = /^(?:sel|open|run):(.+)$/.exec(e.element ?? '')?.[1]
    if (id && id !== (await read($, selA))) await update($, selA, () => id)
    return r
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // The pane is outlined in a bold DIM border, so content gets two fewer columns.
    const OUTER = Math.max(36, e.props.bodyColumns)
    const W = OUTER - 2
    const maps = await read($, mapsA)
    const activeKey = await read($, activeA)
    const m = maps.find(x => x.key === activeKey) ?? maps[0]
    const sel = await read($, selA)
    const flow = await read($, flowA)
    const picked = await read($, pickedA)
    const launches = await read($, launchesA)
    const flash = await read($, flashA)
    const mine = await read($, mineA)
    const working = await read($, workingA)
    const peers = await read($, peersA)
    const showDone = await read($, showDoneA)
    const contexts = await read($, contextsA)
    const selfCtx = await read($, selfCtxA)
    const spin = SPIN[(await read($, spinA)) % SPIN.length]

    if (!m) {
      return (
        <Box flexDirection="column">
          <Text color={TEXT}>No wayfinder map here yet.</Text>
          <Text dimColor>Looked for .scratch/&lt;effort&gt;/map.md and open GitHub issues labelled wayfinder:map. Run /wayfinder to chart one.</Text>
        </Box>
      )
    }

    const launching = new Set(launches.filter(l => l.mapKey === m.key).map(l => l.id))
    const held = await heldSet($, m)
    const st = (t: Ticket) => statusOf(t, m.tickets, launching, held)
    const open = m.tickets.filter(t => !t.closed)
    const count = (s: Status) => open.filter(t => st(t) === s).length
    const idW = Math.max(2, ...m.tickets.map(t => t.id.length))
    const room = Math.max(6, W - 25 - idW)
    const kind = m.tracker === 'local' ? ' md ' : ' gh '
    const flashing = new Set(flash?.ids ?? [])

    // Status column: 5 cells.
    const statusCells = (t: Ticket): { text: string; color: string }[] => {
      const s = st(t)
      if (s === 'claimed') {
        const k = `${m.key}|${t.id}`
        if (mine.includes(k) || working.includes(k)) return [{ text: `${spin} you`, color: BLUE }]
        // Another tab running the mod: how much of its context budget it has used.
        const c = contexts.find(x => x.keys.includes(k))
        if (c && c.tokens !== undefined) {
          const used = fmtTokens(c.tokens)
          return [{ text: (used.length >= 4 ? spin + used : `${spin} ${used}`).padStart(5), color: LEVEL[budgetLevel(c.tokens, Math.min(opts.contextBudget, c.window))] }]
        }
        const who = peers[k] ?? (t.assignee === 'claude' || t.assignee === 'claimed' ? 'tab' : t.assignee.slice(0, 3))
        return [{ text: `${spin} ${who}`.padStart(5).slice(-5), color: YELLOW }]
      }
      if (s === 'launching') return [{ text: '↗ new', color: BLUE }]
      if (s === 'blocked') {
        const b = openBlockers(t, m.tickets)
        const color = (id: string) => COLOR[m.tickets.find(x => x.id === id)?.type ?? 'unknown']
        if (m.tracker === 'github' || b.length > 2) {
          const head = m.tracker === 'github' ? `⧗ ${b.length}` : `${b[0]} +${b.length - 1}`
          return [{ text: head.padStart(5).slice(-5), color: DIM }]
        }
        const cells: { text: string; color: string }[] = [{ text: ' '.repeat(5 - (b.length * 3 - 1)), color: DIM }]
        b.forEach((id, i) => cells.push({ text: (i ? ' ' : '') + id, color: color(id) }))
        return cells
      }
      if (flow?.ids.includes(t.id) && flow.mapKey === m.key) return [{ text: flow.stage === 'writing' ? `${spin} ✎`.padStart(5) : flow.stage === 'ready' ? ' ✓ ho' : '  ▶? ', color: YELLOW }]
      return [{ text: '     ', color: DIM }]
    }

    const row = (t: Ticket) => {
      const s = st(t)
      const k = `${m.key}|${t.id}`
      const isFlash = flashing.has(k)
      const tint = isFlash ? FLASH_TINT : TINT[t.type]
      const isPicked = picked.includes(t.id)
      const canRun = s === 'ready'
      const out = [
        <Box key={`row:${t.id}`} flexDirection="row">
          <Text color={isPicked ? GREEN : tint}>{isPicked ? '◆' : '▐'}</Text>
          <Button key={`sel:${t.id}`} plain onPress={() => update($, selA, () => t.id)}>
            <Text backgroundColor={t.hitl ? COLOR[t.type] : INK} color={t.hitl ? INK : COLOR[t.type]} bold>{` ${WORD[t.type]}`.padEnd(6) + ' '}</Text>
            <Text backgroundColor={tint} color={DIM}>{` ${t.id.padStart(idW)} `}</Text>
            <Text backgroundColor={tint} color={s === 'blocked' ? DIM : TEXT} bold={isFlash} underline={sel === t.id}>{fit(t.title, room)}</Text>
            <Text backgroundColor={tint}> </Text>
            {statusCells(t).map(c => <Text backgroundColor={tint} color={c.color}>{c.text}</Text>)}
            <Text backgroundColor={tint}> </Text>
          </Button>
          <Button key={`open:${t.id}`} plain onPress={() => openTicket($, t.id)}>
            <Text backgroundColor={BTN} color={TEXT}>{kind}</Text>
          </Button>
          <Button key={`run:${t.id}`} plain onPress={() => startPressed($, t.id)}>
            <Text backgroundColor={canRun ? BTN : tint} color={canRun ? GREEN : DIM}>{' ▶ '}</Text>
          </Button>
          <Text color={tint}>▌</Text>
        </Box>,
      ]
      if (sel === t.id) {
        const b = openBlockers(t, m.tickets)
        const nu = nextUnblocked(t, m.tickets)
        const tail = nu.more ? ` +${nu.more} more` : ''
        const also = nu.alsoWaits.length ? ` (also waits ${nu.alsoWaits.join(' ')})` : ''
        const nextText = nu.next ? `${nu.next.id} ${fit(nu.next.title, Math.max(8, W - 2 - 'unblocks '.length - nu.next.id.length - 1 - also.length - tail.length)).trimEnd()}` : ''
        out.push(
          <Box key={`detail:${t.id}`} flexDirection="column" paddingLeft={2}>
            <Text color={TEXT} wrap="wrap">{t.title}</Text>
            <Text dimColor>{`${t.hitl ? 'needs you' : 'agent alone'} · ${b.length ? 'waits ' + b.join(' ') : 'no blockers'}`}</Text>
            {nu.next
              ? <Text dimColor wrap="wrap">{'unblocks '}<Text color={COLOR[nu.next.type]}>{nextText}</Text>{also + tail}</Text>
              : <Text dimColor>unblocks nothing</Text>}
            {t.warning ? <Text color={YELLOW}>{`? ${t.warning}`}</Text> : null}
          </Box>,
        )
      }
      if (flow && flow.mapKey === m.key && flow.ids[0] === t.id) out.push(strip(flow))
      return out
    }

    const hereFirst = await recommendHere($)
    const own = await ownOpenTickets($)
    const strip = (f: Flow) => {
      const launcher = effectiveLauncher(opts.launcher, platform)
      const where = launcher === 'iterm' ? 'iTerm tab' : launcher === 'terminal' ? 'Terminal window' : 'command (copied)'
      const { primary } = stripButtons(f, hereFirst)
      const v = (key: string) => (key === primary ? ('primary' as const) : undefined)
      if (f.stage === 'ask') {
        const one = f.ids.length === 1
        const short = launcher === 'iterm' ? 'tab' : launcher === 'terminal' ? 'window' : 'copy'
        const budget = Math.min(opts.contextBudget, selfCtx?.window ?? opts.contextBudget)
        const level = budgetLevel(selfCtx?.tokens, budget)
        const holds = own.length ? `holds ${own.join(' ')}` : 'no ticket'
        return (
          <Box key="strip" flexDirection="column" paddingLeft={2} marginBottom={1}>
            <Text color={YELLOW}>{one ? `▶ Start ${f.ids[0]}?` : `▶ Start ${f.ids.length} tickets (${f.ids.join(' ')}) in new ${where}s?`}</Text>
            {one
              ? <Text color={level !== 'ok' ? LEVEL[level] : own.length ? YELLOW : DIM}>{`this session: ${fmtTokens(selfCtx?.tokens)} of ${fmtTokens(budget)}, ${holds}`}</Text>
              : null}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="handoff" variant={v('handoff')} label={short === 'copy' ? 'handoff + copy' : `handoff + new ${short}`} onPress={() => beginHandoff($)} />
              <Button key="fresh" variant={v('fresh')} label={short === 'copy' ? 'copy command' : `fresh ${short}`} onPress={() => launchAll($, false)} />
              {one ? <Button key="here" variant={v('here')} label="this tab" onPress={() => launchHere($)} /> : null}
              <Button key="cancel" label="cancel" onPress={() => closeFlow($)} />
            </Box>
          </Box>
        )
      }
      if (f.stage === 'writing') {
        return (
          <Box key="strip" flexDirection="column" paddingLeft={2} marginBottom={1}>
            <Text color={YELLOW}>{`${spin} this session is writing the handoff…`}</Text>
            <Text dimColor>It waits for the current turn to end first.</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="fresh" label="skip, start fresh" onPress={() => launchAll($, false)} />
              <Button key="cancel" label="cancel" onPress={() => discard($)} />
            </Box>
          </Box>
        )
      }
      return (
        <Box key="strip" flexDirection="column" paddingLeft={2} marginBottom={1}>
          <Text color={GREEN}>✓ handoff ready</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="launch" variant="primary" label="launch" onPress={() => launchAll($, true)} />
            <Button key="view" label="view" onPress={() => (f.handoffPath ? openPath($, f.handoffPath) : undefined)} />
            <Button key="discard" label="discard" onPress={() => discard($)} />
          </Box>
        </Box>
      )
    }

    const groups: [Status, string, string][] = [['ready', '▸ Ready', GREEN], ['claimed', '◐ Claimed', BLUE], ['launching', '↗ Starting', BLUE], ['blocked', '⧗ Blocked', DIM]]
    const body: unknown[] = []
    for (const [s, label, color] of groups) {
      const ts = open.filter(t => st(t) === s)
      if (!ts.length) continue
      body.push(<Text key={`g:${s}`} color={color}>{`${label} `}<Text dimColor>{String(ts.length)}</Text></Text>)
      for (const t of ts) body.push(...row(t))
      body.push(<Text key={`gap:${s}`}> </Text>)
    }
    const done = m.tickets.filter(t => t.closed)
    const sep = '─'.repeat(W)

    // One bar per session on this map against the per-session budget: this one first, then the tabs holding tickets.
    const contextSection = () => {
      const idsOf = (keys: string[]) => keys.filter(k => k.startsWith(`${m.key}|`)).map(k => k.slice(m.key.length + 1))
      const rows: { key: string; isYou: boolean; ids: string[]; tokens?: number; window: number }[] = []
      if (selfCtx) rows.push({ key: 'you', isYou: true, ids: idsOf([...new Set([...working, ...mine])]), tokens: selfCtx.tokens, window: selfCtx.window })
      for (const c of contexts) { const ids = idsOf(c.keys); if (ids.length) rows.push({ key: c.who, isYou: false, ids, tokens: c.tokens, window: c.window }) }
      if (!rows.length) return null
      // Each bar is labelled by the ticket its session holds; this session's also says "you".
      const labW = Math.max(10, Math.min(22, Math.floor(W * 0.4)))
      const barW = Math.max(6, W - 2 - labW - 1 - 5)
      const label = (r: (typeof rows)[number]) => {
        const t = m.tickets.find(x => x.id === r.ids[0])
        const parts: { text: string; color?: string; dim?: boolean }[] = []
        if (r.isYou) parts.push({ text: 'you', color: BLUE })
        if (t) {
          const more = r.ids.length > 1 ? ` +${r.ids.length - 1}` : ''
          if (parts.length) parts.push({ text: ' ' })
          parts.push({ text: t.id, color: COLOR[t.type] })
          const used = parts.reduce((n, p) => n + p.text.length, 0) + 1 + more.length
          parts.push({ text: ' ' + fit(t.title, Math.max(0, labW - used)).trimEnd() + more, dim: true })
        }
        const len = parts.reduce((n, p) => n + p.text.length, 0)
        parts.push({ text: ' '.repeat(Math.max(0, labW - len)) })
        return parts
      }
      return (
        <Box key="ctx" flexDirection="column">
          <Text color={TEXT}>{'◔ Context '}<Text dimColor>{`· ${fmtTokens(opts.contextBudget)} a session`}</Text></Text>
          {rows.map(r => {
            const budget = Math.min(opts.contextBudget, r.window)
            const level = budgetLevel(r.tokens, budget)
            const bar = budgetBar(r.tokens, budget, barW)
            return (
              <Text key={`ctx:${r.key}`}>
                {'  '}
                {label(r).map((p, i) => <Text key={`l:${i}`} color={p.color} dimColor={p.dim}>{p.text}</Text>)}
                {' '}
                <Text color={LEVEL[level]}>{bar.fill}</Text>
                <Text color={BTN}>{bar.track}</Text>
                <Text color={level === 'ok' ? DIM : LEVEL[level]} bold={level === 'over'}>{' ' + fmtTokens(r.tokens).padStart(4)}</Text>
              </Text>
            )
          })}
          <Text> </Text>
        </Box>
      )
    }

    // The top bar, drawn like a ticket row: brand on the left, counts on the right.
    const banner = () => {
      const counts: { text: string; color: string }[] = [
        { text: `${count('ready')} ▸`, color: GREEN },
        { text: `${count('claimed')} ◐`, color: BLUE },
        { text: `${count('blocked')} ⧗`, color: DIM },
        { text: `✓ ${done.length}`, color: DIM },
      ]
      const right = counts.map(c => c.text).join('  ') + ' '
      const inner = W - 2
      const brand = inner - right.length >= 13 ? ' ◈ WAYFINDER' : ' ◈'
      const gap = Math.max(1, inner - brand.length - right.length)
      return (
        <Box key="banner" flexDirection="row">
          <Text color={BANNER}>▐</Text>
          <Text backgroundColor={BANNER} color={BLUE} bold>{' ◈'}</Text>
          <Text backgroundColor={BANNER} color={TEXT} bold>{brand.slice(2)}</Text>
          <Text backgroundColor={BANNER}>{' '.repeat(gap)}</Text>
          {counts.map((c, i) => (
            <Text key={`n:${i}`} backgroundColor={BANNER} color={c.color}>{(i ? '  ' : '') + c.text}</Text>
          ))}
          <Text backgroundColor={BANNER}> </Text>
          <Text color={BANNER}>▌</Text>
        </Box>
      )
    }

    // Key hints sit in a bar pinned to the bottom of the docked pane: placed at the last rows the
    // window shows, which the engine reports in `scroll` and asks again for on each scroll.
    // `top` counts from inside the top border, and the bar stays above the bottom border.
    const FOOT = 2
    const docked = e.props.placement === 'dock'
    const { offset, bodyRows } = e.props.scroll
    const hint = (key: string, hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={key} plain dimColor hotkey={hotkey} label={label} onPress={onPress} />
    )
    const footer = (
      <Box
        key="footer"
        flexDirection="column"
        backgroundColor={BANNER}
        paddingX={1}
        width={W}
        {...(docked ? { position: 'absolute' as const, left: 0, top: Math.max(0, offset + bodyRows - FOOT - 2) } : {})}
      >
        <Box flexDirection="row" columnGap={1}>
          {hint('k-up', 'i', 'up', () => move($, -1))}
          {hint('k-down', 'k', 'down', () => move($, 1))}
          {hint('k-left', 'j', 'left', () => side($, -1))}
          {hint('k-right', 'l', 'right', () => side($, 1))}
          <Text dimColor>⏎ press</Text>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {hint('k-pick', 'p', picked.length ? `pick (${picked.length})` : 'pick', () => update($, pickedA, p => (!sel ? p : p.includes(sel) ? p.filter(x => x !== sel) : [...p, sel])))}
          {hint('k-done', 'd', showDone ? 'hide done' : 'show done', () => update($, showDoneA, v => !v))}
          {hint('k-refresh', 'r', 'refresh', () => refresh($, { github: true }))}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" borderStyle="bold" borderColor={DIM} width={OUTER} {...(docked ? { minHeight: bodyRows, paddingBottom: FOOT } : {})}>
        {maps.length > 1 ? (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {maps.map(x => (
              <Button key={`map:${x.key}`} label={fit(x.title, 18).trim()} variant={x.key === m.key ? 'primary' : 'secondary'} onPress={() => update($, activeA, () => x.key)} />
            ))}
          </Box>
        ) : null}
        {banner()}
        {wrapLines(plainText(m.destination || m.title), W - 2, 2).map((l, i) => (
          <Text key={`dest:${i}`} color={TEXT} bold={i === 0 || undefined}>{`${i ? ' ' : '◎'} ${l}`}</Text>
        ))}
        {m.error ? <Text color={YELLOW} wrap="wrap">{`! ${m.error}`}</Text> : null}
        <Text dimColor>{sep}</Text>
        {open.length === 0 && !(m.error && m.tickets.length === 0) ? <Text color={GREEN}>Every ticket is resolved. The way is clear.</Text> : null}
        {body as never}
        {contextSection()}
        {m.fog.length ? <Text dimColor>{`≋ fog: ${fit(m.fog[0] ?? '', W - 8).trimEnd()}${m.fog.length > 1 ? ` +${m.fog.length - 1}` : ''}`}</Text> : null}
        <Text dimColor>{sep}</Text>
        {showDone
          ? done.map(t => <Text key={`done:${t.id}`} dimColor>{`  ✓ ${t.id.padStart(idW)} ${fit(t.title, W - idW - 5).trimEnd()}`}</Text>)
          : <Text dimColor>{`✓ ${done.length} resolved`}</Text>}
        {footer}
      </Box>
    )
  })
}
