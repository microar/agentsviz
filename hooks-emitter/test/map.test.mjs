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
    caller: "sess-1", // schema requires `caller`; sub-agent hierarchy derivation is out of scope (#30)
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

// --- Stop / SubagentStop -> agent_stop -----------------------------------

{
  const event = mapHookPayload({ session_id: "sess-1", hook_event_name: "Stop" }, fixedNow);
  assert.equal(event.type, "agent_stop");
  assert.equal(event.status, "success");
  assert.equal(event.agentId, "sess-1");
}

{
  const event = mapHookPayload(
    { session_id: "sess-1", hook_event_name: "SubagentStop", agent_id: "sub-1" },
    fixedNow,
  );
  assert.equal(event.type, "agent_stop");
  assert.equal(event.status, "success");
  // agentId derivation from sub-agent hierarchy (agent_id vs session_id)
  // is out of scope for this issue (#30) — we always use session_id.
  assert.equal(event.agentId, "sess-1");
}

// --- Unmapped hook events -------------------------------------------------

assert.equal(
  mapHookPayload({ session_id: "sess-1", hook_event_name: "Notification" }, fixedNow),
  null,
  "hook events outside the mapped 4 (+Stop/SubagentStop) produce nothing to emit",
);

console.log("hooks-emitter map tests passed");
