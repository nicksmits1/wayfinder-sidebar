import { expect, test } from 'claude-code/testing'

import { budgetBar, budgetLevel, fmtTokens, isPlanFile, localId, newlyReady, nextUnblocked, plainText, wrapLines, parseLocalTicket, parseMapBody, statusOf } from './tracker'
import { DEFAULT_PLAN_PROMPT, effectiveLauncher, handoffFile, handoffRules, launchArgv, openArgv, planTicket, sessionPrompt, sessionTicket, shellCommand } from './launch'
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

// ---------- plain plans and looser ticket headers ----------

// Shaped like a real plan folder: numbered checklists with inline bold fields, no Type or Status.
const PLAN_TICKET = `# Update #1 on prod + install cron

**When:** Thu 11-12, after the merge and pull · **Owner:** Nick · **Depends on:** 02

- [ ] Policy confirmed
- [x] Pick warm prod verify ids
`

test('a plain plan ticket: inline bold fields, Depends on, Owner is not a claim', async () => {
  const t = parseLocalTicket('03-update-1-and-cron.md', PLAN_TICKET, '/p/03.md', { plan: true })
  expect(t.id).toBe('03')
  expect(t.title).toBe('Update #1 on prod + install cron')
  expect(t.type).toBe('task')
  expect(t.warning).toBeUndefined()
  expect(t.closed).toBe(false)
  expect(t.assignee).toBe('')
  expect(t.blockedBy).toEqual(['02'])
  const two = parseLocalTicket('08-x.md', PLAN_TICKET.replace('**Depends on:** 02', '**Depends on:** 03, 07'), '/p/08.md', { plan: true })
  expect(two.blockedBy).toEqual(['03', '07'])
})

test('a ticket with no Status line closes when every checkbox is ticked', async () => {
  const done = PLAN_TICKET.replace('- [ ] Policy', '- [x] Policy')
  expect(parseLocalTicket('03-x.md', done, '/p', { plan: true }).closed).toBe(true)
  expect(parseLocalTicket('03-x.md', '# No boxes\n\nJust prose.\n', '/p', { plan: true }).closed).toBe(false)
  // An explicit Status wins over the boxes.
  expect(parseLocalTicket('03-x.md', `${done}\nStatus: open\n`, '/p', { plan: true }).closed).toBe(false)
})

test('the Assignee line is the claim; none and friends are not', async () => {
  const head = (a: string) => `# X\n\nType: wayfinder:grilling\nStatus: open\nAssignee: ${a}\nBlocked by: none\n`
  expect(parseLocalTicket('12-x.md', head('nicksmits1'), '/x').assignee).toBe('nicksmits1')
  for (const a of ['none', 'None', '-', 'unassigned', 'nobody']) expect(parseLocalTicket('12-x.md', head(a), '/x').assignee).toBe('')
  const t = parseLocalTicket('12-x.md', head('nicksmits1'), '/x')
  expect(statusOf(t, [t], new Set())).toBe('claimed')
  // A closed ticket keeps no claim.
  expect(parseLocalTicket('12-x.md', head('nicksmits1').replace('open', 'closed'), '/x').assignee).toBe('')
})

test('Blocked by: none with a note is no blocker', async () => {
  const t = parseLocalTicket('10-x.md', '# X\n\nType: wayfinder:grilling\nStatus: open\nBlocked by: none (08 and 09 closed)\n', '/x')
  expect(t.blockedBy).toEqual([])
})

test('wayfinder tickets without a type still warn; plan tickets default to task', async () => {
  expect(parseLocalTicket('01-x.md', '# X\n\nStatus: open\n', '/x').warning).toBe('no ticket type found')
  expect(parseLocalTicket('01-x.md', '# X\n\nType: wayfinder:task (HITL)\n', '/x', { plan: true }).hitl).toBe(true)
})

test('plan files are numbered markdown files', async () => {
  for (const f of ['01-rtest-dry-run.md', '3_x.md', '12-a.md']) expect(isPlanFile(f)).toBe(true)
  for (const f of ['AGENTS.md', 'README.md', 'map.md', '01-x.txt', 'notes.md']) expect(isPlanFile(f)).toBe(false)
})

test('a plan ticket starts with the plan prompt, and that prompt names the ticket it works on', async () => {
  const t = parseLocalTicket('03-update-1-and-cron.md', PLAN_TICKET, '/r/.scratch/m3/03-update-1-and-cron.md', { plan: true })
  const m: WfMap = { key: '/r/.scratch/m3', tracker: 'local', kind: 'plan', relPath: '.scratch/m3', title: 'm3', destination: '', fog: [], decisions: 0, tickets: [t] }
  const p = sessionPrompt(m, t, undefined, DEFAULT_PLAN_PROMPT)
  expect(p.startsWith('/wayfinder')).toBe(false)
  expect(p).toContain('.scratch/m3/03-update-1-and-cron.md')
  expect(p).toContain('.scratch/m3/')
  expect(sessionPrompt(m, t, undefined, 'Do {ticket} (plan {plan})')).toBe('Do .scratch/m3/03-update-1-and-cron.md (plan .scratch/m3)')
  expect(sessionPrompt(m, t, '/tmp/h.md', DEFAULT_PLAN_PROMPT)).toContain('read the "## 03" section of /tmp/h.md')
  expect(planTicket(p, [m], DEFAULT_PLAN_PROMPT)).toEqual({ mapKey: m.key, id: '03' })
  expect(planTicket(sessionPrompt(m, t, '/tmp/h.md', DEFAULT_PLAN_PROMPT), [m], DEFAULT_PLAN_PROMPT)).toEqual({ mapKey: m.key, id: '03' })
  // Merely mentioning the file is not starting it.
  expect(planTicket('what does .scratch/m3/03-update-1-and-cron.md need?', [m], DEFAULT_PLAN_PROMPT)).toBeUndefined()
  expect(planTicket(p, [{ ...m, tickets: [{ ...t, closed: true }] }], DEFAULT_PLAN_PROMPT)).toBeUndefined()
  // A wayfinder map's tickets still start with /wayfinder.
  const w: WfMap = { ...m, kind: 'wayfinder', key: '/r/.scratch/w/map.md', relPath: '.scratch/w/map.md' }
  expect(sessionPrompt(w, t, undefined, DEFAULT_PLAN_PROMPT)).toBe('/wayfinder .scratch/w/map.md 03')
})
