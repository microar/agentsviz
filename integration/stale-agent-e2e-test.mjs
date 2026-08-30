#!/usr/bin/env node
/**
 * End-to-end integration test for issue #37.
 *
 * `server/test/store.test.ts` unit-tests `StateStore.reapStaleAgents` in
 * isolation with a synthetic clock. This test instead proves the whole
 * server-side liveness feature works end to end against a real, unmodified
 * server process: the `AGENT_STALE_TIMEOUT_MS`/`AGENT_STALE_CHECK_INTERVAL_MS`
 * env vars actually wire up the `setInterval` sweep in `server/src/index.ts`,
 * a reaped agent is broadcast live over the real WebSocket connection (not
 * just visible on next reconnect), and an agent that keeps emitting events
 * of any type is never falsely reaped.
 *
 * It does not send an `agent_stop` for the agent under test at all —
 * simulating a session whose window was closed / process was killed before
 * it could report — and instead lets the configured timeout elapse.
 *
 * See integration/README.md for what these tests prove and their "Known
 * gaps".
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

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
async function waitUntil(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

// The server requires an auth token on /events and the /ws handshake
// (issue #52). With no AGENTSVIZ_API_KEYS set on the spawned server it
// accepts only this shared dev token.
const DEV_TOKEN = "dev-local-token";

function postEvent(baseUrl, event) {
  return fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEV_TOKEN}`,
    },
    body: JSON.stringify(event),
  });
}

const SERVER_DIR = new URL("../server", import.meta.url).pathname;

async function main() {
  console.log("== Step 1: start the real event server with a short stale-agent timeout ==");
  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}/ws?token=${DEV_TOKEN}`;

  // Short enough to make the test fast, long enough to be reliably
  // distinguishable from normal request/broadcast latency.
  const STALE_TIMEOUT_MS = 1200;
  const CHECK_INTERVAL_MS = 200;

  serverProcess = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_STALE_TIMEOUT_MS: String(STALE_TIMEOUT_MS),
      AGENT_STALE_CHECK_INTERVAL_MS: String(CHECK_INTERVAL_MS),
    },
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
  console.log(`  Server healthy at ${baseUrl} (stale timeout ${STALE_TIMEOUT_MS}ms, checked every ${CHECK_INTERVAL_MS}ms)`);

  console.log("== Step 2: open a live WebSocket client to observe live broadcasts ==");
  liveSocket = new WebSocket(wsUrl);
  const snapshots = []; // every { type: "snapshot", data } broadcast, in arrival order
  let initialSnapshotSeen = false;

  await new Promise((resolve, reject) => {
    liveSocket.addEventListener("error", reject);
    liveSocket.addEventListener("open", () => resolve());
  });

  liveSocket.addEventListener("message", (msg) => {
    const parsed = JSON.parse(msg.data);
    if (parsed.type === "snapshot") {
      if (!initialSnapshotSeen) {
        initialSnapshotSeen = true;
        return; // the initial (empty) snapshot on connect isn't a reap broadcast
      }
      snapshots.push(parsed.data);
    }
  });

  await waitUntil(() => initialSnapshotSeen, "initial snapshot on WS connect");

  console.log("== Step 3: start two agents; only one keeps emitting events ==");
  const runId = Date.now().toString(36);
  const deadAgentId = `agent-killed-${runId}`;
  const liveAgentId = `agent-alive-${runId}`;

  await postEvent(baseUrl, {
    type: "agent_start",
    timestamp: new Date().toISOString(),
    agentId: deadAgentId,
  });
  await postEvent(baseUrl, {
    type: "agent_start",
    timestamp: new Date().toISOString(),
    agentId: liveAgentId,
  });

  // deadAgentId never sends anything else — simulating its terminal window
  // being closed / process killed before a Stop hook / agentStop() call
  // could fire. liveAgentId keeps emitting plain "log" events (deliberately
  // NOT tool calls, to prove any event type resets the liveness clock) more
  // often than the stale timeout, so it must never be reaped.
  const keepAliveInterval = setInterval(() => {
    void postEvent(baseUrl, {
      type: "log",
      timestamp: new Date().toISOString(),
      agentId: liveAgentId,
      message: "still working",
    });
  }, Math.floor(STALE_TIMEOUT_MS / 3));

  console.log("== Step 4: wait past the stale timeout and let the sweep run ==");
  await sleep(STALE_TIMEOUT_MS * 3);
  clearInterval(keepAliveInterval);

  console.log("== Step 5: assert a reap broadcast arrived live over the open WebSocket ==");
  assert(snapshots.length > 0, "at least one post-connect snapshot was broadcast (the reap sweep fired)");

  const latestSnapshot = snapshots[snapshots.length - 1];
  const deadAgentLive = latestSnapshot?.agents.find((a) => a.agentId === deadAgentId);
  const liveAgentLive = latestSnapshot?.agents.find((a) => a.agentId === liveAgentId);

  assert(!!deadAgentLive, "the abandoned agent appears in the live-broadcast snapshot");
  assert(
    deadAgentLive?.status === "stopped",
    `the abandoned agent is shown "stopped" over the live WebSocket (got ${deadAgentLive?.status}), not stuck "running"`,
  );
  assert(
    deadAgentLive?.inferred === true,
    `the abandoned agent is marked inferred: true, distinguishing it from a clean agent_stop (got ${deadAgentLive?.inferred})`,
  );
  assert(
    typeof deadAgentLive?.stopMessage === "string" && /no activity/i.test(deadAgentLive.stopMessage),
    `the abandoned agent has an explanatory stopMessage (got ${JSON.stringify(deadAgentLive?.stopMessage)})`,
  );

  assert(!!liveAgentLive, "the actively-emitting agent appears in the snapshot");
  assert(
    liveAgentLive?.status === "running",
    `the actively-emitting agent is still "running" — never falsely reaped (got ${liveAgentLive?.status})`,
  );
  assert(
    liveAgentLive?.inferred !== true,
    "the actively-emitting agent is never marked inferred",
  );

  console.log("== Step 6: reconnect fresh and confirm the reap persisted in server state ==");
  const verifySocket = new WebSocket(wsUrl);
  const finalSnapshot = await new Promise((resolve, reject) => {
    verifySocket.addEventListener("error", reject);
    verifySocket.addEventListener("message", (msg) => {
      const parsed = JSON.parse(msg.data);
      if (parsed.type === "snapshot") resolve(parsed.data);
    });
  });
  verifySocket.close();

  const deadAgentFinal = finalSnapshot.agents.find((a) => a.agentId === deadAgentId);
  assert(
    deadAgentFinal?.status === "stopped" && deadAgentFinal?.inferred === true,
    "a freshly-connecting client also sees the abandoned agent as stopped/inferred (not just the live client)",
  );
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
  console.log("PASS: an agent with no agent_stop is reaped as stopped/inferred after the configured timeout, live over WebSocket, while an actively-emitting agent is never falsely reaped.");
} else {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  exitCode = 1;
}

process.exit(exitCode);
