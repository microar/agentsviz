/**
 * Live agent graph view (issue #7), redesigned for issue #40 to render as a
 * native Canvas 2D pipeline (agent-flow-style nodes/edges/particles) rather
 * than the original DOM/SVG graph. See `frontend/src/graph/` for the
 * rendering internals (layout, camera, draw-*, particles, hit-detection,
 * render-cache) — this file stays the tab-level shell: header stats,
 * legend, the fade-out-driven "which agents does the Graph tab currently
 * show" filtering (#39), the history/timeline scrubber (#43), and wiring
 * node selection to the existing agent detail drawer (#12).
 *
 * History mode (#43): dragging the Timeline scrubber sets `scrubAtMs` to a
 * past epoch-ms cutoff, which switches the tab from live store state to a
 * point-in-time snapshot reconstructed by `reconstructStateAt` (see
 * `graph/history.ts`) from the session's recorded event stream. Returning
 * to "now" (drag to the live edge, or the Live button) resets `scrubAtMs`
 * to null, which switches every derived value below straight back to the
 * live store — no separate teardown/re-init needed, since it's all just
 * `useMemo`s branching on `isHistory`.
 */

import { useMemo, useState } from 'react'
import { useEventStore } from './store'
import type { ToolCallState } from './types'
import { AgentDrawer } from './AgentDrawer'
import { GraphCanvas } from './graph/GraphCanvas'
import { useGraphFadeOut } from './graph/useGraphFadeOut'
import { useEventTimeline } from './graph/useEventTimeline'
import { reconstructStateAt } from './graph/history'
import { Timeline } from './graph/Timeline'
import { computeVisibleAgentIds, useDashboardFilter } from './filterModel'
import { STATUS_LEGEND, agentStatusLabel, type StatusFilter } from './agentStatus'

export function GraphTab() {
  const { agents, toolCalls, logs } = useEventStore()
  const { team, sessionRoot } = useDashboardFilter()
  // Selection is local UI state, independent of the store/layout — opening
  // or closing the drawer never touches agents/toolCalls/logs or the
  // stable node slots, so the live graph keeps updating underneath it
  // either way (issue #12 acceptance criterion).
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  // Timeline scrubber state (#43). null = live; otherwise an epoch-ms
  // cutoff the Graph tab renders a reconstructed snapshot as of. This is
  // local-only UI state per client, never synced over the WebSocket.
  const [scrubAtMs, setScrubAtMs] = useState<number | null>(null)

  // Status filter (clickable legend, issue #81) — same pattern as the Teams
  // tab (#80): local-only, single-select, `null` = show every status.
  // Applies on top of whichever agent map is driving the tab (live store or
  // reconstructed history snapshot) and on top of the header Team/Session
  // scope, by being folded into the `agentList` derivation below.
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null)
  const { events: timelineEvents, earliestMs, latestMs } = useEventTimeline()
  const isHistory = scrubAtMs !== null

  const historicalSnapshot = useMemo(() => {
    if (scrubAtMs === null) return null
    return reconstructStateAt(timelineEvents, scrubAtMs)
  }, [scrubAtMs, timelineEvents])

  const liveAllAgents = useMemo(() => Object.values(agents), [agents])
  // Every agentId ever seen this session (issue #49) — the store never
  // removes an agent entry once seen (see store.tsx), so `agents`' keys are
  // always the full history, not just what's currently displayed. Passed to
  // GraphCanvas so it can recognize a sub-agent (caller names a known
  // agentId) even after the top-level agent that spawned it has itself
  // faded out of the filtered `agentList` below.
  const knownAgentIds = useMemo(() => new Set(Object.keys(agents)), [agents])
  // The Graph tab is a *live* view: it shows running agents plus any that
  // stopped within the last GRACE_MS (dimmed — see graph/fade.ts), so a
  // short-lived run (a Claude Code sub-agent, a brief helper) is still
  // caught by someone glancing at the tab rather than vanishing ~250ms
  // after it stops (issue #67). Sub-agents never get removed at all
  // (#49). Older stopped agents don't accumulate here forever (#39/#45) —
  // scrub the timeline or open Teams for those. Logs/Teams read straight
  // from `agents` and are unaffected. The grace timer only makes sense in
  // live mode: a historical snapshot is already "as of" the scrubbed
  // instant, so history mode shows every agent in it at full opacity
  // instead (see GraphCanvas's `historyMode`).
  const { isRemoved } = useGraphFadeOut(liveAllAgents)

  const allAgents = isHistory && historicalSnapshot ? Object.values(historicalSnapshot.agents) : liveAllAgents

  // Header team/session scope (issue #73). `null` => no team picked, so
  // nothing is hidden. Resolved against whichever agent map is currently
  // driving the tab (the reconstructed snapshot in history mode, else the
  // live store) so session `caller`-chain membership works in both.
  const filterAgentsMap = isHistory && historicalSnapshot ? historicalSnapshot.agents : agents
  const visibleIds = useMemo(
    () => computeVisibleAgentIds({ team, sessionRoot }, filterAgentsMap, isHistory ? [] : logs),
    [team, sessionRoot, filterAgentsMap, isHistory, logs],
  )

  const agentList = useMemo(() => {
    const base = isHistory ? allAgents : allAgents.filter((a) => !isRemoved(a.agentId))
    const scoped = visibleIds ? base.filter((a) => visibleIds.has(a.agentId)) : base
    // Legend status filter (#81) — last narrowing so it composes with both
    // the fade-out/history base set and the header Team/Session scope.
    return statusFilter ? scoped.filter((a) => agentStatusLabel(a) === statusFilter) : scoped
  }, [isHistory, allAgents, isRemoved, visibleIds, statusFilter])

  const activeToolCallsAll = isHistory && historicalSnapshot ? historicalSnapshot.toolCalls : toolCalls
  // Keep only calls whose agent (or calling agent) is in the visible set,
  // so tool nodes/edges for filtered-out runs disappear with them. When the
  // legend status filter (#81) is active, `agentList` is already the fully
  // narrowed set (team/session scope ∩ status), so scope tool calls to its
  // ids; otherwise fall back to the header-scope `visibleIds` (`null` =
  // show everything) to preserve the pre-#81 behaviour exactly.
  const toolScopeIds = useMemo(
    () => (statusFilter ? new Set(agentList.map((a) => a.agentId)) : visibleIds),
    [statusFilter, agentList, visibleIds],
  )
  const activeToolCalls = useMemo(
    () =>
      toolScopeIds
        ? activeToolCallsAll.filter(
            (c) =>
              toolScopeIds.has(c.agentId) || (c.caller !== undefined && toolScopeIds.has(c.caller)),
          )
        : activeToolCallsAll,
    [activeToolCallsAll, toolScopeIds],
  )

  const toolNames = useMemo(() => {
    const seen = new Set<string>()
    for (const call of activeToolCalls) seen.add(call.tool)
    return [...seen]
  }, [activeToolCalls])

  // One edge per (caller agent, tool) pair, reflecting the most recent
  // call — later entries in toolCalls overwrite earlier ones for the
  // same key, so a settled edge can flip back to "active" if the same
  // agent calls the same tool again.
  const edges = useMemo(() => {
    const byKey = new Map<string, ToolCallState>()
    for (const call of activeToolCalls) {
      const source = call.caller ?? call.agentId
      byKey.set(`${source}::${call.tool}`, call)
    }
    return [...byKey.entries()].map(([key, call]) => ({ key, call, source: call.caller ?? call.agentId }))
  }, [activeToolCalls])

  const running = agentList.filter((a) => a.status === 'running').length

  // Friendly wording for the active legend filter (#81), e.g. `stale` ->
  // "presumed stopped" — used in the empty-state copy.
  const statusFilterLabel = statusFilter
    ? (STATUS_LEGEND.find((s) => s.status === statusFilter)?.label ?? statusFilter)
    : null

  // Stopped agents that have already aged out of the live view's grace
  // window (see graph/fade.ts) — i.e. runs that happened but are no longer
  // drawn. Surfaced in the live empty-state so a user who looked a moment
  // too late knows a run happened and where to find it.
  const agedOutRuns = liveAllAgents.filter((a) => a.status === 'stopped' && isRemoved(a.agentId)).length

  // A timeline is worth showing as soon as *any* event has ever been
  // recorded this session, even if the live view currently has nothing to
  // show (e.g. every agent has fully faded out per #39) — the user may
  // still want to scrub back to when something was happening.
  const hasTimeline = earliestMs !== null && latestMs !== null

  if (agentList.length === 0 && !hasTimeline) {
    return (
      <div>
        <h2>Graph</h2>
        <p className="empty-state">No agents yet — waiting for live data.</p>
      </div>
    )
  }

  return (
    <div>
      <h2>Graph</h2>

      {hasTimeline && (
        <Timeline earliestMs={earliestMs} latestMs={latestMs} scrubAtMs={scrubAtMs} onScrub={setScrubAtMs} />
      )}

      {/*
        Header stats/legend/hint stay mounted in every filter state (they
        just show zeroed counts when nothing is visible), so toggling the
        header Team/Session filter never changes the panel's height by
        adding or removing this block — see issue #75.
      */}
      <ul className="stat-list graph-stats">
        <li>
          <strong>{agentList.length}</strong> agent{agentList.length === 1 ? '' : 's'} shown ({running} running)
        </li>
        <li>
          <strong>{activeToolCalls.length}</strong> tool call{activeToolCalls.length === 1 ? '' : 's'} recorded
        </li>
      </ul>

      {/*
        The four *status* swatches double as single-select toggle filters
        (issue #81, matching the Teams tab) — click one to narrow the graph
        to agents with that status, click it again (or "clear filter") to
        reset. The three edge/link swatches below stay plain, non-interactive
        spans: they describe edge styling, not something you can filter on.
      */}
      <div className="graph-legend" role="group" aria-label="Filter agents by status">
        {STATUS_LEGEND.map(({ status, label }) => {
          const active = statusFilter === status
          return (
            <button
              key={status}
              type="button"
              className={`graph-legend-item graph-legend-item--filter${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() => setStatusFilter((cur) => (cur === status ? null : status))}
            >
              <span className={`graph-swatch graph-swatch--${status}`} /> {label}
            </button>
          )
        })}
        {statusFilter && (
          <button type="button" className="graph-legend-clear" onClick={() => setStatusFilter(null)}>
            clear filter
          </button>
        )}
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--pending" /> tool call active</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--settled" /> tool call settled</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--subagent" /> subagent link</span>
      </div>
      <p className="graph-hint">Drag to pan, scroll/pinch to zoom, click a node to inspect.</p>

      {agentList.length === 0 ? (
        // Same fixed-size frame as GraphCanvas's own `.graph-canvas-wrap`,
        // so a filter selection with no currently-visible agents shows the
        // "no agents" copy centered inside the panel instead of collapsing
        // it to a single line of text (issue #75).
        <div
          className={`graph-canvas-wrap graph-canvas-wrap--placeholder${
            isHistory ? ' graph-canvas-wrap--history' : ''
          }`}
        >
          <p className="empty-state">
            {statusFilter
              ? // Legend status filter (#81) took precedence over the header
                // scope / history / aged-out copy below — nothing in the
                // current agent map carries the selected status.
                `No ${isHistory ? '' : 'visible '}agents have status “${statusFilterLabel}”.`
              : isHistory
                ? 'No agents were active at this point in time.'
                : visibleIds
                  ? 'No agents match the current team/session filter.'
                  : agedOutRuns > 0
                    ? `No active agents right now. ${agedOutRuns} agent${agedOutRuns === 1 ? '' : 's'} ran earlier this session — scrub back on the timeline above, or open the Teams tab, to see them.`
                    : 'No active agents right now. Recently-stopped agents linger here briefly; scrub back on the timeline above, or open the Teams tab, to see past activity.'}
          </p>
        </div>
      ) : (
        <GraphCanvas
          allAgents={agentList}
          toolNames={toolNames}
          edges={edges}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          knownAgentIds={knownAgentIds}
          historyMode={isHistory}
        />
      )}

      <AgentDrawer
        agent={selectedAgentId ? (agents[selectedAgentId] ?? null) : null}
        toolCalls={toolCalls}
        logs={logs}
        onClose={() => setSelectedAgentId(null)}
      />
    </div>
  )
}
