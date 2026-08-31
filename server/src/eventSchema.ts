/**
 * Validation for events against the schema defined in /docs/event-schema.md.
 *
 * Six event types share one envelope (`type`, `timestamp`, `agentId`, plus
 * `team`/`caller` as contextual metadata); each type additionally requires
 * a subset of `tool`, `input`, `result`, `status`, `message` as described
 * in the doc's "field usage by event type" table.
 */

export const EVENT_TYPES = [
  "agent_start",
  "agent_stop",
  "tool_call_start",
  "tool_call_end",
  "log",
  "error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const STATUS_VALUES = ["success", "error"] as const;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Typed shape of a validated event, discriminated on `type`. Consumers
 * (e.g. the state store) can call `validateEvent` first and then treat the
 * body as `AgentEvent` for exhaustive, type-safe handling per event type.
 */
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
      // Optional: the parent/owning agentId. Carried by `hooks-emitter`'s
      // `SubagentStop` mapping so a Claude Code sub-agent's record gets a
      // `caller` even though it never emits `agent_start` (#69). Validated
      // by the shared envelope check (non-empty string when present).
      caller?: string;
      status: "success" | "error";
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
      status: "success" | "error";
      result?: unknown;
      message?: string;
    }
  | {
      type: "log";
      timestamp: string;
      agentId: string;
      team?: string;
      message: string;
    }
  | {
      type: "error";
      timestamp: string;
      agentId: string;
      team?: string;
      caller?: string;
      status: "error";
      message: string;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Basic ISO 8601 sanity check: must be parseable as a valid Date and
// look like an ISO timestamp (not e.g. a bare number or arbitrary string).
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validates a raw request body against the event schema. Returns
 * `{ valid: true, errors: [] }` on success, or `{ valid: false, errors }`
 * with one human-readable message per problem found.
 */
export function validateEvent(body: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    return { valid: false, errors: ["Request body must be a JSON object."] };
  }

  const { type, timestamp, agentId, team, caller, tool, input, status, message } = body as Record<
    string,
    unknown
  >;

  if (!isNonEmptyString(type) || !EVENT_TYPES.includes(type as EventType)) {
    errors.push(`"type" is required and must be one of: ${EVENT_TYPES.join(", ")}.`);
    // Without a valid type we can't check type-specific fields meaningfully.
    return { valid: false, errors };
  }

  if (!isIsoTimestamp(timestamp)) {
    errors.push('"timestamp" is required and must be an ISO 8601 UTC string, e.g. "2026-08-24T14:32:01.123Z".');
  }

  if (!isNonEmptyString(agentId)) {
    errors.push('"agentId" is required and must be a non-empty string.');
  }

  if (team !== undefined && !isNonEmptyString(team)) {
    errors.push('"team" must be a non-empty string when present.');
  }

  if (caller !== undefined && !isNonEmptyString(caller)) {
    errors.push('"caller" must be a non-empty string when present.');
  }

  const eventType = type as EventType;

  switch (eventType) {
    case "agent_start": {
      // type, timestamp, agentId required; team, caller optional. Nothing else required.
      break;
    }

    case "agent_stop": {
      if (!isNonEmptyString(status) || !STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number])) {
        errors.push('"status" is required for "agent_stop" and must be "success" or "error".');
      }
      if (message !== undefined && typeof message !== "string") {
        errors.push('"message" must be a string when present.');
      }
      break;
    }

    case "tool_call_start": {
      if (!isNonEmptyString(caller)) {
        errors.push('"caller" is required for "tool_call_start".');
      }
      if (!isNonEmptyString(tool)) {
        errors.push('"tool" is required for "tool_call_start".');
      }
      if (!isPlainObject(input)) {
        errors.push('"input" is required for "tool_call_start" and must be an object.');
      }
      break;
    }

    case "tool_call_end": {
      if (!isNonEmptyString(caller)) {
        errors.push('"caller" is required for "tool_call_end".');
      }
      if (!isNonEmptyString(tool)) {
        errors.push('"tool" is required for "tool_call_end".');
      }
      if (!isNonEmptyString(status) || !STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number])) {
        errors.push('"status" is required for "tool_call_end" and must be "success" or "error".');
      }
      if (status === "error" && !isNonEmptyString(message)) {
        errors.push('"message" is required for "tool_call_end" when "status" is "error".');
      }
      break;
    }

    case "log": {
      if (!isNonEmptyString(message)) {
        errors.push('"message" is required for "log".');
      }
      break;
    }

    case "error": {
      if (status !== "error") {
        errors.push('"status" is required for "error" and must be "error".');
      }
      if (!isNonEmptyString(message)) {
        errors.push('"message" is required for "error".');
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
