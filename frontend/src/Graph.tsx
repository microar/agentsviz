/**
 * Live agent graph view (issue #7).
 *
 * Renders agents as nodes and tool calls as edges from the shared event
 * store (see store.tsx), updating as new events arrive over the
 * WebSocket connection.
 *
 * Layout: deliberately NOT a physics/force simulation — those tend to
 * jitter and re-settle every time a node is added, which fails the
 * "layout doesn't jump erratically on updates" acceptance criterion.
 * Instead each node gets a permanent slot the first time its id is seen
 * (`useStableSlots` below), placed with a phyllotaxis (sunflower) spiral:
 * slot i sits at `radius = c * sqrt(i)`, `angle = i * goldenAngle`. That
 * formula only depends on a node's own index, never on the total node
 * count, so existing nodes never move when a new one is assigned the
 * next index — it just lands in the next open ring position. Agents and
 * tools get separate spirals (two clusters) so the graph stays legible
 * as an "agents call tools" graph rather than a single messy blob, and
 * both clusters spread out gracefully well past 10+ concurrent agents.
 *
 * No graph library (d3/cytoscape/etc.) is used — the layout needed here
 * is a couple dozen nodes with a stable deterministic position, which a
 * ~20-line formula covers without adding a dependency.
 */

import { useMemo, useRef } from 'react'
import { useEventStore } from './store'
import type { AgentState, ToolCallState } from './types'

const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5)) // ~137.5deg, in radians

interface Point {
  x: number
  y: number
}

function phyllotaxisPoint(index: number, center: Point, spacing: number): Point {
  const angle = index * GOLDEN_ANGLE_RAD
  const radius = spacing * Math.sqrt(index)
  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle),
  }
}

/**
 * Assigns each id a permanent index the first time it's seen (in a ref,
 * so it survives re-renders) and derives a phyllotaxis position from
 * that index. Existing ids keep their slot forever; only brand-new ids
 * get a new (always-next) index, so old nodes never move.
 */
function useStableLayout(ids: string[], center: Point, spacing: number): Map<string, Point> {
  const slotsRef = useRef<Map<string, number>>(new Map())

  return useMemo(() => {
    const slots = slotsRef.current
    for (const id of ids) {
      if (!slots.has(id)) {
        slots.set(id, slots.size)
      }
    }
    const positions = new Map<string, Point>()
    for (const id of ids) {
      positions.set(id, phyllotaxisPoint(slots.get(id)!, center, spacing))
    }
    return positions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|'), center.x, center.y, spacing])
}

function agentStatusClass(agent: AgentState): string {
  if (agent.status === 'running') return 'graph-node--running'
  if (agent.stopStatus === 'error') return 'graph-node--error'
  return 'graph-node--stopped'
}

function agentLabel(agentId: string): string {
  return agentId.length > 14 ? `${agentId.slice(0, 13)}…` : agentId
}

const AGENT_CENTER: Point = { x: 260, y: 300 }
const TOOL_CENTER: Point = { x: 660, y: 300 }
const AGENT_SPACING = 30
const TOOL_SPACING = 46
const AGENT_RADIUS = 20
const TOOL_SIZE = 22

export function GraphTab() {
  const { agents, toolCalls } = useEventStore()

  const agentList = useMemo(() => Object.values(agents), [agents])
  const agentIds = useMemo(() => agentList.map((a) => a.agentId), [agentList])
  const toolNames = useMemo(() => {
    const seen = new Set<string>()
    for (const call of toolCalls) seen.add(call.tool)
    return [...seen]
  }, [toolCalls])

  const agentPositions = useStableLayout(agentIds, AGENT_CENTER, AGENT_SPACING)
  const toolPositions = useStableLayout(toolNames, TOOL_CENTER, TOOL_SPACING)

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
  const bounds = useMemo(() => {
    const xs = [...agentPositions.values(), ...toolPositions.values()].map((p) => p.x)
    const ys = [...agentPositions.values(), ...toolPositions.values()].map((p) => p.y)
    const maxX = Math.max(TOOL_CENTER.x + 120, ...xs.map((x) => x + 80))
    const maxY = Math.max(420, ...ys.map((y) => y + 60), ...ys.map((y) => 660 - y))
    return { width: Math.max(920, maxX), height: Math.max(600, maxY) }
  }, [agentPositions, toolPositions])

  if (agentList.length === 0) {
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
      <ul className="stat-list graph-stats">
        <li>
          <strong>{agentList.length}</strong> agent{agentList.length === 1 ? '' : 's'} seen ({running} running)
        </li>
        <li>
          <strong>{toolCalls.length}</strong> tool call{toolCalls.length === 1 ? '' : 's'} recorded
        </li>
      </ul>

      <div className="graph-legend">
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--running" /> running</span>
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--stopped" /> stopped</span>
        <span className="graph-legend-item"><span className="graph-swatch graph-swatch--error" /> error</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--pending" /> tool call active</span>
        <span className="graph-legend-item"><span className="graph-edge-swatch graph-edge-swatch--settled" /> tool call settled</span>
      </div>

      <div className="graph-canvas-wrap">
        <svg
          className="graph-canvas"
          viewBox={`0 0 ${bounds.width} ${bounds.height}`}
          role="img"
          aria-label="Live agent graph"
        >
          <g className="graph-edges">
            {edges.map(({ key, call, source }) => {
              const from = agentPositions.get(source)
              const to = toolPositions.get(call.tool)
              if (!from || !to) return null
              const pending = call.status === 'pending'
              const settledClass =
                call.status === 'error' ? 'graph-edge--error' : call.status === 'success' ? 'graph-edge--success' : ''
              return (
                <line
                  key={key}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className={`graph-edge ${pending ? 'graph-edge--pending' : `graph-edge--settled ${settledClass}`}`}
                >
                  <title>
                    {source} → {call.tool} ({call.status})
                  </title>
                </line>
              )
            })}
          </g>

          <g className="graph-tool-nodes">
            {toolNames.map((tool) => {
              const pos = toolPositions.get(tool)
              if (!pos) return null
              return (
                <g key={tool} transform={`translate(${pos.x}, ${pos.y})`} className="graph-tool-node">
                  <rect
                    x={-TOOL_SIZE / 2}
                    y={-TOOL_SIZE / 2}
                    width={TOOL_SIZE}
                    height={TOOL_SIZE}
                    rx={4}
                    className="graph-tool-rect"
                  >
                    <title>{tool}</title>
                  </rect>
                  <text className="graph-tool-label" y={TOOL_SIZE / 2 + 12} textAnchor="middle">
                    {tool.length > 12 ? `${tool.slice(0, 11)}…` : tool}
                  </text>
                </g>
              )
            })}
          </g>

          <g className="graph-agent-nodes">
            {agentList.map((agent) => {
              const pos = agentPositions.get(agent.agentId)
              if (!pos) return null
              return (
                <g key={agent.agentId} transform={`translate(${pos.x}, ${pos.y})`} className="graph-agent-node">
                  <circle r={AGENT_RADIUS} className={`graph-node ${agentStatusClass(agent)}`}>
                    <title>
                      {agent.agentId}
                      {agent.team ? ` (${agent.team})` : ''} — {agent.status}
                      {agent.stopStatus ? `/${agent.stopStatus}` : ''}
                    </title>
                  </circle>
                  <text className="graph-node-label" y={AGENT_RADIUS + 14} textAnchor="middle">
                    {agentLabel(agent.agentId)}
                  </text>
                  {agent.team && (
                    <text className="graph-node-team" y={AGENT_RADIUS + 27} textAnchor="middle">
                      {agent.team}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}
