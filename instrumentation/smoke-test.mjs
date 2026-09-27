// Manual smoke test: verifies the module loads and every emitter is a
// true no-op when no event server is listening — no throw, no unhandled
// rejection, no process crash. Run with `npm test` (builds then runs
// this against the compiled dist/ output).
import assert from "node:assert/strict";
import {
  createInstrumentation,
  configure,
  agentStart,
  agentStop,
  toolCallStart,
  toolCallEnd,
  log,
  error,
  withToolCall,
} from "./dist/index.js";

let unhandled = null;
process.on("unhandledRejection", (err) => {
  unhandled = err;
});

// Deliberately point at a port nothing is listening on.
const UNREACHABLE_URL = "http://127.0.0.1:59999/events";

configure({
  agentId: "smoke-test-agent",
  team: "smoke-tests",
  serverUrl: UNREACHABLE_URL,
  timeoutMs: 300,
  onError: () => {
    /* swallow — this test asserts emitters don't throw, not that they warn */
  },
});

assert.doesNotThrow(() => agentStart({ caller: "smoke-runner" }));
assert.doesNotThrow(() => toolCallStart({ caller: "smoke-test-agent", tool: "noop_tool", input: { x: 1 } }));
assert.doesNotThrow(() =>
  toolCallEnd({ caller: "smoke-test-agent", tool: "noop_tool", status: "success", result: { ok: true } }),
);
assert.doesNotThrow(() => log("smoke test log line"));
assert.doesNotThrow(() => error("smoke test error"));
assert.doesNotThrow(() => agentStop({ status: "success", message: "smoke test done" }));

// Isolated instance (multi-agent-in-one-process case) also must not throw.
const other = createInstrumentation({ agentId: "second-agent", serverUrl: UNREACHABLE_URL, timeoutMs: 300 });
assert.doesNotThrow(() => other.agentStart());
assert.doesNotThrow(() => other.log("second agent log"));

// withToolCall must still return the wrapped function's result/throw its
// error, even though the event server is unreachable.
const result = await withToolCall(
  { caller: "smoke-test-agent", tool: "compute", input: { n: 2 }, serverUrl: UNREACHABLE_URL, timeoutMs: 300 },
  () => 2 + 2,
);
assert.equal(result, 4);

await assert.rejects(
  withToolCall(
    { caller: "smoke-test-agent", tool: "failing_tool", input: {}, serverUrl: UNREACHABLE_URL, timeoutMs: 300 },
    () => {
      throw new Error("boom");
    },
  ),
  /boom/,
);

// Give any in-flight fire-and-forget fetches a moment to settle so we can
// confirm they didn't produce an unhandled rejection.
await new Promise((resolve) => setTimeout(resolve, 500));

assert.equal(unhandled, null, `expected no unhandled rejection, got: ${unhandled}`);

// Token/cost fields (#55): stub fetch to capture payloads and check that
// cost fields pass through when supplied and are absent (not `undefined`
// keys) when not.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  sent.push(JSON.parse(init.body));
  return new Response(null, { status: 202 });
};
try {
  const costly = createInstrumentation({ agentId: "cost-agent", team: "cost-team", serverUrl: UNREACHABLE_URL });
  costly.toolCallEnd({ caller: "cost-agent", tool: "llm", status: "success", result: {}, tokensIn: 10, tokensOut: 20, costUsd: 0.5 });
  costly.toolCallEnd({ caller: "cost-agent", tool: "plain", status: "success", result: {} });
  costly.agentStop({ status: "success", costUsd: 1.25 });
  await costly.withToolCall(
    {
      caller: "cost-agent",
      tool: "wrapped",
      input: {},
      tokensIn: 1,
      usage: (r) => ({ tokensOut: r.usage.out, costUsd: 0.01 }),
    },
    () => ({ usage: { out: 42 } }),
  );
  await costly.withToolCall(
    { caller: "cost-agent", tool: "bad_usage", input: {}, usage: () => { throw new Error("nope"); } },
    () => 1,
  );

  const [llmEnd, plainEnd, stop, , wrappedEnd, , badEnd] = sent;
  assert.deepEqual([llmEnd.tokensIn, llmEnd.tokensOut, llmEnd.costUsd], [10, 20, 0.5]);
  for (const key of ["tokensIn", "tokensOut", "costUsd"]) {
    assert.equal(key in plainEnd, false, `${key} must be omitted when not supplied`);
    assert.equal(key in badEnd, false, `${key} must be omitted when usage() throws`);
  }
  assert.equal(stop.type, "agent_stop");
  assert.equal(stop.costUsd, 1.25);
  assert.equal("tokensIn" in stop, false);
  assert.equal(wrappedEnd.type, "tool_call_end");
  assert.deepEqual([wrappedEnd.tokensIn, wrappedEnd.tokensOut, wrappedEnd.costUsd], [1, 42, 0.01]);
  assert.equal(badEnd.status, "success");
} finally {
  globalThis.fetch = realFetch;
}

console.log("smoke test passed: all emitters are safe no-ops with no event server running");
