/**
 * Initial auto-layout seed for the React Flow Graph tab (issue #87).
 *
 * React Flow owns node positions once they exist — the user drags nodes
 * wherever they like and connected edges re-route to follow. This module
 * only supplies the *initial* coordinate for an id `GraphFlow.tsx` has not
 * placed yet: on first render the whole graph is seeded at once; afterwards
 * a newly-appeared agent/tool is seeded relative to the current graph while
 * every already-placed node stays exactly where it is (issue #87
 * acceptance criterion: "adding/removing an agent does not move existing
 * user-placed nodes").
 *
 * The layout engine is dagre (`@dagrejs/dagre`) — a deterministic layered
 * DAG layout, left-to-right, agents ranked by their caller chain so a
 * parent sits left of the sub-agents it spawned and tool nodes fall to the
 * right of the agents that call them. Deterministic on purpose: a
 * force/physics simulation was rejected in #7/#40 for jittering and
 * re-settling every time a node is added. Swapping dagre for elkjs (or any
 * other layout) is a change confined to this function.
 */

import dagre from '@dagrejs/dagre'
import type { XYPosition } from '@xyflow/react'
import type { AgentState } from '../types'
import { toolNodeId, type SubAgentPair, type ToolEdgeInput } from './graphModel'

/** Node box size handed to dagre — roughly matches the rendered card / chip. */
const AGENT_W = 168
const AGENT_H = 64
const TOOL_W = 132
const TOOL_H = 44

export interface SeedLayoutInput {
  agents: readonly AgentState[]
  toolNodeIds: readonly string[]
  toolEdges: readonly ToolEdgeInput[]
  subAgentPairs: readonly SubAgentPair[]
}

/**
 * Runs dagre over the whole current graph and returns a position for every
 * node id (agent ids and `tool:*` ids). Callers keep positions for ids they
 * have already placed and take from here only the ids they haven't — so the
 * result is a *seed*, never a re-layout of nodes the user has touched.
 */
export function seedLayout({
  agents,
  toolNodeIds,
  toolEdges,
  subAgentPairs,
}: SeedLayoutInput): Map<string, XYPosition> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 96, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const agent of agents) {
    g.setNode(agent.agentId, { width: AGENT_W, height: AGENT_H })
  }
  for (const id of toolNodeIds) {
    g.setNode(id, { width: TOOL_W, height: TOOL_H })
  }

  const present = new Set<string>([...agents.map((a) => a.agentId), ...toolNodeIds])
  for (const { parent, child } of subAgentPairs) {
    if (present.has(parent) && present.has(child)) g.setEdge(parent, child)
  }
  for (const { call, source } of toolEdges) {
    const target = toolNodeId(call.tool)
    if (present.has(source) && present.has(target)) g.setEdge(source, target)
  }

  dagre.layout(g)

  const positions = new Map<string, XYPosition>()
  for (const id of g.nodes()) {
    const node = g.node(id)
    if (!node) continue
    // dagre reports node centres; React Flow positions are top-left.
    positions.set(id, { x: node.x - node.width / 2, y: node.y - node.height / 2 })
  }
  return positions
}

/**
 * Fallback seed for an id dagre didn't place (isolated node, or a race
 * where the graph was empty). Drops it in a slack column keyed off how many
 * nodes already exist, so two unplaced ids in the same pass don't stack.
 */
export function fallbackPosition(ordinal: number): XYPosition {
  return { x: -220, y: 24 + ordinal * (AGENT_H + 24) }
}
