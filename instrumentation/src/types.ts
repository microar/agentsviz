/**
 * Types mirroring the event envelope defined in /docs/event-schema.md.
 * Keep this file in lockstep with that document — it is the source of
 * truth for field names, types, and per-event-type requirements.
 */

export type EventType =
  | "agent_start"
  | "agent_stop"
  | "tool_call_start"
  | "tool_call_end"
  | "log"
  | "error";

export type Status = "success" | "error";

/** Fields shared by every event type. */
interface BaseEvent {
  type: EventType;
  /** ISO 8601 UTC timestamp, millisecond precision. */
  timestamp: string;
  agentId: string;
  team?: string;
}

export interface AgentStartEvent extends BaseEvent {
  type: "agent_start";
  caller?: string;
}

export interface AgentStopEvent extends BaseEvent {
  type: "agent_stop";
  status: Status;
  message?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  type: "tool_call_start";
  caller: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: "tool_call_end";
  caller: string;
  tool: string;
  status: Status;
  /** Present on success; omitted on error (use `message` instead). */
  result?: unknown;
  /** Present on error. */
  message?: string;
}

export interface LogEvent extends BaseEvent {
  type: "log";
  message: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  status: "error";
  message: string;
  caller?: string;
}

export type AgentEvent =
  | AgentStartEvent
  | AgentStopEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | LogEvent
  | ErrorEvent;
