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

console.log("smoke test passed: all emitters are safe no-ops with no event server running");
