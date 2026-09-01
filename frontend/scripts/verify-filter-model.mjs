#!/usr/bin/env node
/**
 * Standalone verification for the header team/session filter model
 * (issue #73) — run with `node scripts/verify-filter-model.mjs` from
 * `frontend/`.
 *
 * The visible-set derivation in `src/filterModel.ts` is non-trivial (root
 * detection + session membership via the `${root}-` id scheme *and* the
 * `caller` chain, cycle-safe), and there's no component-test runner wired
 * into `frontend/` yet — so, per the repo convention of small standalone
 * `.mjs` checks (see `verify-layout.mjs` / `verify-legend-colors.mjs`),
 * this imports the real pure functions (Node strips the TS types) and
 * exercises the tricky cases directly.
 *
 * Exits non-zero (and prints which assertion failed) on any mismatch.
 */

import {
  ALL_SESSIONS,
  ALL_TEAMS,
  agentInSession,
  computeVisibleAgentIds,
  isRootAgent,
  listSessionRoots,
  listTeams,
  resolveSelection,
} from '../src/filterModel.ts'

let failures = 0
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`)
  if (!cond) failures++
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(`${label} (got ${a}, expected ${e})`, a === e)
}

const agent = (agentId, team, caller) => ({ agentId, team, caller, status: 'running' })

// A realistic-ish mixed store: two teams, each with two root sessions, each
// root with a hooks-emitter-style subagent (`${root}-sub`) and an
// instrumentation-style subagent with an arbitrary id linked only by
// `caller`.
const agents = Object.fromEntries(
  [
    agent('alpha-root-1', 'alpha'),
    agent('alpha-root-1-sub', 'alpha', 'alpha-root-1'),
    agent('helper-x1', 'alpha', 'alpha-root-1-sub'), // grandchild via caller chain
    agent('alpha-root-2', 'alpha', 'alpha-root-2'), // self-referential caller => still a root
    agent('alpha-root-2-sub', 'alpha', 'alpha-root-2'),
    agent('beta-root-1', 'beta', 'user'), // instrumentation default caller => root
    agent('beta-root-1-sub', 'beta', 'beta-root-1'),
    agent('beta-root-2', 'beta'),
  ].map((a) => [a.agentId, a]),
)

// --- root detection -------------------------------------------------------
const known = new Set(Object.keys(agents))
check('no caller => root', isRootAgent('beta-root-2', agents, known))
check('self-referential caller => root', isRootAgent('alpha-root-2', agents, known))
check('caller names a non-agent ("user") => root', isRootAgent('beta-root-1', agents, known))
check('caller names a known agent => NOT root', !isRootAgent('alpha-root-1-sub', agents, known))
check('unknown id => root (log-only, no record)', isRootAgent('ghost', agents, known))

// --- session membership -------------------------------------------------
check('root is in its own session', agentInSession('alpha-root-1', 'alpha-root-1', agents))
check('`${root}-sub` id is in session', agentInSession('alpha-root-1-sub', 'alpha-root-1', agents))
check('grandchild via caller chain is in session', agentInSession('helper-x1', 'alpha-root-1', agents))
check('sibling root is NOT in the other session', !agentInSession('alpha-root-2', 'alpha-root-1', agents))
check('other team agent is NOT in session', !agentInSession('beta-root-1', 'alpha-root-1', agents))

// caller cycle must terminate
const cyclic = { a: agent('a', 't', 'b'), b: agent('b', 't', 'a') }
check('caller cycle is safe (no hang, returns false)', agentInSession('a', 'root', cyclic) === false)

// --- dropdown option lists --------------------------------------------
eq('listTeams is sorted + distinct', listTeams(agents), ['alpha', 'beta'])
eq('listTeams folds in log-only teams', listTeams({}, [{ agentId: 'z1', team: 'zeta' }]), ['zeta'])
eq('listSessionRoots(alpha) => only alpha roots, sorted', listSessionRoots('alpha', agents), [
  'alpha-root-1',
  'alpha-root-2',
])
eq('listSessionRoots(beta) => only beta roots, sorted', listSessionRoots('beta', agents), [
  'beta-root-1',
  'beta-root-2',
])
eq('listSessionRoots(ALL_TEAMS) => []', listSessionRoots(ALL_TEAMS, agents), [])

// --- computeVisibleAgentIds -----------------------------------------
check(
  'ALL_TEAMS => null (no filtering)',
  computeVisibleAgentIds({ team: ALL_TEAMS, sessionRoot: ALL_SESSIONS }, agents) === null,
)

const alphaAll = computeVisibleAgentIds({ team: 'alpha', sessionRoot: ALL_SESSIONS }, agents)
eq(
  'team=alpha, all sessions => every alpha agent',
  [...alphaAll].sort(),
  ['alpha-root-1', 'alpha-root-1-sub', 'alpha-root-2', 'alpha-root-2-sub', 'helper-x1'],
)
check('team=alpha excludes beta agents', !alphaAll.has('beta-root-1'))

const alphaS1 = computeVisibleAgentIds({ team: 'alpha', sessionRoot: 'alpha-root-1' }, agents)
eq(
  'team=alpha, session=alpha-root-1 => root + `${root}-` id + caller-chain grandchild',
  [...alphaS1].sort(),
  ['alpha-root-1', 'alpha-root-1-sub', 'helper-x1'],
)
check('session filter excludes the sibling root session', !alphaS1.has('alpha-root-2'))

const withLogOnly = computeVisibleAgentIds({ team: 'alpha', sessionRoot: ALL_SESSIONS }, agents, [
  { agentId: 'log-only-a', team: 'alpha' },
  { agentId: 'log-only-b', team: 'beta' },
])
check('log-only agentId with matching team is visible', withLogOnly.has('log-only-a'))
check('log-only agentId with other team is not visible', !withLogOnly.has('log-only-b'))

// --- resolveSelection (persistence restore) -------------------------
eq(
  'stale team falls back to defaults',
  resolveSelection({ team: 'gone', sessionRoot: 'whatever' }, agents),
  { team: ALL_TEAMS, sessionRoot: ALL_SESSIONS },
)
eq(
  'valid team + stale session resets only the session',
  resolveSelection({ team: 'alpha', sessionRoot: 'gone' }, agents),
  { team: 'alpha', sessionRoot: ALL_SESSIONS },
)
eq(
  'fully valid selection is preserved',
  resolveSelection({ team: 'alpha', sessionRoot: 'alpha-root-1' }, agents),
  { team: 'alpha', sessionRoot: 'alpha-root-1' },
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll filter-model checks passed.')
