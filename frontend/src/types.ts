/**
 * Event/domain types shared by the WebSocket client and the store.
 *
 * Mirrors the envelope defined in /docs/event-schema.md. Every event uses
 * the same top-level field set; fields that don't apply to a given event
 * type are simply absent.
 */

export const EVENT_TYPES = [
  'agent_start',
  'agent_stop',
  'tool_call_start',
  'tool_call_end',
  'log',
  'error',
] as const

export type LifecycleEventType = (typeof EVENT_TYPES)[number]

export type EventStatus = 'success' | 'error'

/** Raw event exactly as broadcast by the event server (see docs/event-schema.md). */
export interface LifecycleEvent {
  type: LifecycleEventType
  timestamp: string
  agentId: string
  team?: string
  caller?: string
  tool?: string
  input?: Record<string, unknown>
  result?: unknown
  status?: EventStatus
  message?: string
}

/**
 * Snapshot message the server may send a client right after it connects,
 * to populate initial state before live events start arriving. The event
 * server doesn't broadcast this yet (state-store issue is separate/#3),
 * so the store also works fine if a snapshot never shows up — it just
 * starts from an empty state and builds up from live events only.
 */
export interface SnapshotMessage {
  type: 'snapshot'
  data: {
    agents?: LifecycleEvent[]
    toolCalls?: LifecycleEvent[]
    logs?: LifecycleEvent[]
    /** Some server implementations may send this instead of raw events. */
    teams?: Record<string, string[]>
  }
}

export type ServerMessage = SnapshotMessage | LifecycleEvent

export function isSnapshotMessage(msg: unknown): msg is SnapshotMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'snapshot'
  )
}

export function isLifecycleEvent(msg: unknown): msg is LifecycleEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    EVENT_TYPES.includes((msg as { type?: unknown }).type as LifecycleEventType)
  )
}

/** Derived, store-friendly view of an agent's current state. */
export interface AgentState {
  agentId: string
  team?: string
  caller?: string
  status: 'running' | 'stopped'
  startedAt?: string
  stoppedAt?: string
  stopStatus?: EventStatus
  stopMessage?: string
}

/** Derived, store-friendly view of a tool call (start merged with its end, if any). */
export interface ToolCallState {
  id: string
  agentId: string
  team?: string
  caller?: string
  tool: string
  input?: Record<string, unknown>
  status: 'pending' | 'success' | 'error'
  result?: unknown
  message?: string
  startedAt: string
  endedAt?: string
}

/** A log or error line, kept around for the Logs tab. */
export interface LogEntry {
  id: string
  kind: 'log' | 'error'
  agentId: string
  team?: string
  message: string
  timestamp: string
}
