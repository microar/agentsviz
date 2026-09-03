/**
 * Types for the Claude Code hook payloads this package consumes, and for
 * the event envelope it produces (mirrors /docs/event-schema.md — keep in
 * sync with that document and with instrumentation/src/types.ts).
 */

// --- Claude Code hook payloads -------------------------------------------
//
// Shapes below reflect the publicly documented hook event JSON
// (https://code.claude.com/docs/en/hooks) as of writing. Only the fields
// this package actually reads are declared; hook payloads may carry
// additional fields we ignore. All fields beyond the ones we rely on are
// treated as optional/unknown so a harness version skew doesn't crash the
// script — see mapHookPayload's defensive handling.

/**
 * Fields common to every Claude Code hook payload.
 *
 * `agent_id` / `agent_type` are documented as present "when running with
 * `--agent` or inside a subagent" — i.e. a Task-tool-spawned sub-agent's
 * own hook firings (its PreToolUse/PostToolUse/SubagentStop) carry these
 * even though `session_id` stays identical to the parent session (Claude
 * Code does not mint a distinct `session_id` per sub-agent). See
 * map.ts's `deriveAgentId`/`deriveTeam` for how this package uses them.
 */
export interface BaseHookPayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
  [key: string]: unknown;
}

export interface SessionStartPayload extends BaseHookPayload {
  hook_event_name: "SessionStart";
  session_start_reason?: string;
}

export interface PreToolUsePayload extends BaseHookPayload {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

/**
 * `tool_response` shape varies by tool and harness version. Known forms
 * include `{ type: "text" | "error", content: string }` and tool-specific
 * shapes (e.g. Bash's `{ stdout, stderr, ... }`) that may carry an
 * `is_error` / `error` field instead. We treat it as unknown and use a
 * best-effort heuristic in map.ts to decide success vs. error.
 */
export interface PostToolUsePayload extends BaseHookPayload {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
}

/**
 * `Stop` fires every time the main agent finishes a response turn — many
 * times over the life of one session — NOT when the session ends. This
 * package deliberately does not map it to `agent_stop` (issue #88): doing
 * so marked a still-active session `stopped` after its first turn and
 * dropped it from the Graph live view. The real "session is over" signal
 * is `SessionEnd` (below).
 */
export interface StopPayload extends BaseHookPayload {
  hook_event_name: "Stop";
  last_assistant_message?: string;
}

/**
 * `SessionEnd` fires once, when a Claude Code session actually terminates
 * (issue #88). This is what maps to `agent_stop` for a top-level session.
 */
export interface SessionEndPayload extends BaseHookPayload {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface SubagentStopPayload extends BaseHookPayload {
  hook_event_name: "SubagentStop";
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: string;
}

export type HookPayload =
  | SessionStartPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | StopPayload
  | SessionEndPayload
  | SubagentStopPayload;

// --- Event envelope (see /docs/event-schema.md) ---------------------------

export type Status = "success" | "error";

export type AgentEvent =
  | {
      type: "agent_start";
      timestamp: string;
      agentId: string;
      team?: string;
      caller?: string;
    }
  | {
      type: "agent_stop";
      timestamp: string;
      agentId: string;
      team?: string;
      // Parent/owning agentId. Set by the SubagentStop mapping so a Claude
      // Code sub-agent (which never emits agent_start) still carries its
      // parent link — see docs/event-schema.md and map.ts (#69).
      caller?: string;
      status: Status;
      message?: string;
    }
  | {
      type: "tool_call_start";
      timestamp: string;
      agentId: string;
      team?: string;
      caller: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_call_end";
      timestamp: string;
      agentId: string;
      team?: string;
      caller: string;
      tool: string;
      status: Status;
      result?: unknown;
      message?: string;
    };
