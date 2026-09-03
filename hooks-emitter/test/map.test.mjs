// Unit test for the pure payload-mapping logic in src/map.ts (compiled to
// dist/map.js). No network, no stdin, no child processes involved — just
// hook payload in, event envelope out. Asserts each mapped event satisfies
// the field requirements from /docs/event-schema.md (mirrored in
// server/src/eventSchema.ts), matching the lightweight test style used by
// instrumentation/smoke-test.mjs.
import assert from "node:assert/strict";
import { classifyToolResponse, mapHookPayload, parseHookPayload } from "../dist/map.js";

const fixedNow = () => "2026-08-25T00:00:00.000Z";

// --- parseHookPayload -------------------------------------------------

assert.equal(parseHookPayload(null), null, "null input rejected");
assert.equal(parseHookPayload("not json"), null, "non-object input rejected");
assert.equal(parseHookPayload({}), null, "missing session_id/hook_event_name rejected");
assert.equal(
  parseHookPayload({ session_id: "s1" }),
  null,
  "missing hook_event_name rejected",
);
assert.deepEqual(
  parseHookPayload({ session_id: "s1", hook_event_name: "SessionStart" }),
  { session_id: "s1", hook_event_name: "SessionStart" },
  "minimal valid payload accepted",
);

// --- SessionStart -> agent_start ---------------------------------------

{
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SessionStart", session_start_reason: "startup" },
    fixedNow,
  );
  assert.deepEqual(event, {
    type: "agent_start",
    timestamp: "2026-08-25T00:00:00.000Z",
    agentId: "sess-1",
  });
}

// --- PreToolUse -> tool_call_start --------------------------------------

{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    fixedNow,
  );
  assert.deepEqual(event, {
    type: "tool_call_start",
    timestamp: "2026-08-25T00:00:00.000Z",
    agentId: "sess-1",
    caller: "sess-1", // no agent_id on this payload -> top-level agent, caller is a self-reference
    tool: "Bash",
    input: { command: "ls" },
  });
}

// PreToolUse with missing/non-object tool_input still produces a valid
// event with input defaulted to {} (schema requires `input` to be an object).
{
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash" },
    fixedNow,
  );
  assert.deepEqual(event.input, {});
}

// PreToolUse missing tool_name -> nothing to emit.
assert.equal(
  mapHookPayload({ session_id: "sess-1", hook_event_name: "PreToolUse" }, fixedNow),
  null,
);

// --- PostToolUse -> tool_call_end ---------------------------------------

// Success: plain object response.
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { type: "text", content: "ok" },
    },
    fixedNow,
  );
  assert.equal(event.type, "tool_call_end");
  assert.equal(event.status, "success");
  assert.deepEqual(event.result, { type: "text", content: "ok" });
  assert.equal(event.message, undefined);
  assert.equal(event.caller, "sess-1");
}

// Success: no tool_response at all.
{
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "PostToolUse", tool_name: "Read" },
    fixedNow,
  );
  assert.equal(event.status, "success");
}

// Error: { type: "error", content }.
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { type: "error", content: "exit code: 1" },
    },
    fixedNow,
  );
  assert.equal(event.status, "error");
  assert.equal(event.message, "exit code: 1");
  assert.equal(event.result, undefined);
}

// Error: { is_error: true } with no textual content -> falls back to a
// stringified message so `message` is never empty when status is "error"
// (required by the schema).
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_response: { is_error: true, details: { code: 42 } },
    },
    fixedNow,
  );
  assert.equal(event.status, "error");
  assert.ok(event.message && event.message.length > 0, "message must be non-empty on error");
}

// Error: { success: false }.
{
  const { status } = classifyToolResponse({ success: false });
  assert.equal(status, "error");
}

// Non-object tool_response (e.g. a plain string) with no error signal ->
// treated as success.
{
  const { status, result } = classifyToolResponse("plain string output");
  assert.equal(status, "success");
  assert.equal(result, "plain string output");
}

// --- Stop -> nothing (issue #88) ---------------------------------------

// Claude Code fires `Stop` at the end of every assistant turn, not when
// the session ends. Mapping it to `agent_stop` marked a still-active
// session `stopped` after its first turn and dropped it from the Graph
// live view. `Stop` now emits nothing; `SessionEnd` stops the agent.
assert.equal(
  mapHookPayload({ session_id: "sess-1", hook_event_name: "Stop" }, fixedNow),
  null,
  "Stop produces nothing to emit — it is an end-of-turn marker, not session end",
);

// --- SessionEnd -> agent_stop -----------------------------------------

{
  const event = mapHookPayload({ session_id: "sess-1", hook_event_name: "SessionEnd", reason: "exit" }, fixedNow);
  assert.equal(event.type, "agent_stop");
  assert.equal(event.status, "success");
  assert.equal(event.agentId, "sess-1");
  assert.equal(event.message, "Session ended");
}

// --- SubagentStop -> agent_stop (unchanged) ---------------------------

{
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SubagentStop", agent_id: "sub-1" },
    fixedNow,
  );
  assert.equal(event.type, "agent_stop");
  assert.equal(event.status, "success");
  // Sub-agent agentId is synthesized as `${session_id}-${agent_id}` so it
  // is distinct from the parent's own agentId (see #30 / map.ts header).
  assert.equal(event.agentId, "sess-1-sub-1");
  // SubagentStop carries `caller` = parent session_id (#69): it is usually
  // the first event the server sees for a sub-agent (no SessionStart hook
  // fires for one), so it must carry the parent link or the sub-agent's
  // snapshot record lands with no `caller`.
  assert.equal(event.caller, "sess-1", "SubagentStop links the sub-agent back to its parent");
}

// --- team/caller derivation for sub-agent hierarchies (#30) --------------

// PreToolUse firing inside a sub-agent (agent_id present, per
// https://code.claude.com/docs/en/hooks) gets a compound agentId and a
// caller pointing back at the parent session_id, linking child to parent.
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      agent_id: "sub-1",
      agent_type: "Explore",
    },
    fixedNow,
  );
  assert.equal(event.agentId, "sess-1-sub-1", "sub-agent gets a distinct agentId");
  assert.equal(event.caller, "sess-1", "caller links the sub-agent event back to the parent");
}

// PostToolUse firing inside a sub-agent: same agentId/caller derivation.
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { type: "text", content: "ok" },
      agent_id: "sub-1",
    },
    fixedNow,
  );
  assert.equal(event.agentId, "sess-1-sub-1");
  assert.equal(event.caller, "sess-1");
}

// PreToolUse for the Task tool call itself fires in the PARENT's own
// context (no agent_id yet — the sub-agent doesn't exist until Claude
// Code spawns it), so it maps like any other top-level tool call: the
// parent spawning a child is recorded by the child's own later events
// (above) carrying `caller: parentSessionId`, not by this event.
{
  const event = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { description: "Explore the codebase", subagent_type: "Explore" },
    },
    fixedNow,
  );
  assert.equal(event.agentId, "sess-1");
  assert.equal(event.caller, "sess-1");
  assert.equal(event.tool, "Task");
}

// team: no cwd, no env var -> omitted.
{
  const original = process.env.AGENTSVIZ_TEAM;
  delete process.env.AGENTSVIZ_TEAM;
  const event = mapHookPayload({ session_id: "sess-1", hook_event_name: "SessionStart" }, fixedNow);
  assert.equal(event.team, undefined);
  if (original !== undefined) process.env.AGENTSVIZ_TEAM = original;
}

// team: derived from basename(cwd) when no env override is set.
{
  const original = process.env.AGENTSVIZ_TEAM;
  delete process.env.AGENTSVIZ_TEAM;
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/Users/dev/projects/agentsviz" },
    fixedNow,
  );
  assert.equal(event.team, "agentsviz");
  if (original !== undefined) process.env.AGENTSVIZ_TEAM = original;
}

// team: $AGENTSVIZ_TEAM env var takes precedence over cwd basename.
{
  const original = process.env.AGENTSVIZ_TEAM;
  process.env.AGENTSVIZ_TEAM = "platform-team";
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/Users/dev/projects/agentsviz" },
    fixedNow,
  );
  assert.equal(event.team, "platform-team");
  if (original === undefined) delete process.env.AGENTSVIZ_TEAM;
  else process.env.AGENTSVIZ_TEAM = original;
}

// team is populated consistently for a parent and its sub-agent sharing
// the same cwd (both derive the same team, satisfying #30's acceptance
// criterion that team is consistent across an entire project's agents).
{
  const original = process.env.AGENTSVIZ_TEAM;
  delete process.env.AGENTSVIZ_TEAM;
  const parentEvent = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/repo/agentsviz" },
    fixedNow,
  );
  const childEvent = mapHookPayload(
    {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      cwd: "/repo/agentsviz",
      agent_id: "sub-2",
    },
    fixedNow,
  );
  assert.equal(parentEvent.team, "agentsviz");
  assert.equal(childEvent.team, "agentsviz");
  assert.equal(parentEvent.team, childEvent.team);
  if (original !== undefined) process.env.AGENTSVIZ_TEAM = original;
}

// --- Unmapped hook events -------------------------------------------------

assert.equal(
  mapHookPayload({ session_id: "sess-1", hook_event_name: "Notification" }, fixedNow),
  null,
  "hook events outside the mapped set (SessionStart/PreToolUse/PostToolUse/SessionEnd/SubagentStop) produce nothing to emit",
);

console.log("hooks-emitter map tests passed");
