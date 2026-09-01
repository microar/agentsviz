/**
 * Agent detail drawer (issue #12).
 *
 * Slide-in side panel shown when a node is clicked in the Graph tab. Reads
 * from the same shared event store (see store.tsx) as the graph itself, so
 * opening/closing it is purely a local UI concern (which agentId, if any,
 * is "selected") — it never touches graph layout state or the WebSocket
 * connection, so the live graph is unaffected while the drawer is open or
 * closed.
 *
 * Issue #83 split the detail rendering (meta + tool-call list + logs) out
 * into `AgentDetailBody` so the new anchored per-agent action panel on the
 * *live* Graph tab (`graph/GraphAgentPanel.tsx`) can reuse it verbatim.
 * `AgentDrawer` itself — the slide-in side drawer — is now only used by the
 * Graph tab's *history* mode (see Graph.tsx).
 */

import { useEffect, useMemo } from 'react'
import type { AgentState, LogEntry, ToolCallState } from './types'

function durationMs(startedAt?: string, endedAt?: string): number | null {
  if (!startedAt || !endedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return end - start
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function toolCallStatusLabel(call: ToolCallState): string {
  return call.status
}

export interface AgentDrawerProps {
  agent: AgentState | null
  toolCalls: ToolCallState[]
  logs: LogEntry[]
  onClose: () => void
}

export function AgentDrawer({ agent, toolCalls, logs, onClose }: AgentDrawerProps) {
  // Escape closes the drawer. Registered whenever an agent is selected;
  // cleaned up on unmount/close so it never lingers after closing.
  useEffect(() => {
    if (!agent) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [agent, onClose])

  if (!agent) return null

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className="agent-drawer"
        role="dialog"
        aria-label={`Agent details for ${agent.agentId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-drawer-header">
          <div>
            <h3 className="agent-drawer-title">{agent.agentId}</h3>
            {agent.team && <p className="agent-drawer-team">{agent.team}</p>}
          </div>
          <button type="button" className="agent-drawer-close" onClick={onClose} aria-label="Close drawer">
            ×
          </button>
        </div>

        <AgentDetailBody agent={agent} toolCalls={toolCalls} logs={logs} />
      </aside>
    </div>
  )
}

export interface AgentDetailBodyProps {
  agent: AgentState
  toolCalls: ToolCallState[]
  logs: LogEntry[]
}

/**
 * The scrollable detail content for one agent — status/timing meta, its
 * tool-call list, and its log entries. Extracted from `AgentDrawer` in
 * issue #83 so both the history-mode side drawer and the live-mode anchored
 * action panel (`graph/GraphAgentPanel.tsx`) render agent activity
 * identically. Assumes a non-null `agent` — callers guard for that.
 */
export function AgentDetailBody({ agent, toolCalls, logs }: AgentDetailBodyProps) {
  const agentToolCalls = useMemo(
    () => toolCalls.filter((call) => call.agentId === agent.agentId || call.caller === agent.agentId),
    [agent, toolCalls],
  )

  const agentLogs = useMemo(() => logs.filter((entry) => entry.agentId === agent.agentId), [agent, logs])

  const overallDuration = durationMs(agent.startedAt, agent.stoppedAt)

  return (
    <>
      <dl className="agent-drawer-meta">
          <div>
            <dt>Status</dt>
            <dd>
              {agent.status}
              {agent.stopStatus ? ` / ${agent.stopStatus}` : ''}
              {agent.inferred && <span className="agent-drawer-inferred-badge">presumed</span>}
            </dd>
          </div>
          {agent.caller && (
            <div>
              <dt>Caller</dt>
              <dd>{agent.caller}</dd>
            </div>
          )}
          <div>
            <dt>Started</dt>
            <dd>{agent.startedAt ?? '—'}</dd>
          </div>
          <div>
            <dt>Stopped</dt>
            <dd>{agent.stoppedAt ?? '—'}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(overallDuration)}</dd>
          </div>
          {agent.stopMessage && (
            <div>
              <dt>Stop message</dt>
              <dd>{agent.stopMessage}</dd>
            </div>
          )}
        </dl>

        <section className="agent-drawer-section">
          <h4>Tool calls ({agentToolCalls.length})</h4>
          {agentToolCalls.length === 0 ? (
            <p className="empty-state">No tool calls recorded for this agent.</p>
          ) : (
            <ul className="agent-drawer-tool-list">
              {agentToolCalls.map((call) => (
                <li key={call.id} className={`agent-drawer-tool agent-drawer-tool--${call.status}`}>
                  <div className="agent-drawer-tool-row">
                    <span className="agent-drawer-tool-name">{call.tool}</span>
                    <span className="agent-drawer-tool-status">{toolCallStatusLabel(call)}</span>
                  </div>
                  <div className="agent-drawer-tool-timing">
                    {call.startedAt}
                    {call.endedAt ? ` → ${call.endedAt}` : ' (in progress)'}
                    {' · '}
                    {formatDuration(durationMs(call.startedAt, call.endedAt))}
                  </div>
                  {call.message && <div className="agent-drawer-tool-message">{call.message}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="agent-drawer-section">
          <h4>Logs ({agentLogs.length})</h4>
          {agentLogs.length === 0 ? (
            <p className="empty-state">No log events for this agent yet.</p>
          ) : (
            <ul className="agent-drawer-log-list">
              {agentLogs.map((entry) => (
                <li key={entry.id} className={`log-entry log-entry--${entry.kind}`}>
                  <span className="log-entry-time">{entry.timestamp}</span>
                  {entry.kind === 'error' && <span className="log-entry-badge">ERROR</span>}
                  <span className="log-entry-message">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
    </>
  )
}
