/**
 * Live agent graph view (issue #7). Redesigned for #40 as a native Canvas
 * 2D pipeline, then migrated to React Flow (`@xyflow/react`) in issue #87
 * so agent nodes are draggable and their edges stay attached — see
 * `frontend/src/graph/GraphFlow.tsx` (renderer), `graphModel.ts` (store →
 * nodes/edges) and `autoLayout.ts` (dagre seed positions). This file stays
 * the tab-level shell: header stats, legend, the history/timeline scrubber
 * (#43) + playback transport (#85), and wiring node selection to the
 * per-agent action view.
 *
 * Live-only view (issue #83): in live mode the Graph tab renders *only*
 * agents whose `status === 'running'`. The instant an agent stops, fails,
 * or is reaped as stale it disappears from the canvas — there is no
 * fade-out grace window anymore (the #39/#67 linger was removed). Per-agent
 * activity (tool calls, MCP calls, logs, errors) is no longer drawn as
 * persistent tool nodes/edges either; instead clicking a running agent
 * opens an action panel (`graph/GraphAgentPanel.tsx`) anchored on top of
 * that agent's node, with an `X` to close. Nothing is deleted from the
 * event store — see history mode below.
 *
 * History mode (#43): dragging the Timeline scrubber sets `scrubAtMs` to a
 * past epoch-ms cutoff, which switches the tab from live store state to a
 * point-in-time snapshot reconstructed by `reconstructStateAt` (see
 * `graph/history.ts`) from the session's recorded event stream. The
 * live-only rule is a *live-mode* rule: a reconstructed snapshot is
 * authoritative as of the scrubbed instant, so history mode still shows
 * non-running agents and their tool nodes/edges, and still uses the
 * slide-in `AgentDrawer` side panel. Returning to "now" (drag to the live
 * edge, or the Live button) resets `scrubAtMs` to null, which switches
 * every derived value below straight back to the live store.
 */

import { useMemo, useState } from 'react'
import { useEventStore } from './store'
import type { ToolCallState } from './types'
import { AgentDrawer } from './AgentDrawer'
import { GraphFlow } from './graph/GraphFlow'
import { GraphAgentPanel } from './graph/GraphAgentPanel'
import { useEventTimeline } from './graph/useEventTimeline'
import { reconstructStateAt } from './graph/history'
import { Timeline } from './graph/Timeline'
import { usePlayback } from './graph/usePlayback'
import { computeVisibleAgentIds, useDashboardFilter } from './filterModel'
import { STATUS_LEGEND, agentStatusLabel, type StatusFilter } from './agentStatus'

export function GraphTab() {
  const { agents, toolCalls, logs } = useEventStore()
  const { team, sessionRoot } = useDashboardFilter()
  // Selection is local UI state, independent of the store/layout — opening
  // or closing the action panel never touches agents/toolCalls/logs or the
  // stable node slots, so the live graph keeps updating underneath it
  // either way (issue #12 acceptance criterion).
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  // Timeline scrubber state (#43). null = live; otherwise an epoch-ms
  // cutoff the Graph tab renders a reconstructed snapshot as of. This is
  // local-only UI state per client, never synced over the WebSocket.
  const [scrubAtMs, setScrubAtMs] = useState<number | null>(null)

  // Status filter (clickable legend, issue #81) — only meaningful in
  // history mode now (issue #83): live mode shows running agents only, so
  // the stopped/error/stale toggles would be dead. Kept for history mode,
  // where a reconstructed snapshot can contain every status.
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null)
  const { events: timelineEvents, earliestMs, latestMs } = useEventTimeline()
  const isHistory = scrubAtMs !== null

  // History playback transport (issue #85). Drives `scrubAtMs` forward or
  // backward over wall-clock time (rAF loop inside the hook) at 1×/5×/10×,
  // re-running the `reconstructStateAt` memo below on each step. Local-only
  // UI state — never synced over the WebSocket, same as `scrubAtMs` itself.
  const playback = usePlayback({ scrubAtMs, earliestMs, latestMs, onScrub: setScrubAtMs })

  // What the Timeline hands back for *manual* scrubs (drag or the Live
  // button): a manual move always wins over automated playback (issue #85),
  // so pause first, then apply the position. The playback loop calls
  // `setScrubAtMs` directly and is unaffected by this wrapper.
  const handleManualScrub = (ms: number | null) => {
    playback.pause()
    setScrubAtMs(ms)
  }
  // The status filter is a no-op outside history mode — rather than reset it
  // on every mode switch (an effect), just ignore it while live. A value
  // set in history mode simply lies dormant and re-applies if the user
  // scrubs back.
  const effectiveStatusFilter = isHistory ? statusFilter : null

  const historicalSnapshot = useMemo(() => {
    if (scrubAtMs === null) return null
    return reconstructStateAt(timelineEvents, scrubAtMs)
  }, [scrubAtMs, timelineEvents])

  const liveAllAgents = useMemo(() => Object.values(agents), [agents])
  // Every agentId ever seen this session (issue #49) — the store never
  // removes an agent entry once seen (see store.tsx), so `agents`' keys are
  // always the full history, not just what's currently displayed. Passed to
  // GraphFlow so it can recognize a sub-agent (caller names a known
  // agentId) even after the top-level agent that spawned it has itself
  // dropped out of the running-only `agentList` below.
  const knownAgentIds = useMemo(() => new Set(Object.keys(agents)), [agents])

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
    // Issue #83: the live Graph is a strictly *live* view — only currently
    // running agents are drawn, and a stopped/failed/stale agent vanishes
    // immediately (no grace/fade window). History mode is authoritative for
    // its scrubbed instant, so it keeps every agent the snapshot contains.
    const base = isHistory ? allAgents : allAgents.filter((a) => a.status === 'running')
    const scoped = visibleIds ? base.filter((a) => visibleIds.has(a.agentId)) : base
    // Legend status filter (#81, history-mode-only per #83) — last
    // narrowing so it composes with the header Team/Session scope.
    return effectiveStatusFilter
      ? scoped.filter((a) => agentStatusLabel(a) === effectiveStatusFilter)
      : scoped
  }, [isHistory, allAgents, visibleIds, effectiveStatusFilter])

  const activeToolCallsAll = isHistory && historicalSnapshot ? historicalSnapshot.toolCalls : toolCalls
  // Keep only calls whose agent (or calling agent) is in the visible set,
  // so tool nodes/edges for filtered-out runs disappear with them. When the
  // legend status filter (#81) is active, `agentList` is already the fully
  // narrowed set (team/session scope ∩ status), so scope tool calls to its
  // ids; otherwise fall back to the header-scope `visibleIds` (`null` =
  // show everything) to preserve the pre-#81 behaviour exactly.
  const toolScopeIds = useMemo(
    () => (effectiveStatusFilter ? new Set(agentList.map((a) => a.agentId)) : visibleIds),
    [effectiveStatusFilter, agentList, visibleIds],
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

  // Tool nodes/edges are a *history-mode* concept now (issue #83): the live
  // graph never draws them — per-agent activity is revealed on click in
  // the anchored panel instead. Computed unconditionally (cheap, and the
  // "tool calls recorded" stat below still uses `activeToolCalls`), but
  // only handed to GraphFlow when `isHistory`.
  const toolNames = useMemo(() => {
    if (!isHistory) return []
    const seen = new Set<string>()
    for (const call of activeToolCalls) seen.add(call.tool)
    return [...seen]
  }, [isHistory, activeToolCalls])

  // One edge per (caller agent, tool) pair, reflecting the most recent
  // call — later entries in toolCalls overwrite earlier ones for the
  // same key, so a settled edge can flip back to "active" if the same
  // agent calls the same tool again.
  const edges = useMemo(() => {
    if (!isHistory) return []
    const byKey = new Map<string, ToolCallState>()
    for (const call of activeToolCalls) {
      const source = call.caller ?? call.agentId
      byKey.set(`${source}::${call.tool}`, call)
    }
    return [...byKey.entries()].map(([key, call]) => ({ key, call, source: call.caller ?? call.agentId }))
  }, [isHistory, activeToolCalls])

  const running = agentList.filter((a) => a.status === 'running').length

  // Friendly wording for the active legend filter (#81), e.g. `stale` ->
  // "presumed stopped" — used in the empty-state copy.
  const statusFilterLabel = effectiveStatusFilter
    ? (STATUS_LEGEND.find((s) => s.status === effectiveStatusFilter)?.label ?? effectiveStatusFilter)
    : null

  // Runs that happened earlier this session but aren't running now — with
  // the live view being running-only (issue #83) these are simply every
  // non-running agent in the store. Surfaced in the live empty-state so a
  // user who looked a moment too late knows a run happened and where to
  // find it (timeline scrubber / Teams tab).
  const pastRunCount = liveAllAgents.filter((a) => a.status !== 'running').length

  // A timeline is worth showing as soon as *any* event has ever been
  // recorded this session, even if the live view currently has nothing to
  // show — the user may still want to scrub back to when something was
  // happening.
  const hasTimeline = earliestMs !== null && latestMs !== null

  const selectedAgent = selectedAgentId ? (agents[selectedAgentId] ?? null) : null

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
        <Timeline
          earliestMs={earliestMs}
          latestMs={latestMs}
          scrubAtMs={scrubAtMs}
          onScrub={handleManualScrub}
          playback={playback}
        />
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
        Status swatches double as single-select toggle filters (issue #81)
        only in *history* mode (issue #83): live mode is running-only, so
        those toggles have nothing to act on and are hidden. The three
        edge/link swatches stay as plain, non-interactive spans in both
        modes — they describe canvas edge styling, not a filter.
      */}
      <div
        className="graph-legend"
        role={isHistory ? 'group' : undefined}
        aria-label={isHistory ? 'Filter agents by status' : undefined}
      >
        {isHistory &&
          STATUS_LEGEND.map(({ status, label }) => {
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
        {isHistory && statusFilter && (
          <button type="button" className="graph-legend-clear" onClick={() => setStatusFilter(null)}>
            clear filter
          </button>
        )}
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--pending" /> tool call active</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--settled" /> tool call settled</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--subagent" /> subagent link</span>
      </div>
      <p className="graph-hint">
        Drag a node to reposition it, drag the background to pan, scroll/pinch to zoom
        {isHistory ? ', click a node to inspect.' : ', click a running agent to see its actions.'}
      </p>

      {agentList.length === 0 ? (
        // Same fixed-size frame as GraphFlow's own `.graph-canvas-wrap`,
        // so a filter selection with no currently-visible agents shows the
        // "no agents" copy centered inside the panel instead of collapsing
        // it to a single line of text (issue #75).
        <div
          className={`graph-canvas-wrap graph-canvas-wrap--placeholder${
            isHistory ? ' graph-canvas-wrap--history' : ''
          }`}
        >
          <p className="empty-state">
            {effectiveStatusFilter
              ? // Legend status filter (#81) took precedence over the header
                // scope / history / past-runs copy below — nothing in the
                // snapshot carries the selected status.
                `No agents in this snapshot have status “${statusFilterLabel}”.`
              : isHistory
                ? 'No agents were active at this point in time.'
                : visibleIds
                  ? 'No running agents match the current team/session filter.'
                  : pastRunCount > 0
                    ? `No agents are running right now. ${pastRunCount} agent${pastRunCount === 1 ? '' : 's'} ran earlier this session — scrub back on the timeline above, or open the Teams tab, to see them.`
                    : 'No agents are running right now. Scrub back on the timeline above, or open the Teams tab, to see past activity.'}
          </p>
        </div>
      ) : (
        <GraphFlow
          allAgents={agentList}
          toolNames={toolNames}
          edges={edges}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          knownAgentIds={knownAgentIds}
          historyMode={isHistory}
          anchoredPanel={
            // Live mode only: the per-agent action panel, anchored over the
            // selected node by GraphFlow via <NodeToolbar> (issue #83/#87).
            // History mode keeps the slide-in AgentDrawer below instead.
            !isHistory && selectedAgent && selectedAgent.status === 'running' ? (
              <GraphAgentPanel
                agent={selectedAgent}
                toolCalls={toolCalls}
                logs={logs}
                onClose={() => setSelectedAgentId(null)}
              />
            ) : undefined
          }
        />
      )}

      {/*
        History mode keeps the original slide-in side drawer (issue #83:
        "pick whichever is less code" — reusing the existing component is).
        In live mode the drawer is never rendered; the anchored panel above
        takes its place.
      */}
      {isHistory && (
        <AgentDrawer
          agent={selectedAgentId ? (agents[selectedAgentId] ?? null) : null}
          toolCalls={toolCalls}
          logs={logs}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  )
}
