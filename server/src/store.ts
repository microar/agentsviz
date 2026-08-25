/**
 * In-memory state store for the event server.
 *
 * Reconstructs current state from the stream of accepted events (see
 * `/docs/event-schema.md`): the agent list + status, active/recent tool
 * calls, and a team -> agents map. Plain in-memory objects/Maps only — no
 * external DB, no persistence to disk. State is lost on process restart,
 * which is expected for this scaffold.
 */

import type { AgentEvent } from "./eventSchema.js";

export type AgentStatus = "running" | "stopped";

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  team?: string;
  caller?: string;
  startedAt?: string;
  stoppedAt?: string;
  stopStatus?: "success" | "error";
  stopMessage?: string;
}

export type ToolCallStatus = "pending" | "success" | "error";

export interface ToolCallState {
  callId: string;
  agentId: string;
  caller?: string;
  team?: string;
  tool: string;
  input?: unknown;
  result?: unknown;
  status: ToolCallStatus;
  message?: string;
  startedAt: string;
  endedAt?: string;
}

export interface StateSnapshot {
  agents: AgentState[];
  toolCalls: ToolCallState[];
  teams: Record<string, string[]>;
}

/**
 * Correlates a tool_call_start with its tool_call_end. The schema doesn't
 * define a shared call id (see "Open questions" in the schema doc), so we
 * derive one from agentId + tool + caller. This means concurrent calls to
 * the same tool by the same agent/caller pair will correlate to the most
 * recent pending call of that key — acceptable for this scaffold, and
 * upgradeable to a real `callId` field without changing the store's shape
 * if/when the schema gains one.
 */
function toolCallKey(agentId: string, tool: string, caller?: string): string {
  return `${agentId}::${caller ?? ""}::${tool}`;
}

export class StateStore {
  private agents = new Map<string, AgentState>();
  // Keyed by a synthetic callId (see ToolCallState.callId), preserving
  // insertion order so snapshots list calls oldest-first.
  private toolCalls = new Map<string, ToolCallState>();
  // Maps the correlation key above to the callId of its current pending
  // (not-yet-ended) call, so a tool_call_end can find the right entry.
  private pendingByKey = new Map<string, string>();
  private nextCallSeq = 0;

  /** Update state from a single accepted event. */
  applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.applyAgentStart(event);
        break;
      case "agent_stop":
        this.applyAgentStop(event);
        break;
      case "tool_call_start":
        this.applyToolCallStart(event);
        break;
      case "tool_call_end":
        this.applyToolCallEnd(event);
        break;
      // "log" and "error" don't change agent/tool-call/team state.
      default:
        break;
    }
  }

  private applyAgentStart(event: Extract<AgentEvent, { type: "agent_start" }>): void {
    const existing = this.agents.get(event.agentId);
    this.agents.set(event.agentId, {
      ...existing,
      agentId: event.agentId,
      status: "running",
      team: event.team ?? existing?.team,
      caller: event.caller ?? existing?.caller,
      startedAt: event.timestamp,
    });
  }

  private applyAgentStop(event: Extract<AgentEvent, { type: "agent_stop" }>): void {
    const existing = this.agents.get(event.agentId);
    // agent_stop marks the agent stopped in place — it is never removed
    // from the store, even if we've never seen an agent_start for it.
    this.agents.set(event.agentId, {
      agentId: event.agentId,
      status: "stopped",
      team: event.team ?? existing?.team,
      caller: existing?.caller,
      startedAt: existing?.startedAt,
      stoppedAt: event.timestamp,
      stopStatus: event.status,
      stopMessage: event.message,
    });
  }

  private applyToolCallStart(event: Extract<AgentEvent, { type: "tool_call_start" }>): void {
    const key = toolCallKey(event.agentId, event.tool, event.caller);
    const callId = `call-${this.nextCallSeq++}`;
    this.toolCalls.set(callId, {
      callId,
      agentId: event.agentId,
      caller: event.caller,
      team: event.team,
      tool: event.tool,
      input: event.input,
      status: "pending",
      startedAt: event.timestamp,
    });
    this.pendingByKey.set(key, callId);
  }

  private applyToolCallEnd(event: Extract<AgentEvent, { type: "tool_call_end" }>): void {
    const key = toolCallKey(event.agentId, event.tool, event.caller);
    const callId = this.pendingByKey.get(key);
    const existing = callId ? this.toolCalls.get(callId) : undefined;

    if (existing) {
      // Update the matching call in place — do not create a duplicate entry.
      existing.status = event.status;
      existing.result = event.result;
      existing.message = event.message;
      existing.endedAt = event.timestamp;
      this.pendingByKey.delete(key);
      return;
    }

    // No matching tool_call_start was observed (e.g. store started after
    // the call began). Record it directly as an already-ended call rather
    // than dropping the event.
    const newCallId = `call-${this.nextCallSeq++}`;
    this.toolCalls.set(newCallId, {
      callId: newCallId,
      agentId: event.agentId,
      caller: event.caller,
      team: event.team,
      tool: event.tool,
      status: event.status,
      result: event.result,
      message: event.message,
      startedAt: event.timestamp,
      endedAt: event.timestamp,
    });
  }

  /** Build the team -> agentIds map from currently known agents. */
  private buildTeams(): Record<string, string[]> {
    const teams: Record<string, string[]> = {};
    for (const agent of this.agents.values()) {
      if (!agent.team) continue;
      if (!teams[agent.team]) teams[agent.team] = [];
      teams[agent.team].push(agent.agentId);
    }
    return teams;
  }

  /** Returns a plain JSON-serializable snapshot of the current state. */
  getSnapshot(): StateSnapshot {
    return {
      agents: Array.from(this.agents.values()),
      toolCalls: Array.from(this.toolCalls.values()),
      teams: this.buildTeams(),
    };
  }
}
