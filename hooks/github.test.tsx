import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { WfMap } from '../types'

// A repository with one GitHub map and no local one, served through a fake `gh`.
const ROOT = '/repo'
const START = Date.UTC(2026, 10, 10, 12)
const MAP_BODY = '## Destination\n\nA game in the stores.\n'

const issue = (number: number, title: string, type: string, extra: { closed?: boolean; blockedBy?: number[]; body?: string } = {}) => ({
  number,
  title,
  state: extra.closed ? 'CLOSED' : 'OPEN',
  url: `https://github.com/o/r/issues/${number}`,
  body: extra.body ?? '',
  labels: { nodes: [{ name: `wayfinder:${type}` }] },
  assignees: { nodes: [] },
  blockedBy: { nodes: (extra.blockedBy ?? []).map(n => ({ number: n })) },
})
const SUB_ISSUES = [
  issue(2, 'Which engines exist', 'research', { closed: true }),
  issue(3, 'Pick the engine', 'grilling', { blockedBy: [2] }),
  issue(4, 'Build the loop', 'task', { blockedBy: [3] }),
  issue(5, 'Write the listing', 'task', { body: 'Blocked by: #3\n' }), // no native blocker: the body line counts
]
const page = (nodes: unknown[]) => JSON.stringify({ data: { repository: { issue: { subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } })

const PANE = {
  plugin: 'wayfinder-sidebar',
  component: 'Pane',
  requestId: 'wayfinder',
  surface: 'terminal',
  props: { title: 'ship the game', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Run = { exitCode: number; stdout: string; stderr?: string }

/** One tab's world. `graphql` answers each `gh api graphql` call; `store` is what the tabs share. */
function tab(on: On, store: Record<string, unknown>, graphql: (query: string) => Run, mapBody = MAP_BODY) {
  const calls: string[][] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'sess-abc' }))
  on('env.get', (_, e) => ({ value: e.name === 'TMPDIR' ? '/tmp' : '/home' }))
  on('command.register', () => ({ value: { command: 'wayfinder-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: START })
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_, e) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [] } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    let r: Run = { exitCode: 1, stdout: '', stderr: `unexpected: ${argv.join(' ')}` }
    if (argv[0] === 'uname') r = { exitCode: 0, stdout: 'Darwin\n' }
    else if (argv[0] === 'gh') {
      calls.push(argv)
      if (argv[1] === 'repo') r = { exitCode: 0, stdout: 'o/r\n' }
      else if (argv[1] === 'issue') r = { exitCode: 0, stdout: JSON.stringify([{ number: 1, title: 'Map: ship the game', url: 'https://github.com/o/r/issues/1', body: mapBody }]) }
      else if (argv[1] === 'api' && argv[2] === 'graphql') r = graphql(argv.find(a => a.startsWith('query=')) ?? '')
    }
    return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const queries = () => calls.filter(a => a[2] === 'graphql').length
  return { clock, calls, queries }
}

test('a GitHub map loads its tickets and their blockers in one GraphQL request', async ($, on) => {
  const { clock, calls, queries } = tab(on, {}, () => ({ exitCode: 0, stdout: page(SUB_ISSUES) }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /A game in the stores/ })).toBeDefined()
  // 3 is ready (its blocker is closed); 4 and 5 wait on it; 2 is done.
  for (const n of [/^1 ▸$/, /^ *0 ◐$/, /^ *2 ⧗$/, /^ *✓ 1$/]) expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pick the engine/ })).toBeDefined()
  await ui.unmount()

  expect(queries()).toBe(1)
  // Never the REST sub-issue and dependency endpoints, which are rate-limited apart from the rest.
  expect(calls.some(a => a.some(x => /sub_issues|dependencies/.test(x)))).toBe(false)
  const q = calls.find(a => a[2] === 'graphql') ?? []
  expect(q).toContain('owner=o')
  expect(q).toContain('name=r')
  expect(q).toContain('number=1')
})

test('tabs share one read of GitHub, and read again once it is older than githubSeconds', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock, queries } = tab(on, store, () => ({ exitCode: 0, stdout: page(SUB_ISSUES) }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(queries()).toBe(1)
  const mine = store['github:o/r'] as { at: number; maps: WfMap[] }
  expect(mine.maps[0]?.tickets.length).toBe(4)

  // Another tab reads GitHub 30 seconds later and finds 3 claimed.
  await clock.advance(30_000)
  const theirs = mine.maps.map(m => ({ ...m, tickets: m.tickets.map(t => (t.id === '#3' ? { ...t, assignee: 'sam' } : t)) }))
  store['github:o/r'] = { at: clock.now(), maps: theirs, fails: 0 }
  await clock.advance(40_000)
  // This tab shows that read and has not made one of its own, though 45 seconds have passed since its last.
  expect(queries()).toBe(1)
  const ui = await $.ui.mount(PANE)
  for (const n of [/^0 ▸$/, /^ *1 ◐$/]) expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
  await ui.unmount()

  await clock.advance(10_000)
  expect(queries()).toBe(2)
})

test('a failed read keeps the tickets, shows the error and waits longer each time', async ($, on) => {
  let limited = false
  const { clock, queries } = tab(on, {}, () => (limited
    ? { exitCode: 1, stdout: '{"message":"API rate limit exceeded"}', stderr: 'gh: API rate limit exceeded for user ID 1 (HTTP 403)' }
    : { exitCode: 0, stdout: page(SUB_ISSUES) }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  limited = true
  await clock.advance(50_000)
  expect(queries()).toBe(2)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^! API rate limit exceeded/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pick the engine/ })).toBeDefined()
  await ui.unmount()

  // After one failure the wait is 90 seconds, after two 180.
  await clock.advance(60_000)
  expect(queries()).toBe(2)
  await clock.advance(40_000)
  expect(queries()).toBe(3)
  await clock.advance(120_000)
  expect(queries()).toBe(3)

  limited = false
  await clock.advance(70_000)
  expect(queries()).toBe(4)
  const ok = await $.ui.mount(PANE)
  expect(await ok.find({ type: 'Text', text: /^! / })).toBeUndefined()
  await ok.unmount()
})

test('a map with no sub-issues reads the task list in its body, skipping numbers that are not issues', async ($, on) => {
  const { clock, queries } = tab(on, {}, query => (query.includes('subIssues')
    ? { exitCode: 0, stdout: page([]) }
    : {
        exitCode: 1, // gh exits 1 when any alias came back with an error
        stdout: JSON.stringify({ data: { repository: { i3: SUB_ISSUES[1], i2: SUB_ISSUES[0], i9: null } }, errors: [{ message: 'Could not resolve to an Issue with the number of 9.' }] }),
        stderr: 'gh: Could not resolve to an Issue with the number of 9.',
      }), `${MAP_BODY}\n- [ ] #3\n- [x] #2\n- [ ] #9\n`)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(queries()).toBe(2)
  const ui = await $.ui.mount(PANE)
  for (const n of [/^1 ▸$/, /^ *✓ 1$/]) expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^! / })).toBeUndefined()
  await ui.unmount()
})
