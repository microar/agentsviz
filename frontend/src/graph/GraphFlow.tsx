/**
 * React Flow renderer for the Graph tab (issue #87).
 *
 * Replaces the hand-rolled Canvas 2D pipeline (`GraphCanvas.tsx` +
 * `draw-*.ts` + `layout.ts` + `useCanvasCamera.ts` + `hit-detection.ts` +
 * `render-cache.ts`, all removed in #87) with `@xyflow/react`. What that
 * buys us and the canvas didn't have: every agent node is **draggable**,
 * and its edges (agent→tool tool calls, parent→child sub-agent links) stay
 * attached and re-route as it moves.
 *
 * Position ownership (issue #87 acceptance criteria):
 *  - React Flow owns positions once a node exists; the user drags freely.
 *  - `autoLayout.ts` (dagre) supplies the *seed* position only for an id
 *    this component hasn't placed yet. Every already-placed node — dragged
 *    or not — keeps its exact position when an agent is added or removed,
 *    so the graph never re-arranges under the user (#7 / #12 criteria).
 *  - Positions are component-local state, never synced over the WebSocket —
 *    same policy as `scrubAtMs` and the old canvas camera.
 *
 * What stayed the same: this is still just the *renderer*. `Graph.tsx`
 * still decides which agents/tool calls/edges to pass in (live = running
 * only per #83, history = the reconstructed snapshot per #43), still owns
 * selection state, the status-legend filter, and the `Timeline` scrubber +
 * `usePlayback` transport. Node click still calls `onSelectAgent`; in live
 * mode the selected agent's action panel is anchored on its node via
 * React Flow's `<NodeToolbar>` (replacing the canvas render loop's
 * per-frame `transform` write), and history mode still uses the slide-in
 * `AgentDrawer` rendered by `Graph.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeTypes,
  type OnNodesChange,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AgentState } from '../types'
import { agentStatusLabel } from '../agentStatus'
import { buildEdges, computeSubAgentPairs, toolNodeId, type ToolEdgeInput } from './graphModel'
import { fallbackPosition, seedLayout } from './autoLayout'
import { AgentNode, ToolNode } from './GraphNodes'

/** Stable identity — declaring this inline would remount every node each render. */
const graphNodeTypes: NodeTypes = { agent: AgentNode, tool: ToolNode }

export interface GraphFlowProps {
  /** Agents to draw — already scoped by `Graph.tsx` (running-only when live). */
  allAgents: AgentState[]
  /** Distinct tool names to draw as tool nodes. `[]` in live mode (#83). */
  toolNames: string[]
  /** One (caller agent, tool) tool-call edge per pair. `[]` in live mode (#83). */
  edges: ToolEdgeInput[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  /** Every agentId ever seen this session — for sub-agent (`caller`) recognition (#49/#71). */
  knownAgentIds: ReadonlySet<string>
  /** True when rendering a reconstructed historical snapshot (#43). */
  historyMode?: boolean
  /**
   * Live mode only (#83): the per-agent action panel, anchored on the
   * selected node via `<NodeToolbar>`. `undefined` → nothing anchored
   * (history mode uses the slide-in `AgentDrawer` from `Graph.tsx`).
   */
  anchoredPanel?: ReactNode
}

function GraphFlowInner({
  allAgents,
  toolNames,
  edges,
  selectedAgentId,
  onSelectAgent,
  knownAgentIds,
  historyMode = false,
  anchoredPanel,
}: GraphFlowProps) {
  const [nodes, setNodes] = useNodesState<Node>([])
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([])

  // Sticky position cache: an id is placed exactly once (seeded by dagre),
  // then only ever moved by the user dragging it. Kept in sync with the
  // node state on every position change below, and read when rebuilding the
  // node list after a store update so existing nodes never jump (#87). A
  // ref, not state — mutating it must never trigger a re-render.
  const positionsRef = useRef<Map<string, XYPosition>>(new Map())

  const onNodesChange = useCallback<OnNodesChange<Node>>(
    (changes) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current)
        for (const node of next) positionsRef.current.set(node.id, node.position)
        return next
      })
    },
    [setNodes],
  )

  // Position-independent derivation from the current store slice.
  const model = useMemo(() => {
    const subAgentPairs = computeSubAgentPairs(allAgents, knownAgentIds)
    const toolIds = toolNames.map(toolNodeId)
    const presentIds = new Set<string>([...allAgents.map((a) => a.agentId), ...toolIds])
    return {
      subAgentPairs,
      toolIds,
      builtEdges: buildEdges(edges, subAgentPairs, presentIds),
    }
  }, [allAgents, toolNames, edges, knownAgentIds])

  // Rebuild nodes/edges whenever the store slice or selection changes.
  // Positions come from the sticky cache; any id not seen before is seeded
  // in one dagre pass over the whole current graph (existing ids keep their
  // cached position — this only *adds*, never re-lays-out).
  useEffect(() => {
    const positions = positionsRef.current
    const missing = [
      ...allAgents.map((a) => a.agentId),
      ...model.toolIds,
    ].filter((id) => !positions.has(id))

    if (missing.length > 0) {
      const seeded = seedLayout({
        agents: allAgents,
        toolNodeIds: model.toolIds,
        toolEdges: edges,
        subAgentPairs: model.subAgentPairs,
      })
      let fallbackOrdinal = positions.size
      for (const id of missing) {
        positions.set(id, seeded.get(id) ?? fallbackPosition(fallbackOrdinal++))
      }
    }

    // Merge onto the previous node list rather than replacing it, so React
    // Flow-managed per-node fields (`measured` dimensions, in-flight
    // `dragging`) survive a store update and don't trigger a re-measure
    // loop. Position always comes from the sticky cache (kept current by
    // `onNodesChange`), so a drag in progress is preserved too.
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const agentNodes: Node[] = allAgents.map((agent) => {
        const previous = prevById.get(agent.agentId)
        return {
          ...previous,
          id: agent.agentId,
          type: 'agent',
          position: positions.get(agent.agentId)!,
          data: { agent, statusLabel: agentStatusLabel(agent) },
          selected: agent.agentId === selectedAgentId,
        }
      })
      const toolNodes: Node[] = toolNames.map((tool) => {
        const id = toolNodeId(tool)
        const previous = prevById.get(id)
        return {
          ...previous,
          id,
          type: 'tool',
          position: positions.get(id)!,
          data: {
            tool,
            active: edges.some((e) => e.call.tool === tool && e.call.status === 'pending'),
          },
          selectable: false,
          draggable: true,
        }
      })
      return [...agentNodes, ...toolNodes]
    })
    setRfEdges(model.builtEdges)
  }, [allAgents, toolNames, edges, model, selectedAgentId, setNodes, setRfEdges])

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === 'agent') onSelectAgent(node.id)
    },
    [onSelectAgent],
  )

  return (
    <div
      className={`graph-canvas-wrap graph-flow${historyMode ? ' graph-canvas-wrap--history' : ''}`}
    >
      <ReactFlow
        style={{ width: '100%', height: '100%' }}
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={graphNodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        nodesConnectable={false}
        fitView
        minZoom={0.2}
        maxZoom={2.5}
        colorMode="system"
        proOptions={{ hideAttribution: false }}
        aria-label={historyMode ? 'Historical agent graph (viewing past state)' : 'Live agent graph'}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        {anchoredPanel && selectedAgentId && (
          <NodeToolbar nodeId={selectedAgentId} isVisible position={Position.Top} offset={16}>
            {anchoredPanel}
          </NodeToolbar>
        )}
      </ReactFlow>

      {/* Keyboard / screen-reader fallback: React Flow nodes are focusable,
          but this flat list keeps "jump straight to an agent's actions"
          reachable without tabbing the canvas, same as the old canvas
          renderer's visually-hidden button list. */}
      <div className="sr-only" aria-label="Agents (keyboard-accessible list)">
        {allAgents.map((agent) => (
          <button key={agent.agentId} type="button" onClick={() => onSelectAgent(agent.agentId)}>
            {agent.agentId}
            {agent.team ? ` (${agent.team})` : ''} — {agent.status}
            {agent.stopStatus ? `/${agent.stopStatus}` : ''}
            {agent.inferred ? ' (presumed)' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

export function GraphFlow(props: GraphFlowProps) {
  return (
    <ReactFlowProvider>
      <GraphFlowInner {...props} />
    </ReactFlowProvider>
  )
}
