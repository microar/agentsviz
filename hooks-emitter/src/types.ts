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

/** Fields common to every Claude Code hook payload. */
export interface BaseHookPayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
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

export interface StopPayload extends BaseHookPayload {
  hook_event_name: "Stop";
  last_assistant_message?: string;
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
