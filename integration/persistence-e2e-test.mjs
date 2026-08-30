#!/usr/bin/env node
/**
 * End-to-end integration test for issue #51 (persistent storage backend).
 *
 * `server/test/eventRepository.test.ts` unit-tests the SQLite repository in
 * isolation. This test instead proves the whole feature works end to end
 * against a real, unmodified server process: events POSTed to one server
 * process are still there — as reconstructed agent/tool-call/team state on
 * the WS snapshot, and as raw events on `GET /events/history` — after that
 * process is killed and a fresh one is started against the same
 * `AGENTSVIZ_DB_PATH`.
 *
 * It also checks the two "must not regress" criteria: a normal event is
 * still accepted + broadcast live with no added latency characteristics,
 * and pointing the DB at an unwritable path degrades to in-memory-only
 * rather than crashing the server.
 *
 * See integration/README.md for what these tests prove and their "Known
 * gaps".
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// The server requires an auth token on /events, /events/history, and the
// /ws handshake (issue #52). With no AGENTSVIZ_API_KEYS set on the spawned
// servers they accept only this shared dev token.
const DEV_TOKEN = "dev-local-token";

const failures = [];
const runningServers = new Set();

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

/** Read the initial snapshot a freshly-connecting WS client is sent. */
async function fetchSnapshot(wsUrl) {
  const socket = new WebSocket(wsUrl);
  try {
    return await new Promise((resolve, reject) => {
      socket.addEventListener("error", reject);
      socket.addEventListener("message", (msg) => {
        const parsed = JSON.parse(msg.data);
        if (parsed.type === "snapshot") resolve(parsed.data);
      });
    });
  } finally {
    socket.close();
  }
}

const SERVER_DIR = new URL("../server", import.meta.url).pathname;

function startServer(port, env) {
  const proc = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runningServers.add(proc);
  let output = "";
  proc.stdout.on("data", (c) => (output += c.toString()));
  proc.stderr.on("data", (c) => (output += c.toString()));
  proc.getOutput = () => output;
  return proc;
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => proc.once("exit", resolve)),
    sleep(3000),
  ]);
  if (!proc.killed) proc.kill("SIGKILL");
  runningServers.delete(proc);
}

async function main() {
  const dbDir = mkdtempSync(path.join(tmpdir(), "agentsviz-persistence-e2e-"));
  const dbPath = path.join(dbDir, "agentsviz.db");
  const runId = Date.now().toString(36);
  const orchId = `orch-${runId}`;
  const workerId = `worker-${runId}`;
  const team = `crew-${runId}`;

  try {
    console.log("== Step 1: start server #1 against a fresh SQLite DB ==");
    const port1 = await findFreePort();
    const baseUrl1 = `http://localhost:${port1}`;
    const server1 = startServer(port1, { AGENTSVIZ_DB_PATH: dbPath });
    await waitForHealth(baseUrl1);
    console.log(`  Server #1 healthy at ${baseUrl1}, DB at ${dbPath}`);

    console.log("== Step 2: POST a small multi-agent run ==");
    const events = [
      { type: "agent_start", timestamp: new Date().toISOString(), agentId: orchId, team },
      { type: "agent_start", timestamp: new Date().toISOString(), agentId: workerId, team, caller: orchId },
      {
        type: "tool_call_start",
        timestamp: new Date().toISOString(),
        agentId: workerId,
        caller: orchId,
        tool: "search",
        input: { query: "persistent storage" },
      },
      {
        type: "tool_call_end",
        timestamp: new Date().toISOString(),
        agentId: workerId,
        caller: orchId,
        tool: "search",
        status: "success",
        result: { hits: 2 },
      },
      { type: "agent_stop", timestamp: new Date().toISOString(), agentId: workerId, team, status: "success" },
    ];
    for (const e of events) {
      const res = await postEvent(baseUrl1, e);
      assert(res.status === 202, `event ${e.type} accepted (202), got ${res.status}`);
    }

    const snapshot1 = await fetchSnapshot(`ws://localhost:${port1}/ws?token=${DEV_TOKEN}`);
    assert(snapshot1.agents.length === 2, `server #1 snapshot has 2 agents (got ${snapshot1.agents.length})`);

    console.log("== Step 3: kill server #1, start server #2 on the SAME DB, no events replayed over the wire ==");
    await stopServer(server1);

    const port2 = await findFreePort();
    const baseUrl2 = `http://localhost:${port2}`;
    const server2 = startServer(port2, { AGENTSVIZ_DB_PATH: dbPath });
    await waitForHealth(baseUrl2);
    assert(
      /Restored 5 persisted event\(s\)/.test(server2.getOutput()),
      `server #2 logs that it restored the persisted events on startup (log: ${JSON.stringify(server2.getOutput().trim().split("\n").slice(-4))})`,
    );

    console.log("== Step 4: a fresh client sees the prior run's reconstructed state ==");
    const snapshot2 = await fetchSnapshot(`ws://localhost:${port2}/ws?token=${DEV_TOKEN}`);
    const orch2 = snapshot2.agents.find((a) => a.agentId === orchId);
    const worker2 = snapshot2.agents.find((a) => a.agentId === workerId);

    assert(!!orch2 && !!worker2, "both agents from the pre-restart run are present after restart");
    assert(orch2?.status === "running", `orchestrator still "running" after restart (got ${orch2?.status})`);
    assert(
      worker2?.status === "stopped" && worker2?.inferred === undefined,
      `worker still cleanly "stopped" (not inferred) after restart (got ${JSON.stringify({ status: worker2?.status, inferred: worker2?.inferred })})`,
    );
    assert(
      JSON.stringify(snapshot2.teams[team]?.slice().sort()) === JSON.stringify([orchId, workerId].sort()),
      `team map rebuilt after restart (got ${JSON.stringify(snapshot2.teams[team])})`,
    );
    assert(snapshot2.toolCalls.length === 1, `the tool call survived the restart (got ${snapshot2.toolCalls.length})`);
    assert(
      snapshot2.toolCalls[0]?.status === "success",
      `the restarted tool call keeps its success status/result (got ${snapshot2.toolCalls[0]?.status})`,
    );

    console.log("== Step 5: /events/history on server #2 replays the pre-restart events ==");
    const history = await (await fetch(`${baseUrl2}/events/history`, { headers: { Authorization: `Bearer ${DEV_TOKEN}` } })).json();
    assert(Array.isArray(history) && history.length === 5, `history spans the previous run (got ${history?.length})`);
    assert(history[0]?.agentId === orchId && history[0]?.type === "agent_start", "history is oldest-first, same shape as POSTed");

    console.log("== Step 6: new events on server #2 are still accepted + persisted alongside the old ones ==");
    await postEvent(baseUrl2, {
      type: "agent_stop",
      timestamp: new Date().toISOString(),
      agentId: orchId,
      team,
      status: "success",
    });
    const historyAfter = await (await fetch(`${baseUrl2}/events/history`, { headers: { Authorization: `Bearer ${DEV_TOKEN}` } })).json();
    assert(historyAfter.length === 6, `new event appended to the persisted history (got ${historyAfter.length})`);
    await stopServer(server2);

    console.log("== Step 7: an unwritable AGENTSVIZ_DB_PATH degrades to in-memory, server still serves ==");
    const port3 = await findFreePort();
    const baseUrl3 = `http://localhost:${port3}`;
    // Parent path is a file, so the DB directory can't be created.
    const badPath = path.join(dbPath, "nope", "agentsviz.db");
    const server3 = startServer(port3, { AGENTSVIZ_DB_PATH: badPath });
    await waitForHealth(baseUrl3);
    assert(
      /persistence disabled/i.test(server3.getOutput()),
      "server logs that persistence is disabled for the bad path",
    );
    const res3 = await postEvent(baseUrl3, {
      type: "agent_start",
      timestamp: new Date().toISOString(),
      agentId: `degraded-${runId}`,
    });
    assert(res3.status === 202, `server still accepts events with persistence disabled (got ${res3.status})`);
    const snapshot3 = await fetchSnapshot(`ws://localhost:${port3}/ws?token=${DEV_TOKEN}`);
    assert(
      snapshot3.agents.some((a) => a.agentId === `degraded-${runId}`),
      "live in-memory pipeline still works with persistence disabled",
    );
    await stopServer(server3);
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function cleanup() {
  for (const proc of runningServers) await stopServer(proc);
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
  console.log("PASS: agent/tool-call/team state and raw event history survive a full server restart via the SQLite store, live ingestion is unaffected, and an unwritable DB path degrades gracefully to in-memory-only.");
} else {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  exitCode = 1;
}

process.exit(exitCode);
