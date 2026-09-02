/**
 * Store state → React Flow nodes/edges mapping for the Graph tab (issue #87).
 *
 * Issue #87 replaced the hand-rolled Canvas 2D pipeline (`GraphCanvas.tsx`,
 * `draw-*.ts`, `layout.ts`, `hit-detection.ts`, …) with `@xyflow/react`.
 * This module is the pure data layer of that migration: given the same
 * derived store objects the canvas renderer consumed (`AgentState[]`,
 * per-(agent,tool) tool-call edges, the set of every agentId ever seen),
 * it produces the `Node[]` / `Edge[]` arrays `GraphFlow.tsx` feeds to
 * `<ReactFlow>`. Node *positions* are owned by `GraphFlow` (seeded once via
 * `autoLayout.ts`, then whatever the user drags them to) and merged in
 * there — everything here is position-independent.
 *
 * Status → colour language is reused verbatim from `colors.ts` (the same
 * source of truth the canvas used and `verify-legend-colors.mjs` still
 * checks against the CSS legend), never re-derived.
 *
 * `isSubAgent` moved here from the deleted `fade.ts` — it is the one piece
 * of that module still needed (deciding whether an agent's `caller` names
 * another known agent, i.e. whether to draw a parent→child edge, issue #71).
 */

import { MarkerType, type Edge as RFEdge } from '@xyflow/react'
import type { AgentState, ToolCallState } from '../types'
import { COLORS, agentColors } from './colors'
import { agentStatusLabel, type StatusFilter } from '../agentStatus'

/** A single (caller agent, tool) tool-call edge, as computed by `Graph.tsx`. */
export interface ToolEdgeInput {
  key: string
  call: ToolCallState
  source: string
}

/** Parent → spawned sub-agent pair (issue #71). */
export interface SubAgentPair {
  parent: string
  child: string
}

export type AgentNodeData = {
  agent: AgentState
  /** Collapsed status bucket, so the node component doesn't re-derive it. */
  statusLabel: StatusFilter
}

export type ToolNodeData = {
  tool: string
  /** True while at least one call on this tool is still pending. */
  active: boolean
}

/** React Flow node id for a tool node — namespaced so it can't collide with an agentId. */
export function toolNodeId(tool: string): string {
  return `tool:${tool}`
}

/**
 * True iff `agent` is a sub-agent of another agent seen in this session —
 * i.e. its `caller` names an agentId in `knownAgentIds` — rather than a
 * top-level agent (no `caller`, or a `caller` that isn't itself a known
 * agent, e.g. the instrumentation library's default `caller: "user"`).
 * `knownAgentIds` should be every agentId ever observed this session (the
 * store never drops an agent entry once seen), not just the visible ones,
 * so a sub-agent stays recognised even after its caller leaves the view.
 * Relocated from the removed `fade.ts` (issue #87).
 */
export function isSubAgent(agent: AgentState, knownAgentIds: ReadonlySet<string>): boolean {
  return agent.caller !== undefined && knownAgentIds.has(agent.caller)
}

/**
 * Parent → sub-agent pairs for every agent in `agents` whose `caller` names
 * another known agent. One entry per (parent, child); none when `caller` is
 * absent or names a non-agent.
 */
export function computeSubAgentPairs(
  agents: readonly AgentState[],
  knownAgentIds: ReadonlySet<string>,
): SubAgentPair[] {
  const pairs: SubAgentPair[] = []
  for (const agent of agents) {
    if (isSubAgent(agent, knownAgentIds)) pairs.push({ parent: agent.caller!, child: agent.agentId })
  }
  return pairs
}

/** Stroke colour for a settled/pending tool-call edge — mirrors the canvas `drawEdge`. */
export function toolEdgeColor(status: ToolCallState['status']): string {
  if (status === 'pending') return COLORS.edgePending
  if (status === 'error') return COLORS.edgeError
  if (status === 'success') return COLORS.edgeSuccess
  return COLORS.edgeSettled
}

/**
 * Builds the React Flow edge list: agent→tool tool-call edges plus
 * parent→child sub-agent edges. `presentNodeIds` is every node id currently
 * in the graph, so an edge whose endpoint isn't drawn (e.g. missing from a
 * historical snapshot) is dropped rather than left dangling.
 */
export function buildEdges(
  toolEdges: readonly ToolEdgeInput[],
  subAgentPairs: readonly SubAgentPair[],
  presentNodeIds: ReadonlySet<string>,
): RFEdge[] {
  const edges: RFEdge[] = []

  for (const { key, call, source } of toolEdges) {
    const target = toolNodeId(call.tool)
    if (!presentNodeIds.has(source) || !presentNodeIds.has(target)) continue
    const pending = call.status === 'pending'
    const color = toolEdgeColor(call.status)
    edges.push({
      id: `tool:${key}`,
      source,
      target,
      animated: pending,
      style: { stroke: color, strokeWidth: pending ? 2.5 : 1.5 },
    })
  }

  for (const { parent, child } of subAgentPairs) {
    if (!presentNodeIds.has(parent) || !presentNodeIds.has(child)) continue
    edges.push({
      id: `sub:${parent}->${child}`,
      source: parent,
      target: child,
      style: { stroke: COLORS.subAgentLink, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: COLORS.subAgentLink, width: 16, height: 16 },
    })
  }

  return edges
}

/** Inline style for an agent node's card, keyed off its status bucket. */
export function agentNodeStyle(agent: AgentState): { fill: string; stroke: string; dashed: boolean } {
  return agentColors(agent)
}

export { agentStatusLabel }
