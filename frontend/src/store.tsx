/**
 * Shared client-side event store.
 *
 * Wraps the WebSocket connection (see ws.ts) and exposes a single React
 * Context so the Graph/Logs/Teams tabs can all read the same live state
 * without prop drilling. State is built from:
 *  - the `{ type: "snapshot", data: {...} }` message the server sends
 *    right after connecting, to seed initial state from its current
 *    agents/tool-calls, and
 *  - individual lifecycle events (agent_start/stop, tool_call_start/end,
 *    log, error) applied incrementally as they arrive.
 *
 * Update semantics mirror the server's model of each event type:
 *  - `agent_start` creates/replaces an agent entry marked "running".
 *  - `agent_stop` marks the existing agent "stopped" in place (agents are
 *    never removed from the store).
 *  - `tool_call_start` appends a new "pending" tool call.
 *  - `tool_call_end` updates the matching pending call (same agentId +
 *    tool + caller) in place rather than appending a duplicate.
 *  - `log` / `error` are appended to a capped rolling log list.
 *
 * The snapshot message is handled separately from live events: the server
 * (`server/src/store.ts`) sends already-derived `AgentState[]` /
 * `ToolCallState[]` (one merged entry per agent/call, not raw events), so
 * the snapshot is applied by setting that derived state directly rather
 * than replaying it through the per-event reducer. There is no snapshot
 * equivalent for `logs` — the server doesn't track a log history, so the
 * Logs tab only starts filling in once live `log`/`error` events arrive.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import { connectWebSocket, defaultWsUrl, type ConnectionStatus } from './ws'
import {
  isLifecycleEvent,
  isSnapshotMessage,
  type AgentState,
  type LifecycleEvent,
  type LogEntry,
  type SnapshotToolCall,
  type ToolCallState,
} from './types'

const MAX_LOG_ENTRIES = 500
const MAX_TOOL_CALLS = 500

export interface EventStoreState {
  connectionStatus: ConnectionStatus
  agents: Record<string, AgentState>
  toolCalls: ToolCallState[]
  logs: LogEntry[]
}

const initialState: EventStoreState = {
  connectionStatus: 'connecting',
  agents: {},
  toolCalls: [],
  logs: [],
}

type Action =
  | { kind: 'status'; status: ConnectionStatus }
  | { kind: 'snapshot'; agents: AgentState[]; toolCalls: ToolCallState[] }
  | { kind: 'event'; event: LifecycleEvent }

let logIdCounter = 0
let toolCallIdCounter = 0

/** Maps a server snapshot tool call (`callId`) to the client's `ToolCallState` (`id`). */
function toolCallStateFromSnapshot(call: SnapshotToolCall): ToolCallState {
  return {
    id: call.callId,
    agentId: call.agentId,
    team: call.team,
    caller: call.caller,
    tool: call.tool,
    input: call.input,
    status: call.status,
    result: call.result,
    message: call.message,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
  }
}

function agentFromStartEvent(event: LifecycleEvent): AgentState {
  return {
    agentId: event.agentId,
    team: event.team,
    caller: event.caller,
    status: 'running',
    startedAt: event.timestamp,
  }
}

function applyAgentStart(agents: Record<string, AgentState>, event: LifecycleEvent): Record<string, AgentState> {
  return { ...agents, [event.agentId]: agentFromStartEvent(event) }
}

function applyAgentStop(agents: Record<string, AgentState>, event: LifecycleEvent): Record<string, AgentState> {
  const existing = agents[event.agentId]
  const next: AgentState = existing
    ? { ...existing, team: event.team ?? existing.team }
    : { agentId: event.agentId, team: event.team, status: 'running' }
  return {
    ...agents,
    [event.agentId]: {
      ...next,
      status: 'stopped',
      stoppedAt: event.timestamp,
      stopStatus: event.status,
      stopMessage: event.message,
      // An explicit agent_stop is a clean stop even if the agent had
      // previously been presumed stopped by the server's liveness sweep
      // (e.g. a late agent_stop arriving after the timeout already
      // fired) — the explicit signal wins over the inferred one.
      inferred: undefined,
    },
  }
}

function applyToolCallStart(toolCalls: ToolCallState[], event: LifecycleEvent): ToolCallState[] {
  const entry: ToolCallState = {
    id: `tc-${toolCallIdCounter++}-${event.timestamp}`,
    agentId: event.agentId,
    team: event.team,
    caller: event.caller,
    tool: event.tool ?? 'unknown',
    input: event.input,
    status: 'pending',
    startedAt: event.timestamp,
  }
  const next = [...toolCalls, entry]
  return next.length > MAX_TOOL_CALLS ? next.slice(next.length - MAX_TOOL_CALLS) : next
}

function applyToolCallEnd(toolCalls: ToolCallState[], event: LifecycleEvent): ToolCallState[] {
  // Find the most recent matching pending call for this agent/tool/caller.
  const index = [...toolCalls]
    .reverse()
    .findIndex(
      (call) =>
        call.status === 'pending' &&
        call.agentId === event.agentId &&
        call.tool === event.tool &&
        call.caller === event.caller,
    )

  if (index === -1) {
    // No matching start was seen (e.g. connected mid-call) — record it standalone.
    const entry: ToolCallState = {
      id: `tc-${toolCallIdCounter++}-${event.timestamp}`,
      agentId: event.agentId,
      team: event.team,
      caller: event.caller,
      tool: event.tool ?? 'unknown',
      status: event.status === 'error' ? 'error' : 'success',
      result: event.result,
      message: event.message,
      startedAt: event.timestamp,
      endedAt: event.timestamp,
    }
    const next = [...toolCalls, entry]
    return next.length > MAX_TOOL_CALLS ? next.slice(next.length - MAX_TOOL_CALLS) : next
  }

  const realIndex = toolCalls.length - 1 - index
  const updated: ToolCallState = {
    ...toolCalls[realIndex],
    status: event.status === 'error' ? 'error' : 'success',
    result: event.result,
    message: event.message,
    endedAt: event.timestamp,
  }
  const next = [...toolCalls]
  next[realIndex] = updated
  return next
}

function applyLogOrError(logs: LogEntry[], event: LifecycleEvent): LogEntry[] {
  const entry: LogEntry = {
    id: `log-${logIdCounter++}-${event.timestamp}`,
    kind: event.type === 'error' ? 'error' : 'log',
    agentId: event.agentId,
    team: event.team,
    message: event.message ?? '',
    timestamp: event.timestamp,
  }
  const next = [...logs, entry]
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next
}

function applyEvent(state: EventStoreState, event: LifecycleEvent): EventStoreState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, agents: applyAgentStart(state.agents, event) }
    case 'agent_stop':
      return { ...state, agents: applyAgentStop(state.agents, event) }
    case 'tool_call_start':
      return { ...state, toolCalls: applyToolCallStart(state.toolCalls, event) }
    case 'tool_call_end':
      return { ...state, toolCalls: applyToolCallEnd(state.toolCalls, event) }
    case 'log':
    case 'error':
      return { ...state, logs: applyLogOrError(state.logs, event) }
    default:
      return state
  }
}

function reducer(state: EventStoreState, action: Action): EventStoreState {
  switch (action.kind) {
    case 'status':
      return { ...state, connectionStatus: action.status }
    case 'snapshot': {
      // The server sends already-derived state (not raw lifecycle events),
      // so set it directly rather than replaying it through applyEvent.
      const agents: Record<string, AgentState> = {}
      for (const agent of action.agents) agents[agent.agentId] = agent
      const toolCalls =
        action.toolCalls.length > MAX_TOOL_CALLS
          ? action.toolCalls.slice(action.toolCalls.length - MAX_TOOL_CALLS)
          : action.toolCalls
      return { ...state, agents, toolCalls }
    }
    case 'event':
      return applyEvent(state, action.event)
    default:
      return state
  }
}

interface EventStoreContextValue extends EventStoreState {}

const EventStoreContext = createContext<EventStoreContextValue | null>(null)

export interface EventStoreProviderProps {
  children: ReactNode
  /** Override the WebSocket URL (defaults to VITE_WS_URL, else same-host port 4000). */
  wsUrl?: string
}

export function EventStoreProvider({ children, wsUrl }: EventStoreProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState)

  useEffect(() => {
    const url = wsUrl ?? defaultWsUrl()
    const client = connectWebSocket(url, {
      onStatusChange: (status) => dispatch({ kind: 'status', status }),
      onMessage: (data) => {
        if (isSnapshotMessage(data)) {
          dispatch({
            kind: 'snapshot',
            agents: data.data.agents,
            toolCalls: data.data.toolCalls.map(toolCallStateFromSnapshot),
          })
          return
        }
        if (isLifecycleEvent(data)) {
          dispatch({ kind: 'event', event: data })
        }
      },
    })

    return () => client.disconnect()
  }, [wsUrl])

  return <EventStoreContext.Provider value={state}>{children}</EventStoreContext.Provider>
}

/** Read the shared event store from any component beneath EventStoreProvider. */
export function useEventStore(): EventStoreState {
  const ctx = useContext(EventStoreContext)
  if (!ctx) {
    throw new Error('useEventStore must be used within an EventStoreProvider')
  }
  return ctx
}

/** Convenience selector: teams derived from current agent state, agentId list per team. */
export function useTeams(): Record<string, string[]> {
  const { agents } = useEventStore()
  return useMemo(() => {
    const teams: Record<string, string[]> = {}
    for (const agent of Object.values(agents)) {
      const key = agent.team ?? 'unassigned'
      if (!teams[key]) teams[key] = []
      teams[key].push(agent.agentId)
    }
    return teams
  }, [agents])
}
