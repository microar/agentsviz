/**
 * Shared "which team / which session is the dashboard scoped to" model
 * (issue #73).
 *
 * A busy LIVE dashboard accumulates agents from many unrelated runs (20+
 * after a testing session), and there was no way to focus on "just the run
 * I care about". This module holds the two-level selection (a team, then a
 * root session within it) plus the pure derivation every tab needs:
 *
 *  - `listTeams` / `listSessionRoots` populate the two header dropdowns.
 *  - `computeVisibleAgentIds` turns a selection into the set of agentIds a
 *    tab should render — `null` means "no team selected, show everything".
 *
 * Kept deliberately React-free apart from the tiny context/hook at the
 * bottom: the derivation functions are pure so `frontend/scripts/`'s
 * `verify-filter-model.mjs` can import and exercise them directly (Node
 * strips the types), and so all three tabs share one implementation of
 * "root agent + session membership" rather than re-deriving it.
 *
 * "Root agent" mirrors the negation of `graph/graphModel.ts`'s `isSubAgent`: an
 * agent is a root unless its `caller` names another *known* agent. A
 * session is that root plus every agent that belongs to it — by the
 * hooks-emitter `${session_id}-${agent_id}` id scheme, or by its `caller`
 * chain resolving back to the root (covers instrumentation agents with
 * arbitrary ids).
 */

import { createContext, useContext } from 'react'
import type { AgentState } from './types'

/** Sentinel option values for the two dropdowns (also their defaults). */
export const ALL_TEAMS = '__all_teams__'
export const ALL_SESSIONS = '__all_sessions__'

const STORAGE_KEY = 'agentsviz:dashboard-filter'

/** Minimal shape the derivation needs off a log line — `LogEntry` satisfies it. */
export interface TeamTaggedEntry {
  agentId: string
  team?: string
}

export interface FilterSelection {
  /** `ALL_TEAMS` or a specific `agent.team`. */
  team: string
  /** `ALL_SESSIONS` or a specific root agentId within the selected team. */
  sessionRoot: string
}

export const DEFAULT_SELECTION: FilterSelection = {
  team: ALL_TEAMS,
  sessionRoot: ALL_SESSIONS,
}

export interface DashboardFilterValue extends FilterSelection {
  /** Distinct teams currently known, sorted — options for dropdown 1. */
  teams: string[]
  /** Root agentIds in the selected team, sorted — options for dropdown 2. */
  sessionRoots: string[]
  setTeam: (team: string) => void
  setSessionRoot: (root: string) => void
}

function normalizeTeam(team: string | undefined): string | undefined {
  const trimmed = team?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Maps every known agentId to its team (from an agent record, falling back
 * to any team seen on a log line for that id — `LogsTab` already treats
 * log-only agentIds as first-class). Agents with no team are simply absent.
 */
export function teamByAgentId(
  agents: Record<string, AgentState>,
  logs: readonly TeamTaggedEntry[] = [],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const agent of Object.values(agents)) {
    const team = normalizeTeam(agent.team)
    if (team) map.set(agent.agentId, team)
  }
  for (const entry of logs) {
    if (map.has(entry.agentId)) continue
    const team = normalizeTeam(entry.team)
    if (team) map.set(entry.agentId, team)
  }
  return map
}

/** Distinct teams currently known, sorted — options for the Team dropdown. */
export function listTeams(
  agents: Record<string, AgentState>,
  logs: readonly TeamTaggedEntry[] = [],
): string[] {
  const teams = new Set(teamByAgentId(agents, logs).values())
  return [...teams].sort((a, b) => a.localeCompare(b))
}

/**
 * True iff `agentId` is a root (top-level) agent: it has no `caller`, a
 * self-referential `caller`, or a `caller` that isn't itself a known agent
 * (e.g. the instrumentation library's default `caller: "user"`). A log-only
 * agentId with no record is treated as a root. Mirrors the negation of
 * `graph/graphModel.ts`'s `isSubAgent`.
 */
export function isRootAgent(
  agentId: string,
  agents: Record<string, AgentState>,
  knownAgentIds: ReadonlySet<string>,
): boolean {
  const caller = agents[agentId]?.caller
  return caller === undefined || caller === agentId || !knownAgentIds.has(caller)
}

/**
 * Root agentIds belonging to `team`, sorted — options for the Session
 * dropdown. Built from the same agentId universe as `teamByAgentId` so a
 * root that has only ever appeared on a log line still shows up.
 */
export function listSessionRoots(
  team: string,
  agents: Record<string, AgentState>,
  logs: readonly TeamTaggedEntry[] = [],
): string[] {
  if (team === ALL_TEAMS) return []
  const byId = teamByAgentId(agents, logs)
  const knownAgentIds = new Set(Object.keys(agents))
  const roots: string[] = []
  for (const [agentId, agentTeam] of byId) {
    if (agentTeam === team && isRootAgent(agentId, agents, knownAgentIds)) roots.push(agentId)
  }
  return roots.sort((a, b) => a.localeCompare(b))
}

/**
 * True iff `agentId` belongs to the session rooted at `root`: it *is* the
 * root, its id is `${root}-...` (hooks-emitter's `${session_id}-${agent_id}`
 * scheme), or its `caller` chain resolves back to `root` (instrumentation
 * agents with arbitrary ids). Cycle-safe.
 */
export function agentInSession(
  agentId: string,
  root: string,
  agents: Record<string, AgentState>,
): boolean {
  if (agentId === root || agentId.startsWith(`${root}-`)) return true
  const seen = new Set<string>()
  let current = agentId
  while (!seen.has(current)) {
    seen.add(current)
    const caller = agents[current]?.caller
    if (caller === undefined || caller === current) return false
    if (caller === root) return true
    current = caller
  }
  return false
}

/**
 * The set of agentIds a tab should render given the current selection, or
 * `null` when no team is selected (meaning "don't filter — show
 * everything"). With a team selected the set is every agent in that team,
 * further narrowed to one session if a root is chosen.
 */
export function computeVisibleAgentIds(
  selection: FilterSelection,
  agents: Record<string, AgentState>,
  logs: readonly TeamTaggedEntry[] = [],
): Set<string> | null {
  if (selection.team === ALL_TEAMS) return null
  const byId = teamByAgentId(agents, logs)
  const visible = new Set<string>()
  for (const [agentId, team] of byId) {
    if (team !== selection.team) continue
    if (
      selection.sessionRoot !== ALL_SESSIONS &&
      !agentInSession(agentId, selection.sessionRoot, agents)
    ) {
      continue
    }
    visible.add(agentId)
  }
  return visible
}

/**
 * Validates a raw (possibly persisted) selection against current state:
 * drops a team that no longer exists and a session root that no longer
 * exists, each falling back to its default. Never throws.
 */
export function resolveSelection(
  raw: FilterSelection,
  agents: Record<string, AgentState>,
  logs: readonly TeamTaggedEntry[] = [],
): FilterSelection {
  const team = raw.team !== ALL_TEAMS && listTeams(agents, logs).includes(raw.team) ? raw.team : ALL_TEAMS
  if (team === ALL_TEAMS) return DEFAULT_SELECTION
  const sessionRoot =
    raw.sessionRoot !== ALL_SESSIONS && listSessionRoots(team, agents, logs).includes(raw.sessionRoot)
      ? raw.sessionRoot
      : ALL_SESSIONS
  return { team, sessionRoot }
}

/** Reads the persisted selection; tolerates `localStorage` being absent/empty/corrupt. */
export function loadPersistedSelection(): FilterSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SELECTION
    const parsed = JSON.parse(raw) as Partial<FilterSelection>
    return {
      team: typeof parsed.team === 'string' ? parsed.team : ALL_TEAMS,
      sessionRoot: typeof parsed.sessionRoot === 'string' ? parsed.sessionRoot : ALL_SESSIONS,
    }
  } catch {
    return DEFAULT_SELECTION
  }
}

/** Persists the raw selection; a `localStorage` failure is swallowed. */
export function savePersistedSelection(selection: FilterSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // no-op — private mode / storage disabled / quota
  }
}

export const DashboardFilterContext = createContext<DashboardFilterValue | null>(null)

/** Read the shared team/session selection from any tab under the provider. */
export function useDashboardFilter(): DashboardFilterValue {
  const ctx = useContext(DashboardFilterContext)
  if (!ctx) throw new Error('useDashboardFilter must be used within a DashboardFilterProvider')
  return ctx
}
