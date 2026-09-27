/**
 * Pure mapping logic: Claude Code hook payload -> AgentsViz event envelope
 * (see /docs/event-schema.md). No I/O here — kept separate from index.ts
 * so it can be unit tested without stdin/network involved.
 *
 * `team`/`caller` derivation for sub-agent hierarchies (issue #30):
 *
 * Claude Code hook payloads do not mint a distinct `session_id` per
 * sub-agent — a Task-tool-spawned sub-agent's own hook firings share the
 * parent's `session_id`. What they DO carry, per
 * https://code.claude.com/docs/en/hooks ("Common input fields"), is
 * `agent_id` (unique per sub-agent) and `agent_type`, present "when
 * running with `--agent` or inside a subagent" — i.e. on every hook that
 * fires *inside* the sub-agent's own execution (its PreToolUse/
 * PostToolUse/SubagentStop), but NOT on the parent's PreToolUse for the
 * `Task` tool call itself (that fires in the parent's own context, before
 * the sub-agent exists).
 *
 * This gives us a reliable-when-present correlation signal without
 * needing to track `tool_use_id` across separate hook process
 * invocations (each hook firing is a fresh, stateless process — there is
 * nowhere to persist an in-flight "Task call -> future sub-agent" map
 * short of writing to disk, which felt like more risk than the payload
 * fields already provide):
 *
 *   - `agentId` for events firing inside a sub-agent is synthesized as
 *     `${session_id}-${agent_id}`, distinct from the parent's agentId
 *     (`session_id`).
 *   - `caller` is always `session_id` — the parent/owning session's own
 *     agentId. For a top-level agent this is a self-reference (matches
 *     pre-#30 behavior); for a sub-agent event it correctly links back to
 *     the parent, which is exactly the edge the Graph tab needs to draw
 *     parent/child as connected rather than disconnected nodes.
 *
 * Fallback / honesty note: if a given Claude Code harness version ever
 * omits `agent_id` on a hook that (per docs) should carry it — e.g. an
 * older release, or a hook type not covered above — this package falls
 * back to treating the event as top-level (`agentId` = `session_id`,
 * `agent_id` treated as absent). That means such a sub-agent would be
 * indistinguishable from its parent (same agentId) rather than crashing
 * or dropping the event; it's a degraded-but-safe fallback, not a promise
 * that every sub-agent is always distinguishable.
 *
 * `team` is derived from, in order of precedence: the `$AGENTSVIZ_TEAM`
 * env var (set it in `.claude/settings.json`'s hook `env` block, or in
 * the environment Claude Code runs hooks in, to override per-project),
 * else the basename of the hook payload's `cwd`. Both the parent and any
 * sub-agent share the same `cwd` (a sub-agent runs in the same project),
 * so this naturally groups every agent from one project into one team
 * without needing extra correlation.
 */

import path from "node:path";
import type { AgentEvent, CostFields, HookPayload, Status } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The effective agentId for a hook payload: the compound sub-agent id
 * (`${session_id}-${agent_id}`) when this hook fired inside a sub-agent,
 * else just `session_id` for a top-level agent.
 */
export function deriveAgentId(payload: HookPayload): string {
  return isNonEmptyString(payload.agent_id)
    ? `${payload.session_id}-${payload.agent_id}`
    : payload.session_id;
}

/**
 * The `caller` for events on this hook payload: always the owning
 * session's own id. For a top-level agent this is a self-reference; for
 * a sub-agent event it's the parent's agentId, linking child back to
 * parent.
 */
export function deriveCaller(payload: HookPayload): string {
  return payload.session_id;
}

/**
 * `team`: `$AGENTSVIZ_TEAM` env var if set (projects can set this in
 * their own `.claude/settings.json`), else the basename of the hook
 * payload's `cwd`. Returns undefined (field omitted) when neither is
 * available.
 */
export function deriveTeam(payload: HookPayload): string | undefined {
  const envTeam = process.env.AGENTSVIZ_TEAM;
  if (isNonEmptyString(envTeam)) return envTeam;
  if (isNonEmptyString(payload.cwd)) {
    const base = path.basename(payload.cwd);
    if (isNonEmptyString(base)) return base;
  }
  return undefined;
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

// --- Token/cost extraction (#55) -------------------------------------------
//
// Best-effort only. As of writing, Claude Code hook payloads do NOT carry
// token usage or cost directly:
//   - PostToolUse's `tool_response` is the tool's own output. Ordinary
//     tools have no usage block; the Task/Agent tool's response may include
//     the *sub-agent's* `usage`, but that's attributed to the sub-agent via
//     its SubagentStop transcript instead (see below), so we deliberately
//     skip it here to avoid double counting.
//   - SessionEnd / SubagentStop carry no usage, but do carry a path to the
//     JSONL transcript (`transcript_path` / `agent_transcript_path`), whose
//     assistant entries have the Anthropic API `message.usage` block.
//     index.ts reads that file and `summarizeTranscriptUsage` sums it — the
//     one path that yields real token counts today.
// Cost in USD is only filled in when a source actually reports it (e.g. a
// `costUSD` / `total_cost_usd` field); we never estimate it from a price
// table, since those drift and would present guesses as data.

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Tools whose response usage belongs to a sub-agent, reported at SubagentStop. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/**
 * Pulls tokensIn/tokensOut/costUsd out of an arbitrary object, if it
 * carries an Anthropic-style `usage` block (`input_tokens`, `output_tokens`,
 * plus cache read/creation input tokens, which count toward `tokensIn`) or
 * a known cost field. Returns `{}` for anything unrecognized — never throws.
 */
export function extractUsage(value: unknown): CostFields {
  if (!isPlainObject(value)) return {};
  const out: CostFields = {};
  const usage = isPlainObject(value.usage) ? value.usage : undefined;
  if (usage) {
    const inputParts = [
      nonNegativeNumber(usage.input_tokens),
      nonNegativeNumber(usage.cache_creation_input_tokens),
      nonNegativeNumber(usage.cache_read_input_tokens),
    ].filter((n): n is number => n !== undefined);
    if (inputParts.length > 0) out.tokensIn = inputParts.reduce((a, b) => a + b, 0);
    const output = nonNegativeNumber(usage.output_tokens);
    if (output !== undefined) out.tokensOut = output;
  }
  const cost =
    nonNegativeNumber(value.costUsd) ??
    nonNegativeNumber(value.costUSD) ??
    nonNegativeNumber(value.cost_usd) ??
    nonNegativeNumber(value.total_cost_usd);
  if (cost !== undefined) out.costUsd = cost;
  return out;
}

function addCost(a: CostFields, b: CostFields): CostFields {
  const out: CostFields = { ...a };
  for (const key of ["tokensIn", "tokensOut", "costUsd"] as const) {
    if (b[key] !== undefined) out[key] = (out[key] ?? 0) + b[key];
  }
  return out;
}

/**
 * Sums token usage across a Claude Code JSONL transcript. Each assistant
 * API response can be written as several lines (one per content block)
 * sharing one `message.id` and repeating its usage, so entries are
 * de-duplicated by that id (last line wins). Malformed lines are skipped.
 * `excludeSidechain` drops `isSidechain: true` entries — sub-agent turns
 * that older harness versions inline into the parent transcript and that
 * are already counted at the sub-agent's own SubagentStop.
 */
export function summarizeTranscriptUsage(
  jsonl: string,
  options: { excludeSidechain?: boolean } = {},
): CostFields {
  const byMessageId = new Map<string, CostFields>();
  let anonymous: CostFields = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry)) continue;
    if (options.excludeSidechain && entry.isSidechain === true) continue;
    const message = isPlainObject(entry.message) ? entry.message : undefined;
    const usage = addCost(extractUsage(message), extractUsage({ costUSD: entry.costUSD }));
    if (Object.keys(usage).length === 0) continue;
    if (message && isNonEmptyString(message.id)) byMessageId.set(message.id, usage);
    else anonymous = addCost(anonymous, usage);
  }
  let total = anonymous;
  for (const usage of byMessageId.values()) total = addCost(total, usage);
  return total;
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
 * PreToolUse, PostToolUse, SessionEnd, SubagentStop).
 *
 * Note `Stop` is intentionally NOT mapped (issue #88): Claude Code fires
 * `Stop` at the end of every assistant turn, not when the session ends,
 * so mapping it to `agent_stop` marked a live session `stopped` after its
 * first turn and dropped it from the Graph live view. The real
 * end-of-session hook is `SessionEnd`; a session that exits without one
 * (window closed, process killed) is still covered by the server's
 * stale-agent reaper.
 */
export function mapHookPayload(payload: HookPayload, now: () => string = () => new Date().toISOString()): AgentEvent | null {
  const agentId = deriveAgentId(payload);
  const team = deriveTeam(payload);
  const timestamp = now();

  switch (payload.hook_event_name) {
    case "SessionStart": {
      return {
        type: "agent_start",
        timestamp,
        agentId,
        ...(team ? { team } : {}),
        // A sub-agent never gets its own SessionStart hook (Claude Code
        // has no such hook for sub-agents), but handle it defensively in
        // case a future harness version ever fires one with agent_id set.
        ...(isNonEmptyString(payload.agent_id) ? { caller: deriveCaller(payload) } : {}),
      };
    }

    case "PreToolUse": {
      if (!isNonEmptyString(payload.tool_name)) return null;
      const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
      return {
        type: "tool_call_start",
        timestamp,
        agentId,
        ...(team ? { team } : {}),
        caller: deriveCaller(payload),
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
        ...(team ? { team } : {}),
        caller: deriveCaller(payload),
        tool: payload.tool_name,
        status,
        ...(status === "success" ? { result } : {}),
        ...(status === "error" ? { message } : {}),
        ...(SUBAGENT_TOOLS.has(payload.tool_name) ? {} : extractUsage(payload.tool_response)),
      };
    }

    case "Stop": {
      // End of one assistant turn, not the session (issue #88). The
      // session is still live and will keep emitting tool calls — do not
      // stop the agent here. `SessionEnd` handles real termination.
      return null;
    }

    case "SessionEnd": {
      return {
        type: "agent_stop",
        timestamp,
        agentId,
        ...(team ? { team } : {}),
        status: "success",
        message: "Session ended",
        // No harness version we know of sends usage here — index.ts fills
        // it from the transcript instead — but pick it up if one ever does.
        ...extractUsage(payload),
      };
    }

    case "SubagentStop": {
      return {
        type: "agent_stop",
        timestamp,
        agentId,
        ...(team ? { team } : {}),
        // A sub-agent never fires SessionStart, so this SubagentStop is
        // usually the first event that creates its record on the server.
        // Carry the parent link (same `caller` PreToolUse/PostToolUse use)
        // so the sub-agent's snapshot record has a `caller` and the Graph
        // keeps rendering it after a reload (#69).
        caller: deriveCaller(payload),
        status: "success",
        message: "Subagent stopped",
        ...extractUsage(payload),
      };
    }

    default:
      return null;
  }
}
