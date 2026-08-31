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
  /**
   * True when this agent was marked "stopped" by the server's liveness
   * timeout (see `reapStaleAgents` below) rather than by an explicit
   * `agent_stop` event. Absent (not `false`) on a clean stop, so
   * consumers can distinguish "we don't know" (undefined, still running)
   * from "cleanly stopped" (status stopped, inferred absent) from
   * "presumed stopped" (status stopped, inferred true) with a single
   * truthy check.
   */
  inferred?: true;
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

/**
 * A `caller` worth recording on an *agent* record: a non-empty id that
 * names some *other* agent. `tool_call_*` (and `agent_stop`, post-#69)
 * events on a top-level agent carry `caller === agentId` as a
 * self-reference; storing that on the agent record would make the agent
 * look like its own sub-agent to consumers that treat "has a caller" as
 * "is a sub-agent" (e.g. the frontend Graph's grace-window exemption).
 * Returns `undefined` for the self-reference / empty cases so callers can
 * `?? existing?.caller`.
 */
function meaningfulCaller(agentId: string, caller: string | undefined): string | undefined {
  return caller && caller !== agentId ? caller : undefined;
}

/** Renders a millisecond duration for the reaped-agent stopMessage below. */
function formatDuration(ms: number): string {
  if (ms < 60000) {
    const seconds = Math.round(ms / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / 60000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
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
  // Wall-clock (epoch ms) of the most recent event bearing each agentId,
  // regardless of event type — this is the liveness clock `reapStaleAgents`
  // checks. Every event type touches it, per docs/event-schema.md's shared
  // envelope, since a "log"/"error"/tool-call event is just as good
  // evidence of life as agent_start/agent_stop.
  private lastActivityAt = new Map<string, number>();

  /** Update state from a single accepted event. */
  applyEvent(event: AgentEvent): void {
    this.touchActivity(event);
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
      // A fresh agent_start supersedes any earlier presumed-stopped state
      // (e.g. the same agentId reused for a new run).
      stoppedAt: undefined,
      stopStatus: undefined,
      stopMessage: undefined,
      inferred: undefined,
    });
  }

  private applyAgentStop(event: Extract<AgentEvent, { type: "agent_stop" }>): void {
    const existing = this.agents.get(event.agentId);
    // agent_stop marks the agent stopped in place — it is never removed
    // from the store, even if we've never seen an agent_start for it.
    // This is a clean, explicit stop, so `inferred` is not set even if the
    // agent had previously been reaped as stale (e.g. a late agent_stop
    // arriving after the timeout already fired) — an explicit signal
    // always wins over an inferred one.
    this.agents.set(event.agentId, {
      agentId: event.agentId,
      status: "stopped",
      team: event.team ?? existing?.team,
      // Prefer an already-known caller, but fall back to the one on the
      // event itself. A Claude Code sub-agent never emits `agent_start`
      // (no SessionStart hook fires for it), so `agent_stop` is often the
      // first — and only — event that ever creates its record; without
      // this fallback the record lands with no `caller` and the frontend
      // can't tell it apart from a top-level agent on the snapshot path
      // (#69).
      caller: existing?.caller ?? meaningfulCaller(event.agentId, event.caller),
      startedAt: existing?.startedAt,
      stoppedAt: event.timestamp,
      stopStatus: event.status,
      stopMessage: event.message,
    });
  }

  /** Records that an event bearing this agentId was just accepted. */
  private touchActivity(event: AgentEvent): void {
    const at = Date.parse(event.timestamp);
    this.lastActivityAt.set(event.agentId, Number.isNaN(at) ? Date.now() : at);
  }

  /**
   * A `tool_call_*` event is the only evidence we get that a Claude Code
   * sub-agent exists (it never emits `agent_start`), and it's the only
   * event that carries the sub-agent -> parent link via `caller`. Fold
   * that link (and `team`) onto the agent record here so it survives into
   * `getSnapshot()`; otherwise a reloaded/late-opened dashboard sees the
   * sub-agent with no `caller` and removes it after the Graph grace
   * window, exactly what #67/#68 were meant to prevent (#69). Never
   * downgrades a `running` agent (a tool call mid-run isn't a stop) and
   * never overwrites an already-known `caller`/`team`.
   */
  private noteAgentFromToolCall(
    event: Extract<AgentEvent, { type: "tool_call_start" | "tool_call_end" }>,
  ): void {
    const existing = this.agents.get(event.agentId);
    const caller = existing?.caller ?? meaningfulCaller(event.agentId, event.caller);
    const team = existing?.team ?? event.team;
    if (existing) {
      // Only touch the fields this event can contribute; leave status and
      // stop bookkeeping alone.
      if (caller !== existing.caller || team !== existing.team) {
        this.agents.set(event.agentId, { ...existing, caller, team });
      }
      return;
    }
    this.agents.set(event.agentId, {
      agentId: event.agentId,
      status: "running",
      caller,
      team,
    });
  }

  private applyToolCallStart(event: Extract<AgentEvent, { type: "tool_call_start" }>): void {
    this.noteAgentFromToolCall(event);
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
    this.noteAgentFromToolCall(event);
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

  /**
   * Best-effort liveness sweep: any agent still marked "running" that
   * hasn't produced an event of any kind (agent_start/stop, tool call,
   * log, error) for at least `timeoutMs` is presumed dead — e.g. its
   * terminal/session window was closed, its process was killed, or a
   * fire-and-forget `agent_stop` POST was silently dropped (see
   * instrumentation/hooks-emitter docs) — and is marked stopped in place.
   *
   * This is NOT a substitute for an explicit agent_stop: it's a fallback
   * so the dashboard doesn't accumulate permanently-"running" ghost nodes
   * when one never arrives. Reaped agents are flagged `inferred: true`
   * (see AgentState) so consumers can render them distinctly from a clean
   * stop, and get `stopStatus: "error"` plus a `stopMessage` explaining
   * why.
   *
   * Call on an interval from the server entrypoint (see
   * server/src/index.ts); intentionally takes `now` as a parameter so it
   * can be driven deterministically in tests without real timers.
   */
  reapStaleAgents(timeoutMs: number, now: number = Date.now()): AgentState[] {
    const reaped: AgentState[] = [];
    for (const agent of this.agents.values()) {
      if (agent.status !== "running") continue;
      const lastActivity = this.lastActivityAt.get(agent.agentId);
      // No activity ever recorded (shouldn't happen once agent_start has
      // been applied, since that always touches the clock) — skip rather
      // than reap on missing data.
      if (lastActivity === undefined) continue;
      if (now - lastActivity < timeoutMs) continue;

      const updated: AgentState = {
        ...agent,
        status: "stopped",
        stoppedAt: new Date(now).toISOString(),
        stopStatus: "error",
        stopMessage: `No activity for ${formatDuration(timeoutMs)} — presumed stopped`,
        inferred: true,
      };
      this.agents.set(agent.agentId, updated);
      reaped.push(updated);
    }
    return reaped;
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
