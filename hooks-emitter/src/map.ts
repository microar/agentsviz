/**
 * Pure mapping logic: Claude Code hook payload -> AgentsViz event envelope
 * (see /docs/event-schema.md). No I/O here — kept separate from index.ts
 * so it can be unit tested without stdin/network involved.
 *
 * Deliberately out of scope (see issue #29 / follow-up #30): deriving
 * `team`/`caller` for sub-agent hierarchies. `caller` is set to the
 * session's own agentId (the schema requires `caller` on tool call
 * events); `team` is always omitted.
 */

import type { AgentEvent, HookPayload, Status } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates the minimal shape every hook payload must have for us to do
 * anything with it. Returns null (not a throw) on anything malformed —
 * callers should treat null as "nothing to emit" and exit quietly.
 */
export function parseHookPayload(raw: unknown): HookPayload | null {
  if (!isPlainObject(raw)) return null;
  if (!isNonEmptyString(raw.session_id)) return null;
  if (!isNonEmptyString(raw.hook_event_name)) return null;
  return raw as unknown as HookPayload;
}

/**
 * Best-effort success/error + result/message extraction from a
 * PostToolUse `tool_response`. Shapes vary by tool and harness version
 * (see types.ts), so this checks several known error signals before
 * falling back to "success with the raw response as result".
 */
export function classifyToolResponse(response: unknown): {
  status: Status;
  result?: unknown;
  message?: string;
} {
  if (response === undefined || response === null) {
    return { status: "success" };
  }

  if (isPlainObject(response)) {
    const isError =
      response.type === "error" ||
      response.is_error === true ||
      response.isError === true ||
      response.success === false ||
      response.ok === false ||
      (typeof response.error === "string" && response.error.length > 0) ||
      (isPlainObject(response.error) && Object.keys(response.error).length > 0);

    if (isError) {
      const messageSource =
        (typeof response.content === "string" && response.content) ||
        (typeof response.message === "string" && response.message) ||
        (typeof response.error === "string" && response.error) ||
        (typeof response.stderr === "string" && response.stderr) ||
        undefined;
      return {
        status: "error",
        message: messageSource ?? safeStringify(response) ?? "Tool call failed",
      };
    }

    return { status: "success", result: response };
  }

  // Non-object response (string/number/etc.) with no error signal available.
  return { status: "success", result: response };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Maps one hook payload to one AgentsViz event, or `null` if this hook
 * event type isn't one we emit for (anything besides SessionStart,
 * PreToolUse, PostToolUse, Stop, SubagentStop).
 */
export function mapHookPayload(payload: HookPayload, now: () => string = () => new Date().toISOString()): AgentEvent | null {
  const agentId = payload.session_id;
  const timestamp = now();

  switch (payload.hook_event_name) {
    case "SessionStart": {
      return {
        type: "agent_start",
        timestamp,
        agentId,
      };
    }

    case "PreToolUse": {
      if (!isNonEmptyString(payload.tool_name)) return null;
      const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
      return {
        type: "tool_call_start",
        timestamp,
        agentId,
        caller: agentId,
        tool: payload.tool_name,
        input,
      };
    }

    case "PostToolUse": {
      if (!isNonEmptyString(payload.tool_name)) return null;
      const { status, result, message } = classifyToolResponse(payload.tool_response);
      return {
        type: "tool_call_end",
        timestamp,
        agentId,
        caller: agentId,
        tool: payload.tool_name,
        status,
        ...(status === "success" ? { result } : {}),
        ...(status === "error" ? { message } : {}),
      };
    }

    case "Stop": {
      return {
        type: "agent_stop",
        timestamp,
        agentId,
        status: "success",
        message: "Session stopped",
      };
    }

    case "SubagentStop": {
      return {
        type: "agent_stop",
        timestamp,
        agentId,
        status: "success",
        message: "Subagent stopped",
      };
    }

    default:
      return null;
  }
}
