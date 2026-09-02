/**
 * Custom React Flow node components for the Graph tab (issue #87).
 *
 * These replace the canvas `draw-agents.ts` / `draw-tool-nodes.ts` drawing
 * routines with real React. The status → colour language is unchanged
 * (`colors.ts`'s `agentColors`, the same source `verify-legend-colors.mjs`
 * checks): running nodes get the indigo pulsing treatment (CSS
 * `@keyframes graph-node-pulse`, mirroring the old canvas sine pulse),
 * stopped/error nodes are static, and a presumed-stopped (`inferred`, #37)
 * node gets a dashed outline.
 *
 * Each node exposes a left *target* handle and a right *source* handle so
 * dagre's left-to-right seed layout (`autoLayout.ts`) draws parent→child
 * and agent→tool edges cleanly; handles are visually hidden (`.graph-flow`
 * CSS) since the graph is not user-connectable — edges come from store
 * state, not from dragging between handles.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AgentNodeData, ToolNodeData } from './graphModel'
import { agentColors } from './colors'
import { agentLabel, toolLabel } from './labels'

export function AgentNode({ data, selected }: NodeProps) {
  const { agent, statusLabel } = data as AgentNodeData
  const { fill, stroke, dashed } = agentColors(agent)
  const running = agent.status === 'running'

  return (
    <div
      className={`graph-node graph-node--agent${running ? ' graph-node--running' : ''}${
        selected ? ' is-selected' : ''
      }`}
      style={{
        background: fill,
        borderColor: stroke,
        borderStyle: dashed ? 'dashed' : 'solid',
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="graph-node-title">{agentLabel(agent.agentId)}</span>
      <span className="graph-node-sub" style={{ color: stroke }}>
        {statusLabel}
        {agent.inferred ? ' · presumed' : ''}
      </span>
      {agent.team && <span className="graph-node-team">{agent.team}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

export function ToolNode({ data }: NodeProps) {
  const { tool, active } = data as ToolNodeData
  return (
    <div className={`graph-node graph-node--tool${active ? ' graph-node--tool-active' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="graph-node-title">{toolLabel(tool)}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}
