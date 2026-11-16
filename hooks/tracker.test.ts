import { expect, test } from 'claude-code/testing'

import { budgetBar, budgetLevel, fmtTokens, gqlTicket, issuesByNumber, issuesQuery, localId, newlyReady, nextUnblocked, plainText, subIssuesPage, wrapLines, parseLocalTicket, parseMapBody, statusOf } from './tracker'
import { effectiveLauncher, handoffFile, handoffRules, launchArgv, openArgv, sessionPrompt, sessionTicket, shellCommand } from './launch'
import type { WfMap } from '../types'

const FRONT = `---
title: Implement P3 pending-action confirmation
type: wayfinder:task
status: open
assignee:
blocked_by: [07-p3-confirmation.md, 09-implement-identity-and-sessions.md]
---

## Question

How do we confirm payments?
`

const SKILL_DOC = `# P4: verifiable action receipts

Type: grilling
Status: claimed
Blocked by: 01

## Question
What goes in a receipt?
`

test('reads the frontmatter shape', async () => {
  const t = parseLocalTicket('14-implement-p3-confirmation.md', FRONT, '/x/14.md')
  expect(t.id).toBe('14')
  expect(t.title).toBe('Implement P3 pending-action confirmation')
  expect(t.type).toBe('task')
  expect(t.hitl).toBe(false)
  expect(t.closed).toBe(false)
  expect(t.assignee).toBe('')
  expect(t.blockedBy).toEqual(['07', '09'])
})

test("reads the skill doc's shape", async () => {
  const t = parseLocalTicket('08-p4-receipts.md', SKILL_DOC, '/x/08.md')
  expect(t.title).toBe('P4: verifiable action receipts')
  expect(t.type).toBe('grilling')
  expect(t.hitl).toBe(true)
  expect(t.assignee).toBe('claimed')
  expect(t.blockedBy).toEqual(['01'])
})

test('a task is HITL only when marked', async () => {
  const t = parseLocalTicket('21-submit.md', FRONT.replace('assignee:', 'assignee:\nhitl: true'), '/x')
  expect(t.hitl).toBe(true)
  expect(localId('#57')).toBe('#57')
})

test('status and newly unblocked tickets', async () => {
  const a = parseLocalTicket('07-p3.md', SKILL_DOC.replace('Status: claimed', 'Status: open').replace('Blocked by: 01', ''), '/7')
  const b = parseLocalTicket('14-x.md', FRONT.replace('09-implement-identity-and-sessions.md', ''), '/14')
  const none = new Set<string>()
  expect(statusOf(b, [a, b], none)).toBe('blocked')
  const closedA = { ...a, closed: true }
  expect(statusOf(b, [closedA, b], none)).toBe('ready')
  expect(newlyReady([a, b], [closedA, b])).toEqual(['14'])
})

test('map header', async () => {
  const h = parseMapBody('# Map: I4 Agent Security\n\n## Destination\n\nI4 submitted.\n\n## Decisions so far\n\n- [a](x): y\n\n## Not yet specified\n\n- write-ups\n', 'x')
  expect(h.title).toBe('I4 Agent Security')
  expect(h.destination).toBe('I4 submitted.')
  expect(h.decisions).toBe(1)
  expect(h.fog).toEqual(['write-ups'])
})

test('launch command and handoff path', async () => {
  const m: WfMap = { key: '/r/.scratch/w/map.md', tracker: 'local', relPath: '.scratch/w/map.md', title: 'I4 Agent Security', destination: '', fog: [], decisions: 0, tickets: [] }
  const t = parseLocalTicket('07-p3.md', SKILL_DOC, '/7')
  const p = handoffFile('/tmp/', m, ['07', '08'], Date.UTC(2026, 10, 4, 12, 0, 0))
  expect(p.startsWith('/tmp/wayfinder-handoffs/i4-agent-security-07-08-')).toBe(true)
  expect(sessionPrompt(m, t, undefined)).toBe('/wayfinder .scratch/w/map.md 07')
  expect(sessionPrompt(m, t, p)).toContain(`read the "## 07" section of ${p}`)
  expect(sessionTicket('.scratch/w/map.md 07', [{ ...m, tickets: [t] }])).toEqual({ mapKey: m.key, id: '07' })
  expect(sessionTicket(sessionPrompt(m, t, p).slice('/wayfinder '.length), [{ ...m, tickets: [t] }])).toEqual({ mapKey: m.key, id: '07' })
  expect(shellCommand("/a b/it's", 'x')).toBe(`cd '/a b/it'\\''s' && claude 'x'`)
  expect(launchArgv('copy', 'x')).toBe(undefined)
  expect(launchArgv('iterm', 'say "hi"')?.join(' ')).toContain('write text "say \\"hi\\""')
  expect(handoffRules('---\nname: handoff\n---\nWrite it.\nSave to the temporary directory of the OS.\nRedact keys.')).toBe('Write it.\nRedact keys.')
})

test('platform fallbacks', async () => {
  expect(effectiveLauncher('iterm', 'Darwin')).toBe('iterm')
  expect(effectiveLauncher('terminal', 'Linux')).toBe('copy')
  expect(effectiveLauncher('copy', 'Darwin')).toBe('copy')
  expect(openArgv('/r/t.md', '', 'Darwin')).toEqual(['open', '/r/t.md'])
  expect(openArgv('/r/t.md', '', 'Linux')).toEqual(['xdg-open', '/r/t.md'])
  expect(openArgv('/r/t.md', 'code -r', 'Linux')).toEqual(['code', '-r', '/r/t.md'])
  expect(openArgv('https://github.com/o/r/issues/1', 'code', 'Linux')).toEqual(['xdg-open', 'https://github.com/o/r/issues/1'])
})

test('next ticket a resolution unblocks', async () => {
  const t = (id: string, blockedBy: string[], closed = false) =>
    ({ id, title: `T${id}`, type: 'task' as const, hitl: false, closed, assignee: '', blockedBy })
  const all = [t('06', []), t('07', []), t('12', ['06', '07']), t('13', ['06']), t('14', ['06']), t('15', ['06'], true)]
  // 13 becomes ready once 06 closes; 12 still waits on 07; the closed 15 is not counted.
  const r = nextUnblocked(all[0]!, all)
  expect(r.next?.id).toBe('13')
  expect(r.alsoWaits).toEqual([])
  expect(r.more).toBe(2)
  // When nothing becomes ready, name the first and what else it waits on.
  const only = nextUnblocked(all[1]!, all)
  expect(only.next?.id).toBe('12')
  expect(only.alsoWaits).toEqual(['06'])
  expect(only.more).toBe(0)
  expect(nextUnblocked(all[4]!, all).next).toBe(undefined)
})

test('header text: markdown stripped, wrapped to two lines', async () => {
  expect(plainText('A **re-frozen** protocol, see [notes](n.md) and `x`  _now_')).toBe('A re-frozen protocol, see notes and x now')
  expect(plainText('snake_case_name stays')).toBe('snake_case_name stays')
  expect(wrapLines('one two three', 20, 2)).toEqual(['one two three'])
  expect(wrapLines('aaaa bbbb cccc dddd', 9, 2)).toEqual(['aaaa bbbb', 'cccc dddd'])
  expect(wrapLines('aaaa bbbb cccc dddd eeee', 9, 2)).toEqual(['aaaa bbbb', 'cccc ddd…'])
  expect(wrapLines('aaaa bbbb cc dd eeee', 9, 2)).toEqual(['aaaa bbbb', 'cc dd…'])
  expect(wrapLines('abcdefghijklmnop', 5, 2)).toEqual(['abcde', 'fghi…'])
  for (const l of wrapLines('A re-frozen experiment protocol after a prototype round (reopened 2026-10-22, ticket 14)', 30, 2)) expect(l.length <= 30).toBe(true)
})

test('context budget bar', async () => {
  expect(fmtTokens(undefined)).toBe('–')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(92_400)).toBe('92k')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(budgetLevel(100_000, 200_000)).toBe('ok')
  expect(budgetLevel(150_000, 200_000)).toBe('warn')
  expect(budgetLevel(200_000, 200_000)).toBe('over')
  expect(budgetBar(0, 200_000, 10)).toEqual({ fill: '', track: '░░░░░░░░░░' })
  expect(budgetBar(100_000, 200_000, 10)).toEqual({ fill: '█████', track: '░░░░░' })
  expect(budgetBar(105_000, 200_000, 10)).toEqual({ fill: '█████▎', track: '░░░░' })
  expect(budgetBar(900_000, 200_000, 10)).toEqual({ fill: '██████████', track: '' })
})

test('a /wayfinder prompt names the ticket its session works on, and nothing else does', async () => {
  const t = parseLocalTicket('07-p3.md', SKILL_DOC, '/7')
  const done = { ...parseLocalTicket('08-x.md', SKILL_DOC, '/8'), closed: true }
  const m: WfMap = { key: '/r/.scratch/w/map.md', tracker: 'local', relPath: '.scratch/w/map.md', title: 'W', destination: '', fog: [], decisions: 0, tickets: [t, done] }
  const g: WfMap = { key: 'gh:o/r#3', tracker: 'github', url: 'https://github.com/o/r/issues/3', title: 'G', destination: '', fog: [], decisions: 0, tickets: [{ ...t, id: '#12' }] }
  expect(sessionTicket('.scratch/w/map.md 07', [m, g])).toEqual({ mapKey: m.key, id: '07' })
  expect(sessionTicket('https://github.com/o/r/issues/3 #12', [m, g])).toEqual({ mapKey: g.key, id: '#12' })
  expect(sessionTicket('', [m])).toBeUndefined() // charting a new map
  expect(sessionTicket('.scratch/w/map.md', [m])).toBeUndefined() // a map, no ticket
  expect(sessionTicket('.scratch/w/map.md 08', [m])).toBeUndefined() // closed
  expect(sessionTicket('.scratch/w/map.md 99', [m])).toBeUndefined() // no such ticket
  expect(sessionTicket('.scratch/other/map.md 07', [m])).toBeUndefined() // another map
  expect(sessionTicket('what does 07 need?', [m])).toBeUndefined()
})

test('GitHub issues from GraphQL: type, claim, native blockers, and the body line without them', async () => {
  const node = { number: 13, title: 'Rough playable', state: 'OPEN', url: 'https://github.com/o/r/issues/13', body: 'Blocked by: #8\n', labels: { nodes: [{ name: 'wayfinder:prototype' }] }, assignees: { nodes: [{ login: 'sam' }] }, blockedBy: { nodes: [{ number: 19 }, null, { number: 10 }] } }
  const t = gqlTicket(node)
  expect(t.id).toBe('#13')
  expect(t.type).toBe('prototype')
  expect(t.hitl).toBe(true)
  expect(t.assignee).toBe('sam')
  expect(t.blockedBy).toEqual(['#19', '#10'])
  expect(t.url).toBe('https://github.com/o/r/issues/13')
  expect(gqlTicket({ ...node, blockedBy: { nodes: [] } }).blockedBy).toEqual(['#8'])
  expect(gqlTicket({ ...node, blockedBy: undefined, state: 'CLOSED' }).closed).toBe(true)

  const page = subIssuesPage({ repository: { issue: { subIssues: { pageInfo: { hasNextPage: true, endCursor: 'MjA' }, nodes: [node, null] } } } })
  expect(page.issues.length).toBe(1)
  expect(page.next).toBe('MjA')
  expect(() => subIssuesPage({ repository: { issue: null } })).toThrow()

  expect(issuesQuery([3, 12], true)).toContain('i12:issue(number:12){')
  expect(issuesQuery([3], false).includes('blockedBy')).toBe(false)
  expect(issuesByNumber({ repository: { i12: node, i3: null } }, [3, 12]).map(i => i.number)).toEqual([13])
})
