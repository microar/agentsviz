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

export function GraphTab() {
  const { agents, toolCalls, logs } = useEventStore()
  // Selection is local UI state, independent of the store/layout — opening
  // or closing the drawer never touches agents/toolCalls/logs or the
  // stable node slots, so the live graph keeps updating underneath it
  // either way (issue #12 acceptance criterion).
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  // Timeline scrubber state (#43). null = live; otherwise an epoch-ms
  // cutoff the Graph tab renders a reconstructed snapshot as of. This is
  // local-only UI state per client, never synced over the WebSocket.
  const [scrubAtMs, setScrubAtMs] = useState<number | null>(null)
  const { events: timelineEvents, earliestMs, latestMs } = useEventTimeline()
  const isHistory = scrubAtMs !== null

  const historicalSnapshot = useMemo(() => {
    if (scrubAtMs === null) return null
    return reconstructStateAt(timelineEvents, scrubAtMs)
  }, [scrubAtMs, timelineEvents])

  const liveAllAgents = useMemo(() => Object.values(agents), [agents])
  // The Graph tab is a *live* view: it defaults to showing only active
  // agents, removing a just-stopped one promptly (a brief, barely
  // perceptible fade — see FADE_MS in graph/fade.ts, shortened from the
  // original 5s per issue #45) rather than letting every agent that's ever
  // run accumulate on screen forever (issue #39). Logs/Teams are
  // unaffected — they still read straight from `agents`. The fade timer
  // only makes sense in live mode: a historical snapshot is already "as
  // of" the scrubbed instant, so history mode shows every agent in it at
  // full opacity instead (see GraphCanvas's `historyMode`).
  const { isRemoved } = useGraphFadeOut(liveAllAgents)

  const allAgents = isHistory && historicalSnapshot ? Object.values(historicalSnapshot.agents) : liveAllAgents
  const agentList = useMemo(
    () => (isHistory ? allAgents : allAgents.filter((a) => !isRemoved(a.agentId))),
    [isHistory, allAgents, isRemoved],
  )

  const activeToolCalls = isHistory && historicalSnapshot ? historicalSnapshot.toolCalls : toolCalls

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

      {agentList.length === 0 ? (
        <p className="empty-state">
          {isHistory
            ? 'No agents were active at this point in time.'
            : 'No active agents right now — stopped agents are removed from this view promptly. Scrub back on the timeline above to see past activity.'}
        </p>
      ) : (
        <>
          <ul className="stat-list graph-stats">
            <li>
              <strong>{agentList.length}</strong> agent{agentList.length === 1 ? '' : 's'} shown ({running} running)
            </li>
            <li>
              <strong>{activeToolCalls.length}</strong> tool call{activeToolCalls.length === 1 ? '' : 's'} recorded
            </li>
          </ul>

          <div className="graph-legend">
            <span className="graph-legend-item"><span className="graph-swatch graph-swatch--running" /> running</span>
            <span className="graph-legend-item"><span className="graph-swatch graph-swatch--stopped" /> stopped</span>
            <span className="graph-legend-item"><span className="graph-swatch graph-swatch--error" /> error</span>
            <span className="graph-legend-item"><span className="graph-swatch graph-swatch--stale" /> presumed stopped</span>
            <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--pending" /> tool call active</span>
            <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--settled" /> tool call settled</span>
          </div>
          <p className="graph-hint">Drag to pan, scroll/pinch to zoom, click a node to inspect.</p>

          <GraphCanvas
            allAgents={agentList}
            toolNames={toolNames}
            edges={edges}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            historyMode={isHistory}
          />
        </>
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
