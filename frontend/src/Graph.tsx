/**
 * Live agent graph view (issue #7), redesigned for issue #40 to render as a
 * native Canvas 2D pipeline (agent-flow-style nodes/edges/particles) rather
 * than the original DOM/SVG graph. See `frontend/src/graph/` for the
 * rendering internals (layout, camera, draw-*, particles, hit-detection,
 * render-cache) — this file stays the tab-level shell: header stats,
 * legend, the fade-out-driven "which agents does the Graph tab currently
 * show" filtering (#39), and wiring node selection to the existing agent
 * detail drawer (#12).
 */

import { useMemo, useState } from 'react'
import { useEventStore } from './store'
import type { ToolCallState } from './types'
import { AgentDrawer } from './AgentDrawer'
import { GraphCanvas } from './graph/GraphCanvas'
import { useGraphFadeOut } from './graph/useGraphFadeOut'

export function GraphTab() {
  const { agents, toolCalls, logs } = useEventStore()
  // Selection is local UI state, independent of the store/layout — opening
  // or closing the drawer never touches agents/toolCalls/logs or the
  // stable node slots, so the live graph keeps updating underneath it
  // either way (issue #12 acceptance criterion).
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  const allAgents = useMemo(() => Object.values(agents), [agents])
  // The Graph tab is a *live* view: it defaults to showing only active
  // agents, fading a just-stopped one out over ~5s rather than letting
  // every agent that's ever run accumulate on screen forever (issue #39).
  // Logs/Teams are unaffected — they still read straight from `agents`.
  const { isRemoved } = useGraphFadeOut(allAgents)
  const agentList = useMemo(() => allAgents.filter((a) => !isRemoved(a.agentId)), [allAgents, isRemoved])

  const toolNames = useMemo(() => {
    const seen = new Set<string>()
    for (const call of toolCalls) seen.add(call.tool)
    return [...seen]
  }, [toolCalls])

  // One edge per (caller agent, tool) pair, reflecting the most recent
  // call — later entries in toolCalls overwrite earlier ones for the
  // same key, so a settled edge can flip back to "active" if the same
  // agent calls the same tool again.
  const edges = useMemo(() => {
    const byKey = new Map<string, ToolCallState>()
    for (const call of toolCalls) {
      const source = call.caller ?? call.agentId
      byKey.set(`${source}::${call.tool}`, call)
    }
    return [...byKey.entries()].map(([key, call]) => ({ key, call, source: call.caller ?? call.agentId }))
  }, [toolCalls])

  const running = agentList.filter((a) => a.status === 'running').length

  if (agentList.length === 0) {
    const message =
      allAgents.length === 0
        ? 'No agents yet — waiting for live data.'
        : 'No active agents right now — stopped agents fade out of this view within 5s.'
    return (
      <div>
        <h2>Graph</h2>
        <p className="empty-state">{message}</p>
      </div>
    )
  }

  return (
    <div>
      <h2>Graph</h2>
      <ul className="stat-list graph-stats">
        <li>
          <strong>{agentList.length}</strong> agent{agentList.length === 1 ? '' : 's'} shown ({running} running)
        </li>
        <li>
          <strong>{toolCalls.length}</strong> tool call{toolCalls.length === 1 ? '' : 's'} recorded
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
      />

      <AgentDrawer
        agent={selectedAgentId ? (agents[selectedAgentId] ?? null) : null}
        toolCalls={toolCalls}
        logs={logs}
        onClose={() => setSelectedAgentId(null)}
      />
    </div>
  )
}
