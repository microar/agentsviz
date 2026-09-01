/**
 * Team/hierarchy grouping view (issue #9).
 *
 * Groups agents by their `team` field (a flat optional string per
 * docs/event-schema.md — there's no nested-team concept in the schema, so
 * a flat "team header + member list" layout is the correct scope here,
 * not a deep org-chart).
 *
 * Reads straight from the shared event store (see store.tsx), so it
 * updates live as agent_start/agent_stop events flow in — no local
 * caching of agent state. Status colors/badges reuse the same
 * running/stopped/error conventions established in Graph.tsx (issue #7)
 * for visual consistency across tabs.
 *
 * Agents with no team (or an empty-string team) are grouped under an
 * "Ungrouped" bucket instead of being dropped, satisfying the "reasonable
 * fallback for ungrouped agents" acceptance criterion. That bucket is
 * always rendered last so real teams stay at the top.
 */

import { useMemo } from 'react'
import { useEventStore } from './store'
import { computeVisibleAgentIds, useDashboardFilter } from './filterModel'
import type { AgentState } from './types'

const UNGROUPED = 'Ungrouped'

function agentStatusLabel(agent: AgentState): 'running' | 'stopped' | 'error' | 'stale' {
  if (agent.status === 'running') return 'running'
  // A presumed (not explicitly reported) stop gets its own label — see
  // Graph.tsx's agentStatusClass for the same priority reasoning.
  if (agent.inferred) return 'stale'
  if (agent.stopStatus === 'error') return 'error'
  return 'stopped'
}

/**
 * Groups agents by team, normalizing missing/empty team to an "Ungrouped"
 * bucket. `visibleIds` (issue #73) is the header team/session scope: when
 * non-null, agents outside it are dropped, so a selected team shows only
 * its own card and a selected session only that root's agents within it.
 */
function groupByTeam(
  agents: Record<string, AgentState>,
  visibleIds: Set<string> | null,
): Map<string, AgentState[]> {
  const groups = new Map<string, AgentState[]>()
  for (const agent of Object.values(agents)) {
    if (visibleIds && !visibleIds.has(agent.agentId)) continue
    const key = agent.team && agent.team.trim() !== '' ? agent.team : UNGROUPED
    const list = groups.get(key)
    if (list) {
      list.push(agent)
    } else {
      groups.set(key, [agent])
    }
  }
  return groups
}

export function TeamsTab() {
  const { agents } = useEventStore()
  const { team, sessionRoot } = useDashboardFilter()

  const visibleIds = useMemo(
    () => computeVisibleAgentIds({ team, sessionRoot }, agents),
    [team, sessionRoot, agents],
  )

  const groups = useMemo(() => groupByTeam(agents, visibleIds), [agents, visibleIds])

  const teamEntries = useMemo(() => {
    const named = [...groups.entries()]
      .filter(([teamName]) => teamName !== UNGROUPED)
      .sort(([a], [b]) => a.localeCompare(b))
    const ungrouped = groups.get(UNGROUPED)
    return ungrouped ? [...named, [UNGROUPED, ungrouped] as [string, AgentState[]]] : named
  }, [groups])

  const totalAgents = teamEntries.reduce((sum, [, members]) => sum + members.length, 0)
  const isFiltered = visibleIds !== null

  if (totalAgents === 0) {
    return (
      <div>
        <h2>Teams</h2>
        <p className="empty-state">
          {isFiltered
            ? 'No agents match the current team/session filter.'
            : 'No agents yet — waiting for live data.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2>Teams</h2>
      <ul className="stat-list graph-stats">
        <li>
          <strong>{teamEntries.length}</strong> team{teamEntries.length === 1 ? '' : 's'} seen
        </li>
        <li>
          <strong>{totalAgents}</strong> agent{totalAgents === 1 ? '' : 's'} total
        </li>
      </ul>

      <div className="graph-legend">
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--running" /> running</span>
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--stopped" /> stopped</span>
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--error" /> error</span>
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--stale" /> presumed stopped</span>
      </div>

      <div className="team-groups">
        {teamEntries.map(([team, members]) => {
          const runningCount = members.filter((a) => a.status === 'running').length
          const sortedMembers = [...members].sort((a, b) => a.agentId.localeCompare(b.agentId))
          return (
            <section key={team} className={`team-card${team === UNGROUPED ? ' team-card--ungrouped' : ''}`}>
              <header className="team-card-header">
                <h3 className="team-card-name">{team}</h3>
                <span className="team-card-count">
                  {members.length} agent{members.length === 1 ? '' : 's'} ({runningCount} running)
                </span>
              </header>
              <ul className="team-agent-list">
                {sortedMembers.map((agent) => {
                  const status = agentStatusLabel(agent)
                  return (
                    <li key={agent.agentId} className="team-agent">
                      <span className={`team-agent-dot team-agent-dot--${status}`} />
                      <span className="team-agent-id" title={agent.agentId}>
                        {agent.agentId}
                      </span>
                      <span className={`team-agent-status team-agent-status--${status}`}>{status}</span>
                      {agent.caller && (
                        <span className="team-agent-caller" title={agent.caller}>
                          via {agent.caller}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
