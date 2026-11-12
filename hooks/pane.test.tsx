import { expect, mock, test } from 'claude-code/testing'

// A fake repo with one local map, served through the fs hooks (tests have no real file system).
const ROOT = '/repo'
const FILES: Record<string, string> = {
  '/repo/.scratch/wayfinder/map.md': '# Map: I4 Agent Security\n\n## Destination\n\nI4 submitted on Canvas.\n\n## Not yet specified\n\n- write-ups\n',
  '/repo/.scratch/wayfinder/tickets/01-identity.md': '---\ntitle: Who is the user?\ntype: wayfinder:grilling\nstatus: closed\nassignee: claude\nblocked_by: []\n---\n',
  '/repo/.scratch/wayfinder/tickets/06-p1-p2.md': '---\ntitle: P1 & P2 rules\ntype: wayfinder:grilling\nstatus: open\nassignee: claude\nblocked_by: [01-identity.md]\n---\n',
  '/repo/.scratch/wayfinder/tickets/07-p3.md': '---\ntitle: P3 user-confirmed payment actions\ntype: wayfinder:grilling\nstatus: open\nassignee:\nblocked_by: [01-identity.md]\n---\n',
  '/repo/.scratch/wayfinder/tickets/13-checks.md': '---\ntitle: Implement P1/P2 policy checks\ntype: wayfinder:task\nstatus: open\nassignee:\nblocked_by: [06-p1-p2.md, 07-p3.md]\n---\n',
  // A plain plan: numbered checklists, no map.md, no Type or Status lines.
  '/repo/.scratch/m3/01-dry-run.md': '# Rehearse on rtest\n\n**When:** Wed · **Owner:** Nick\n\n- [ ] dry run\n',
  '/repo/.scratch/m3/02-merge.md': '# Merge and pull\n\n**When:** Thu · **Owner:** Nick · **Depends on:** 01\n\n- [ ] merge\n',
  '/repo/.scratch/m3/03-old.md': '# Already done\n\n- [x] all of it\n',
  // Not plans: agent notes, and a folder with a single numbered file.
  '/repo/.scratch/ci-report/AGENTS.md': '# notes\n',
  '/repo/.scratch/lonely/01-only.md': '# Only one\n',
}
const DIRS: Record<string, string[]> = {
  '/repo/.scratch': ['wayfinder', 'm3', 'ci-report', 'lonely'],
  '/repo/.scratch/wayfinder/tickets': ['01-identity.md', '06-p1-p2.md', '07-p3.md', '13-checks.md'],
  '/repo/.scratch/m3': ['01-dry-run.md', '02-merge.md', '03-old.md'],
  '/repo/.scratch/ci-report': ['AGENTS.md'],
  '/repo/.scratch/lonely': ['01-only.md'],
}
const DIR_PATHS = new Set(['/repo/.scratch/wayfinder', '/repo/.scratch/m3', '/repo/.scratch/ci-report', '/repo/.scratch/lonely'])
const isDir = (p: string) => (p in DIRS && !p.endsWith('.md')) || DIR_PATHS.has(p)

const PANE = {
  plugin: 'wayfinder-sidebar',
  component: 'Pane',
  requestId: 'wayfinder',
  props: {
    title: 'I4 Agent Security',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('draws ready, claimed and blocked tickets, and asks before starting one', async ($, on) => {
  const prompts: string[] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'sess-abc' }))
  on('env.get', (_, e) => ({ value: e.name === 'TMPDIR' ? '/tmp' : '/home' }))
  on('command.register', () => ({ value: { command: 'wayfinder-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 4, 12) })
  // Another tab running the mod holds 06 and has used 181k tokens.
  mock.store(on, { 'peer:f4e2aa': { claims: ['/repo/.scratch/wayfinder/map.md|06'], tokens: 181_000, window: 200_000, at: 1 } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [] } }))
  on('fs.exists', (_, e) => ({ value: e.path in FILES || isDir(e.path) }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path ?? ''] ?? []).map(name => ({ name, kind: isDir(`${e.path}/${name}`) ? 'dir' : 'file', size: 10, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path in FILES ? { value: FILES[e.path]! } : { deny: 'missing' }))
  on('process.run', (_, e) => (e.argv[0] === 'uname'
    ? { value: { exitCode: 0, stdout: 'Darwin\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    : { value: { exitCode: 1, stdout: '', stderr: 'no gh here', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // Startup refresh runs unawaited; let it settle.
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /I4 submitted on Canvas/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /WAYFINDER/ })).toBeDefined()
  for (const n of [/^1 ▸$/, /^ *1 ◐$/, /^ *1 ⧗$/, /^ *✓ 1$/]) expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /P3 user-confirmed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fog: write-ups/ })).toBeDefined()

  // Context bars: this session, then the tab holding 06 (past 60% of the budget).
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ *12k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ *181k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /P1 & P2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /181k$/ })).toBeDefined() // on 06's row too
  expect(await ui.find({ type: 'Text', text: /f4e/ })).toBeUndefined()
  await $.session.measure({ context: { tokens: 92_400, window: 200_000, percent: 46 }, rateLimits: [], changed: ['context'] })
  expect(await ui.find({ type: 'Text', text: /^ *92k$/ })).toBeDefined()

  await ui.press({ key: 'sel:06' })
  expect(await ui.find({ type: 'Text', text: /13 Implement P1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /also waits 07/ })).toBeDefined()

  await ui.press({ key: 'run:07' })
  expect(await ui.find({ type: 'Text', text: /Start 07\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /this session: 92k of 200k, no ticket/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'handoff' }))?.props.label).toBe('handoff + new tab')
  // Under 60% of the budget with no ticket of its own, this session is the recommended place.
  expect((await ui.find({ type: 'Button', key: 'here' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'handoff' }))?.props.variant).toBeUndefined()

  await ui.press({ key: 'handoff' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('07 P3 user-confirmed payment actions')
  expect(prompts[0]).toContain('/tmp/wayfinder-handoffs/i4-agent-security-07-')
  expect(await ui.find({ type: 'Text', text: /writing the handoff/ })).toBeDefined()

  await ui.press({ key: 'cancel' })
  expect(await ui.find({ type: 'Text', text: /writing the handoff/ })).toBeUndefined()
  await ui.unmount()

  // Key hints are pinned to the last two rows inside the pane's border, wherever it is scrolled to.
  const scrolled = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 12, bodyRows: 30 } } })
  const foot = await scrolled.find({ key: 'footer' })
  expect(foot?.props.position).toBe('absolute')
  expect(foot?.props.top).toBe(38)
  expect(foot?.props.width).toBe(48)
  expect(await scrolled.find({ type: 'Button', key: 'k-refresh' })).toBeDefined()
  expect((await scrolled.find({ type: 'Button', key: 'k-refresh' }))?.props.hotkey).toBe('r')
  await scrolled.unmount()
})

// The fake repo's world for one tab: session `sid`, sharing `shared` with the other tabs.
function tab(on: Parameters<Parameters<typeof test>[1]>[1], sid: string, shared: Record<string, unknown>) {
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: sid }))
  on('env.get', (_, e) => ({ value: e.name === 'TMPDIR' ? '/tmp' : '/home' }))
  on('command.register', () => ({ value: { command: 'wayfinder-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 4, 12) })
  mock.store(on, shared)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [] } }))
  on('fs.exists', (_, e) => ({ value: e.path in FILES || isDir(e.path) }))
  on('fs.list', (_, e) => ({
    value: (DIRS[e.path ?? ''] ?? []).map(name => ({ name, kind: isDir(`${e.path}/${name}`) ? 'dir' : 'file', size: 10, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => (e.path in FILES ? { value: FILES[e.path]! } : { deny: 'missing' }))
  const argvs: string[][] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: 'Darwin\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    argvs.push(e.argv)
    return e.argv[0] === 'osascript'
      ? { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: 'no gh here', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: {} } })

  return { clock, toasts, argvs, prompts }
}

test('a session started with /wayfinder <map> <ticket> holds that ticket from its first turn', async ($, on) => {
  const { clock, toasts } = tab(on, 'sess-new', {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // The launch prompt can arrive before the maps have loaded.
  await $.prompt.submit({ text: '/wayfinder .scratch/wayfinder/map.md 07' })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ *1 ▸$/ })).toBeUndefined() // 07 is no longer ready
  expect(await ui.find({ type: 'Text', text: /you$/ })).toBeDefined()
  await ui.press({ key: 'run:07' })
  expect(await ui.find({ type: 'Text', text: /Start 07/ })).toBeUndefined()
  expect(toasts.join()).toContain('07 is not ready to start')
  await ui.unmount()
})

test('a ticket another tab holds by its /wayfinder prompt is claimed here too', async ($, on) => {
  const { clock, toasts } = tab(on, 'sess-abc', {
    'peer:sess-new': { claims: [], working: ['/repo/.scratch/wayfinder/map.md|07'], tokens: 40_000, window: 200_000, at: 1 },
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ *1 ▸$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /40k$/ })).toBeDefined() // its context, on 07's row
  await ui.press({ key: 'run:07' })
  expect(toasts.join()).toContain('07 is not ready to start')
  await ui.unmount()
})

test('"this tab" starts the ticket in this session, which then holds it', async ($, on) => {
  const runs: string[] = []
  const { clock } = tab(on, 'sess-abc', {})
  on('command.run', { command: 'wayfinder' }, (_, e) => { runs.push(`/${e.command} ${e.args}`); return { text: '' } })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'run:07' })
  await ui.press({ key: 'here' })
  await clock.advance(10)
  expect(runs).toEqual(['/wayfinder .scratch/wayfinder/map.md 07'])
  expect(await ui.find({ type: 'Text', text: /Start 07/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /you$/ })).toBeDefined()
  await ui.unmount()
})

const PLAN_KEY = '/repo/.scratch/m3'
const PLAN_PROMPT_01 = 'Work on the ticket .scratch/m3/01-dry-run.md from the plan in .scratch/m3/.'

test('a plain plan folder shows up beside the map, and ▶ starts its ticket with the plan prompt', async ($, on) => {
  const { clock, argvs } = tab(on, 'sess-abc', {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Two tabs: the wayfinder map and the plan. ci-report and lonely are not plans.
  expect(await ui.find({ type: 'Button', key: `map:${PLAN_KEY}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'map:/repo/.scratch/ci-report' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'map:/repo/.scratch/lonely' })).toBeUndefined()

  await ui.press({ key: `map:${PLAN_KEY}` })
  expect(await ui.find({ type: 'Text', text: /plain plan in \.scratch\/m3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Rehearse on rtest/ })).toBeDefined()
  // 01 ready, 02 waits on 01, 03 closed by its ticked boxes.
  for (const n of [/^1 ▸$/, /^ *0 ◐$/, /^ *1 ⧗$/, /^ *✓ 1$/]) expect(await ui.find({ type: 'Text', text: n })).toBeDefined()

  await ui.press({ key: 'run:01' })
  await ui.press({ key: 'fresh' })
  await clock.advance(10)
  const osa = argvs.find(a => a[0] === 'osascript')?.join(' ') ?? ''
  expect(osa).toContain(PLAN_PROMPT_01)
  expect(osa).not.toContain('/wayfinder')
  await ui.unmount()
})

test('"this tab" on a plan ticket sends the plan prompt here and holds the ticket', async ($, on) => {
  const { clock, prompts } = tab(on, 'sess-abc', {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `map:${PLAN_KEY}` })
  await ui.press({ key: 'run:01' })
  await ui.press({ key: 'here' })
  await clock.advance(10)
  expect(prompts.some(p => p.startsWith(PLAN_PROMPT_01))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /you$/ })).toBeDefined()
  await ui.unmount()
})

test('a session started with the plan prompt holds that plan ticket from its first turn', async ($, on) => {
  const { clock, toasts } = tab(on, 'sess-new', {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: `${PLAN_PROMPT_01} Read the other tickets in that folder for context, then do this one and tick its checklist as you go.` })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `map:${PLAN_KEY}` })
  expect(await ui.find({ type: 'Text', text: /you$/ })).toBeDefined()
  await ui.press({ key: 'run:01' })
  expect(toasts.join()).toContain('01 is not ready to start')
  await ui.unmount()
})

test('opens on the first map with open tickets, not a finished one', async ($, on) => {
  FILES['/repo/.scratch/aa-done/map.md'] = '# Map: Finished\n\n## Destination\n\nAll done.\n'
  FILES['/repo/.scratch/aa-done/issues/01-x.md'] = '# X\n\nType: wayfinder:task\nStatus: closed\n'
  DIRS['/repo/.scratch'] = ['aa-done', ...DIRS['/repo/.scratch']!]
  DIRS['/repo/.scratch/aa-done/issues'] = ['01-x.md']
  DIR_PATHS.add('/repo/.scratch/aa-done')
  try {
    const { clock } = tab(on, 'sess-abc', {})
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.advance(10)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /I4 submitted on Canvas/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /All done/ })).toBeUndefined()
    await ui.unmount()
  } finally {
    delete FILES['/repo/.scratch/aa-done/map.md']
    delete FILES['/repo/.scratch/aa-done/issues/01-x.md']
    DIRS['/repo/.scratch'] = DIRS['/repo/.scratch']!.filter(d => d !== 'aa-done')
    delete DIRS['/repo/.scratch/aa-done/issues']
    DIR_PATHS.delete('/repo/.scratch/aa-done')
  }
})
