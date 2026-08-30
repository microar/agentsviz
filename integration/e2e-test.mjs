#!/usr/bin/env node
/**
 * End-to-end integration test for issue #10.
 *
 * This does NOT invoke real, API-backed Claude Code agents (too costly and
 * nondeterministic for an automated test that runs in CI / on every dev
 * machine). Instead it drives a SIMULATED multi-agent execution through the
 * real `instrumentation/` helper module — the exact same functions a real
 * agent would call — against the real, unmodified event server started
 * fresh as a child process. It then reconnects over the real WebSocket
 * protocol and asserts that the server's in-memory state store reflects the
 * simulated run accurately: correct final agent statuses, correct tool-call
 * correlation/status, correct log capture, correct event ordering, and zero
 * dropped events.
 *
 * See integration/README.md for what this proves, and its "Known gaps"
 * section for what it deliberately does not.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "../server");
const INSTRUMENTATION_ENTRY = path.resolve(__dirname, "../instrumentation/dist/index.js");

const failures = [];
let serverProcess;
let liveSocket;

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error(`  [FAIL] ${message}`);
  } else {
    console.log(`  [ OK ] ${message}`);
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`Server never became healthy at ${baseUrl}/health: ${lastErr}`);
}

/** Poll a predicate until it's true, or throw on timeout. */
async function waitUntil(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function main() {
  console.log("== Step 1: start the real event server as a child process ==");
  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  // The server requires an auth token on /events and the /ws handshake
  // (issue #52). With no AGENTSVIZ_API_KEYS set it accepts only the shared
  // dev token, which the instrumentation helper also defaults to — so the
  // POSTs below need no extra wiring; only the raw WebSocket URL does.
  const DEV_TOKEN = "dev-local-token";
  const wsUrl = `ws://localhost:${port}/ws?token=${DEV_TOKEN}`;

  serverProcess = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  serverProcess.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`Server process exited early with code ${code} (signal ${signal})`);
      console.error(serverOutput);
    }
  });

  await waitForHealth(baseUrl);
  console.log(`  Server healthy at ${baseUrl}`);

  console.log("== Step 2: open a live WebSocket client to observe the broadcast stream ==");
  liveSocket = new WebSocket(wsUrl);
  const receivedEvents = []; // every non-snapshot message, in arrival order
  let snapshotOnConnect;

  await new Promise((resolve, reject) => {
    liveSocket.addEventListener("error", reject);
    liveSocket.addEventListener("open", () => resolve());
  });

  liveSocket.addEventListener("message", (msg) => {
    const parsed = JSON.parse(msg.data);
    if (parsed.type === "snapshot") {
      snapshotOnConnect = parsed.data;
      return;
    }
    receivedEvents.push(parsed);
  });

  await waitUntil(() => snapshotOnConnect !== undefined, "initial snapshot on WS connect");
  console.log("  Received initial (empty) snapshot on connect");

  console.log("== Step 3: simulate a 2-agent run through the real instrumentation helper ==");
  const { createInstrumentation } = await import(INSTRUMENTATION_ENTRY);

  const runId = Date.now().toString(36);
  const team = "sim-crew";
  const agentAId = `agent-a-${runId}`;
  const agentBId = `agent-b-${runId}`;

  const agentA = createInstrumentation({ agentId: agentAId, team, serverUrl: `${baseUrl}/events`, timeoutMs: 5000 });
  const agentB = createInstrumentation({ agentId: agentBId, team, serverUrl: `${baseUrl}/events`, timeoutMs: 5000 });

  const sentEvents = []; // description of each event as WE sent it, in send order

  /**
   * Fires one instrumentation emitter (fire-and-forget by design) and then
   * waits for the server to actually broadcast it back to our live WS
   * client before returning. This gives the test strict, verifiable
   * ordering without changing the (intentionally non-blocking) helper API.
   */
  async function emit(description, fn) {
    const before = receivedEvents.length;
    fn();
    await waitUntil(
      () => receivedEvents.length > before,
      `event to arrive over WS: ${description}`,
    );
    sentEvents.push({ description, event: receivedEvents[before] });
  }

  // Agent A starts, plans to delegate to Agent B.
  await emit("agent_start agent-a", () => agentA.agentStart({ caller: "user" }));
  await emit("log agent-a (planning)", () =>
    agentA.log("Agent A starting: delegating summarization to Agent B"),
  );

  // Agent A calls Agent B as a tool (manual before/after form, per README).
  await emit("tool_call_start agent-a -> agent-b", () =>
    agentA.toolCallStart({
      caller: agentAId,
      tool: "agent-b",
      input: { task: "summarize findings" },
    }),
  );

  // Agent B runs, nested inside Agent A's tool call.
  await emit("agent_start agent-b", () => agentB.agentStart({ caller: agentAId }));
  await emit("log agent-b (processing)", () =>
    agentB.log("Agent B received task from Agent A, processing"),
  );
  await emit("agent_stop agent-b (success)", () =>
    agentB.agentStop({ status: "success", message: "Summary produced" }),
  );

  await emit("tool_call_end agent-a -> agent-b (success)", () =>
    agentA.toolCallEnd({
      caller: agentAId,
      tool: "agent-b",
      status: "success",
      result: { summary: "3 key findings" },
    }),
  );

  await emit("log agent-a (post-delegation)", () =>
    agentA.log("Agent A received summary from Agent B, continuing"),
  );

  // Deliberate error case #1: a tool call that fails.
  await emit("tool_call_start agent-a -> flaky-search-tool", () =>
    agentA.toolCallStart({
      caller: agentAId,
      tool: "flaky-search-tool",
      input: { query: "edge case data" },
    }),
  );
  await emit("tool_call_end agent-a -> flaky-search-tool (error)", () =>
    agentA.toolCallEnd({
      caller: agentAId,
      tool: "flaky-search-tool",
      status: "error",
      message: "Request timed out after 5000ms",
    }),
  );

  // Deliberate error case #2: a standalone error event, not tied to a tool call.
  await emit("error agent-a (recoverable)", () =>
    agentA.error(
      "Non-fatal validation error while processing flaky-search-tool output; falling back to cached data",
    ),
  );

  await emit("agent_stop agent-a (success)", () =>
    agentA.agentStop({ status: "success", message: "Completed with 1 recoverable tool error" }),
  );

  console.log(`  Simulated ${sentEvents.length} events across 2 agents`);

  console.log("== Step 4: assert no dropped events ==");
  assert(
    receivedEvents.length === sentEvents.length,
    `all ${sentEvents.length} sent events were broadcast back (got ${receivedEvents.length})`,
  );

  console.log("== Step 5: assert execution order matches actual send order ==");
  let orderOk = true;
  for (let i = 0; i < sentEvents.length; i++) {
    const expected = sentEvents[i].event;
    const actual = receivedEvents[i];
    if (!actual || actual.type !== expected.type || actual.agentId !== expected.agentId) {
      orderOk = false;
      console.error(
        `  order mismatch at index ${i}: expected ${expected.type}/${expected.agentId} (${sentEvents[i].description}), got ${actual?.type}/${actual?.agentId}`,
      );
    }
  }
  assert(orderOk, "received event order exactly matches emitted order");

  // Causal sanity checks, independent of the strict-order check above:
  // Agent B's whole lifecycle must be nested inside Agent A's tool call bracket.
  const idxOf = (type, agentId, extra = {}) =>
    receivedEvents.findIndex(
      (e) =>
        e.type === type &&
        e.agentId === agentId &&
        Object.entries(extra).every(([k, v]) => e[k] === v),
    );

  const iToolStart = idxOf("tool_call_start", agentAId, { tool: "agent-b" });
  const iBStart = idxOf("agent_start", agentBId);
  const iBStop = idxOf("agent_stop", agentBId);
  const iToolEnd = idxOf("tool_call_end", agentAId, { tool: "agent-b" });
  assert(
    iToolStart !== -1 && iBStart !== -1 && iBStop !== -1 && iToolEnd !== -1 &&
      iToolStart < iBStart && iBStart < iBStop && iBStop < iToolEnd,
    "agent-b's start/log/stop lifecycle is fully nested inside agent-a's tool_call_start/tool_call_end bracket",
  );

  console.log("== Step 6: reconnect and assert the final state snapshot ==");
  const verifySocket = new WebSocket(wsUrl);
  const finalSnapshot = await new Promise((resolve, reject) => {
    verifySocket.addEventListener("error", reject);
    verifySocket.addEventListener("message", (msg) => {
      const parsed = JSON.parse(msg.data);
      if (parsed.type === "snapshot") resolve(parsed.data);
    });
  });
  verifySocket.close();

  const agentAState = finalSnapshot.agents.find((a) => a.agentId === agentAId);
  const agentBState = finalSnapshot.agents.find((a) => a.agentId === agentBId);

  assert(!!agentAState, "agent-a appears in the final snapshot");
  assert(agentAState?.status === "stopped", `agent-a final status is "stopped" (got ${agentAState?.status})`);
  assert(
    agentAState?.stopStatus === "success",
    `agent-a stop status is "success" (got ${agentAState?.stopStatus})`,
  );
  assert(!!agentBState, "agent-b appears in the final snapshot");
  assert(agentBState?.status === "stopped", `agent-b final status is "stopped" (got ${agentBState?.status})`);
  assert(
    agentBState?.stopStatus === "success",
    `agent-b stop status is "success" (got ${agentBState?.stopStatus})`,
  );

  const delegationCall = finalSnapshot.toolCalls.find(
    (c) => c.agentId === agentAId && c.tool === "agent-b",
  );
  assert(!!delegationCall, "agent-a -> agent-b tool call is recorded");
  assert(
    delegationCall?.status === "success",
    `agent-a -> agent-b tool call status is "success" (got ${delegationCall?.status})`,
  );

  const flakyCall = finalSnapshot.toolCalls.find(
    (c) => c.agentId === agentAId && c.tool === "flaky-search-tool",
  );
  assert(!!flakyCall, "agent-a -> flaky-search-tool tool call is recorded");
  assert(
    flakyCall?.status === "error",
    `agent-a -> flaky-search-tool tool call status is "error" (got ${flakyCall?.status})`,
  );
  assert(
    flakyCall?.message === "Request timed out after 5000ms",
    "flaky-search-tool error message is captured verbatim",
  );

  assert(
    finalSnapshot.teams[team]?.includes(agentAId) && finalSnapshot.teams[team]?.includes(agentBId),
    `both agents are grouped under team "${team}" in the snapshot`,
  );

  // Log lines aren't part of the state snapshot (see store.ts: log/error
  // don't mutate state) — verify them from the live broadcast stream instead.
  const agentALogs = receivedEvents.filter((e) => e.type === "log" && e.agentId === agentAId);
  const agentBLogs = receivedEvents.filter((e) => e.type === "log" && e.agentId === agentBId);
  assert(agentALogs.length === 2, `agent-a emitted 2 log lines (got ${agentALogs.length})`);
  assert(agentBLogs.length === 1, `agent-b emitted 1 log line (got ${agentBLogs.length})`);

  const errorEvents = receivedEvents.filter((e) => e.type === "error" && e.agentId === agentAId);
  assert(errorEvents.length === 1, `agent-a emitted 1 standalone error event (got ${errorEvents.length})`);
}

async function cleanup() {
  try {
    liveSocket?.close();
  } catch {
    /* ignore */
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      sleep(3000),
    ]);
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("Integration test crashed:", err);
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  await cleanup();
}

console.log("\n=== Summary ===");
if (failures.length === 0) {
  console.log("PASS: simulated multi-agent run matches server state exactly, no dropped events.");
} else {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  exitCode = 1;
}

process.exit(exitCode);
