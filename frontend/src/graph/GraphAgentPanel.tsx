/**
 * Anchored per-agent action panel for the *live* Graph tab (issue #83).
 *
 * The live Graph canvas no longer draws per-agent activity (tool calls, MCP
 * calls, logs, errors) as persistent nodes/edges — instead, clicking a
 * running agent reveals that activity on demand in this panel, which
 * `GraphCanvas` positions on top of the clicked node in screen space (its
 * render loop writes a `transform: translate(...)` every frame using the
 * same camera projection the canvas hit-detection uses, so the panel tracks
 * the node as the camera pans/zooms). An `X` (or Escape) closes it;
 * clicking another agent retargets it.
 *
 * The body is `AgentDetailBody` from `AgentDrawer.tsx`, shared verbatim with
 * the history-mode side drawer so the two render agent activity identically.
 */

import { useEffect } from 'react'
import { AgentDetailBody } from '../AgentDrawer'
import type { AgentState, LogEntry, ToolCallState } from '../types'

export interface GraphAgentPanelProps {
  agent: AgentState
  toolCalls: ToolCallState[]
  logs: LogEntry[]
  onClose: () => void
}

export function GraphAgentPanel({ agent, toolCalls, logs, onClose }: GraphAgentPanelProps) {
  // Escape closes the panel, matching the side drawer it replaces here.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="graph-agent-panel" role="dialog" aria-label={`Actions for ${agent.agentId}`}>
      <div className="graph-agent-panel-header">
        <div>
          <h3 className="graph-agent-panel-title">{agent.agentId}</h3>
          {agent.team && <p className="graph-agent-panel-team">{agent.team}</p>}
        </div>
        <button type="button" className="agent-drawer-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>

      <AgentDetailBody agent={agent} toolCalls={toolCalls} logs={logs} />
    </div>
  )
}
