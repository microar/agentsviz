#!/usr/bin/env node
/**
 * End-to-end integration test for issue #32.
 *
 * `e2e-test.mjs` proves the `instrumentation/` library -> server ->
 * WebSocket pipeline works end to end, by calling the library's exported
 * functions directly. The `hooks-emitter/` package (#29) is a second,
 * independent producer of the same event schema, but it isn't driven by
 * direct function calls — it's a standalone script that Claude Code's own
 * harness invokes as a child process, feeding it one JSON hook payload on
 * stdin per lifecycle point, with no visibility into (or waiting for) the
 * resulting HTTP response. `hooks-emitter/test/map.test.mjs` already unit
 * tests the pure payload-mapping logic in isolation; this test instead
 * spawns the *compiled* `hooks-emitter` script for real, one child process
 * per hook firing exactly as Claude Code's harness would, against a real
 * running event server, and asserts on the resulting WebSocket broadcast
 * stream and state snapshot.
 *
 * See integration/README.md for what this proves and its "Known gaps".
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "../server");
const HOOKS_EMITTER_ENTRY = path.resolve(__dirname, "../hooks-emitter/dist/index.js");

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

/**
 * Spawns the real, compiled hooks-emitter script as a fresh child process
 * (mirroring exactly how Claude Code's harness invokes a hook: JSON
 * payload on stdin, nothing on argv), and resolves with its exit code,
 * stdout, and stderr once it exits.
 *
 * The script's own contract (#29) is to always exit 0 and never write
 * meaningful stderr, dispatching the actual network POST to a *detached*
 * sender child process it does not wait for. So a clean exit here does
 * NOT by itself prove the server received/accepted the event — callers
 * must separately wait for the event to show up over the live WebSocket
 * (which does prove server-side acceptance, since the server only
 * broadcasts events that passed schema validation) and/or grep the
 * server's own request log for the matching "202" line.
 */
async function runHook(payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOKS_EMITTER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function main() {
  console.log("== Step 1: start the real event server as a child process ==");
  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}/ws`;
  const eventsUrl = `${baseUrl}/events`;

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

  console.log("== Step 3: drive the real hooks-emitter script with synthetic hook payloads ==");
  const runId = Date.now().toString(36);
  const sessionId = `hooks-e2e-session-${runId}`;
  const subAgentId = `sub-${runId}`;
  const expectedAgentId = sessionId;
  const expectedSubAgentId = `${sessionId}-${subAgentId}`;
  // No $AGENTSVIZ_TEAM override for this run -> team is derived from
  // basename(cwd) per map.ts. Use a distinctive, disposable cwd value (it
  // need not exist on disk -- only its basename is read).
  const projectCwd = `/tmp/agentsviz-hooks-e2e-${runId}/team-demo-project`;
  const expectedTeam = "team-demo-project";

  const hookEnv = { AGENTSVIZ_EVENTS_URL: eventsUrl };

  /**
   * Runs one hook payload through the real emitter script, then waits for
   * the resulting event to arrive over the live WebSocket before
   * returning -- this both proves the server accepted it (only
   * schema-valid events get broadcast) and gives the test deterministic
   * ordering without changing the emitter's intentionally fire-and-forget
   * design.
   */
  async function emitHook(description, payload) {
    const before = receivedEvents.length;
    const { code, stderr } = await runHook(payload, hookEnv);
    assert(code === 0, `hooks-emitter exits 0 for ${description} (got ${code})`);
    assert(stderr.trim() === "", `hooks-emitter writes no stderr for ${description}`);
    await waitUntil(
      () => receivedEvents.length > before,
      `event to arrive over WS for: ${description}`,
    );
    return receivedEvents[before];
  }

  // A plausible session: top-level agent starts, calls a regular tool,
  // then delegates via the Task tool to a sub-agent, which itself calls a
  // tool and finishes, then the top-level Task call ends and the session
  // stops. Covers all 4 mapped hook types plus the #30 sub-agent
  // correlation (agent_id present on hooks firing inside the sub-agent).

  const eSessionStart = await emitHook("SessionStart (top-level agent starts)", {
    session_id: sessionId,
    hook_event_name: "SessionStart",
    session_start_reason: "startup",
    cwd: projectCwd,
  });

  const eBashPreStart = await emitHook("PreToolUse Bash (top-level)", {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    cwd: projectCwd,
  });

  const eBashPostEnd = await emitHook("PostToolUse Bash (top-level, success)", {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: { type: "text", content: "file1.txt\nfile2.txt" },
    cwd: projectCwd,
  });

  const eTaskPreStart = await emitHook("PreToolUse Task (top-level, spawns sub-agent)", {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { description: "Explore the codebase", subagent_type: "Explore" },
    cwd: projectCwd,
  });

  const eSubPreStart = await emitHook("PreToolUse Read (inside sub-agent)", {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/repo/README.md" },
    cwd: projectCwd,
    agent_id: subAgentId,
    agent_type: "Explore",
  });

  const eSubPostEnd = await emitHook("PostToolUse Read (inside sub-agent, success)", {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_response: { type: "text", content: "# AgentsViz" },
    cwd: projectCwd,
    agent_id: subAgentId,
    agent_type: "Explore",
  });

  const eSubagentStop = await emitHook("SubagentStop (sub-agent finishes)", {
    session_id: sessionId,
    hook_event_name: "SubagentStop",
    agent_id: subAgentId,
    agent_type: "Explore",
    cwd: projectCwd,
    last_assistant_message: "Explored the codebase.",
  });

  const eTaskPostEnd = await emitHook("PostToolUse Task (top-level, success)", {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_response: { type: "text", content: "Sub-agent completed exploration." },
    cwd: projectCwd,
  });

  const eStop = await emitHook("Stop (top-level session stops)", {
    session_id: sessionId,
    hook_event_name: "Stop",
    last_assistant_message: "Done.",
    cwd: projectCwd,
  });

  console.log("== Step 4: assert each broadcast event was mapped correctly ==");

  assert(eSessionStart.type === "agent_start", `SessionStart -> agent_start (got ${eSessionStart.type})`);
  assert(eSessionStart.agentId === expectedAgentId, "SessionStart event carries the top-level agentId");
  assert(eSessionStart.team === expectedTeam, `SessionStart team derived from basename(cwd) (got ${eSessionStart.team})`);

  assert(eBashPreStart.type === "tool_call_start", "PreToolUse -> tool_call_start");
  assert(eBashPreStart.agentId === expectedAgentId, "top-level PreToolUse keeps the plain session agentId");
  assert(eBashPreStart.caller === expectedAgentId, "top-level PreToolUse caller is a self-reference");
  assert(eBashPreStart.tool === "Bash" && eBashPreStart.input?.command === "ls", "PreToolUse tool/input mapped verbatim");

  assert(eBashPostEnd.type === "tool_call_end", "PostToolUse -> tool_call_end");
  assert(eBashPostEnd.status === "success", "successful tool_response maps to status success");
  assert(eBashPostEnd.result?.content === "file1.txt\nfile2.txt", "tool_call_end result carries the tool_response");

  assert(eTaskPreStart.type === "tool_call_start" && eTaskPreStart.tool === "Task", "Task PreToolUse -> tool_call_start(tool=Task)");
  assert(
    eTaskPreStart.agentId === expectedAgentId && eTaskPreStart.caller === expectedAgentId,
    "Task PreToolUse fires in the PARENT's context (no agent_id yet) -> plain top-level agentId/caller",
  );

  // --- Sub-agent correlation (#30 / PR #34, merged into this branch's base) ---
  assert(eSubPreStart.type === "tool_call_start", "sub-agent PreToolUse -> tool_call_start");
  assert(
    eSubPreStart.agentId === expectedSubAgentId,
    `sub-agent event gets a compound agentId "sess-agentId" (got ${eSubPreStart.agentId}, want ${expectedSubAgentId})`,
  );
  assert(
    eSubPreStart.caller === expectedAgentId,
    `sub-agent event's caller links back to the parent session (got ${eSubPreStart.caller}, want ${expectedAgentId})`,
  );
  assert(eSubPreStart.team === expectedTeam, "sub-agent shares the parent's team (same cwd)");

  assert(eSubPostEnd.type === "tool_call_end" && eSubPostEnd.agentId === expectedSubAgentId, "sub-agent PostToolUse -> tool_call_end with compound agentId");
  assert(eSubPostEnd.status === "success", "sub-agent tool_response maps to status success");

  assert(eSubagentStop.type === "agent_stop", "SubagentStop -> agent_stop");
  assert(eSubagentStop.agentId === expectedSubAgentId, "SubagentStop uses the same compound sub-agent agentId");
  assert(eSubagentStop.status === "success", "SubagentStop maps to status success");
  assert(eSubagentStop.message === "Subagent stopped", "SubagentStop carries the expected message");

  assert(eTaskPostEnd.type === "tool_call_end" && eTaskPostEnd.agentId === expectedAgentId, "Task PostToolUse -> tool_call_end back on the parent agentId");
  assert(eTaskPostEnd.status === "success", "Task tool_response maps to status success");

  assert(eStop.type === "agent_stop" && eStop.agentId === expectedAgentId, "Stop -> agent_stop on the top-level agentId");
  assert(eStop.status === "success" && eStop.message === "Session stopped", "Stop maps to status success with the expected message");

  console.log("== Step 5: assert causal ordering (sub-agent bracketed inside the Task tool call) ==");
  const idxOf = (predicate) => receivedEvents.findIndex(predicate);
  const iTaskStart = idxOf((e) => e === eTaskPreStart);
  const iSubStart = idxOf((e) => e === eSubPreStart);
  const iSubStop = idxOf((e) => e === eSubagentStop);
  const iTaskEnd = idxOf((e) => e === eTaskPostEnd);
  assert(
    iTaskStart !== -1 && iSubStart !== -1 && iSubStop !== -1 && iTaskEnd !== -1 &&
      iTaskStart < iSubStart && iSubStart < iSubStop && iSubStop < iTaskEnd,
    "sub-agent's tool-call/stop lifecycle is fully nested inside the Task tool_call_start/tool_call_end bracket",
  );

  console.log("== Step 6: assert the server's HTTP-level acceptance (202) for every hook-derived POST ==");
  const acceptedCount = (serverOutput.match(/POST \/events 202/g) || []).length;
  assert(
    acceptedCount === 9,
    `server logged 9 "POST /events 202" acceptances, one per hook fired in Step 3 (got ${acceptedCount})`,
  );

  console.log("== Step 7: reconnect and assert the final state snapshot ==");
  const verifySocket = new WebSocket(wsUrl);
  const finalSnapshot = await new Promise((resolve, reject) => {
    verifySocket.addEventListener("error", reject);
    verifySocket.addEventListener("message", (msg) => {
      const parsed = JSON.parse(msg.data);
      if (parsed.type === "snapshot") resolve(parsed.data);
    });
  });
  verifySocket.close();

  const parentState = finalSnapshot.agents.find((a) => a.agentId === expectedAgentId);
  const subState = finalSnapshot.agents.find((a) => a.agentId === expectedSubAgentId);

  assert(!!parentState, "top-level agent appears in the final snapshot");
  assert(parentState?.status === "stopped", `top-level agent final status is "stopped" (got ${parentState?.status})`);
  assert(parentState?.stopStatus === "success", "top-level agent stop status is success");

  assert(!!subState, "sub-agent appears in the final snapshot (via SubagentStop, no separate SessionStart hook exists for sub-agents)");
  assert(subState?.status === "stopped", `sub-agent final status is "stopped" (got ${subState?.status})`);
  assert(subState?.stopStatus === "success", "sub-agent stop status is success");

  const taskCall = finalSnapshot.toolCalls.find((c) => c.agentId === expectedAgentId && c.tool === "Task");
  assert(!!taskCall, "top-level Task tool call is recorded");
  assert(taskCall?.status === "success", `Task tool call status is "success" (got ${taskCall?.status})`);

  const subReadCall = finalSnapshot.toolCalls.find((c) => c.agentId === expectedSubAgentId && c.tool === "Read");
  assert(!!subReadCall, "sub-agent's Read tool call is recorded under its own compound agentId");
  assert(subReadCall?.caller === expectedAgentId, "sub-agent's Read tool call caller links back to the parent agentId");
  assert(subReadCall?.status === "success", `sub-agent Read tool call status is "success" (got ${subReadCall?.status})`);

  assert(
    finalSnapshot.teams[expectedTeam]?.includes(expectedAgentId) &&
      finalSnapshot.teams[expectedTeam]?.includes(expectedSubAgentId),
    `parent and sub-agent are both grouped under team "${expectedTeam}" in the snapshot (basename(cwd) derivation, #30)`,
  );

  console.log("== Step 8: unreachable server -> hooks-emitter still exits 0 with no stderr (#29 acceptance criteria) ==");
  const closedPortEnv = { AGENTSVIZ_EVENTS_URL: "http://127.0.0.1:1/events" }; // port 1: nothing listens, connection refused immediately
  const before = Date.now();
  const unreachableResult = await runHook(
    {
      session_id: `hooks-e2e-unreachable-${runId}`,
      hook_event_name: "SessionStart",
      session_start_reason: "startup",
    },
    closedPortEnv,
  );
  const elapsedMs = Date.now() - before;
  assert(unreachableResult.code === 0, `hooks-emitter exits 0 against an unreachable server (got ${unreachableResult.code})`);
  assert(unreachableResult.stdout.trim() === "", "hooks-emitter writes no stdout against an unreachable server");
  assert(unreachableResult.stderr.trim() === "", "hooks-emitter writes no stderr against an unreachable server");
  assert(
    elapsedMs < 3000,
    `hooks-emitter's own process exits promptly without waiting on the (detached) network POST (took ${elapsedMs}ms)`,
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
  console.log("PASS: hooks-emitter drives the real server correctly, matching /docs/event-schema.md.");
} else {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  exitCode = 1;
}

process.exit(exitCode);
