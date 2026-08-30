/**
 * Route-level tests for POST /events: body-parser error handling (issue
 * #46) and token auth (issue #52).
 *
 * `body-parser`'s default JSON limit is 100kb, and prior to this fix an
 * oversized body threw an unhandled `PayloadTooLargeError` that fell through
 * to Express's default error handler — a raw stack trace to the console
 * instead of the clean `{ error, details }` JSON shape the rest of this
 * route uses (see the malformed-JSON case, `entity.parse.failed`, already
 * handled in server/src/index.ts).
 *
 * There's no existing HTTP-route test file to extend (store.test.ts and
 * eventLogger.test.ts only cover internals), so this starts the real
 * Express app as a child process — same approach as
 * integration/hooks-emitter-e2e-test.mjs — and posts against it directly,
 * the only way to exercise body-parser's own request-entity-too-large path
 * (unlike entity.parse.failed, it can't be triggered by calling a route
 * handler function directly with a hand-built request).
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const TSX_BIN = path.resolve(SERVER_DIR, "node_modules/.bin/tsx");

let serverProcess: ChildProcessWithoutNullStreams;
let baseUrl: string;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`Server never became healthy at ${url}/health: ${lastErr}`);
}

const validEvent = {
  type: "agent_start",
  agentId: "a1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

// No AGENTSVIZ_API_KEYS is set for the spawned server, so it accepts only
// the built-in dev token (see src/auth.ts).
const DEV_TOKEN = "dev-local-token";
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

before(async () => {
  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;
  // A 200kb limit (well under the 5mb production default) keeps this test
  // fast: it only needs to send a body a bit over the configured limit, not
  // multiple megabytes.
  serverProcess = spawn(TSX_BIN, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), JSON_BODY_LIMIT: "200kb" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(baseUrl);
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      sleep(3000),
    ]);
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
  }
});

test("a body over the configured limit gets a clean 413 JSON error, not a raw stack trace", async () => {
  const oversizedResult = "x".repeat(300 * 1024); // 300kb of payload, over the 200kb test limit
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      type: "tool_call_end",
      agentId: "a1",
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "c1",
      status: "success",
      result: oversizedResult,
    }),
  });

  assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, "Payload too large");
  assert.ok(Array.isArray(body.details), "details should be an array");
});

test("a malformed-JSON body (with a valid token) still gets the existing clean 400", async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: authHeaders,
    body: "{not valid json",
  });

  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, "Invalid event");
});

test("a normal, under-limit valid event (with a valid token) is still accepted (202)", async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(validEvent),
  });

  assert.equal(res.status, 202, `expected 202, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.status, "accepted");
});

test("POST /events with no token gets a clean 401, not a 202 (issue #52)", async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validEvent),
  });

  assert.equal(res.status, 401, `expected 401, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, "Unauthorized");
  assert.ok(Array.isArray(body.details), "details should be an array");
});

test("POST /events with an unknown token gets a clean 401 (issue #52)", async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer nope-not-valid" },
    body: JSON.stringify(validEvent),
  });

  assert.equal(res.status, 401, `expected 401, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, "Unauthorized");
});

test("GET /events/history requires a token too (issue #52)", async () => {
  const unauthed = await fetch(`${baseUrl}/events/history`);
  assert.equal(unauthed.status, 401, `expected 401 without a token, got ${unauthed.status}`);

  const authed = await fetch(`${baseUrl}/events/history`, {
    headers: { Authorization: `Bearer ${DEV_TOKEN}` },
  });
  assert.equal(authed.status, 200, `expected 200 with a valid token, got ${authed.status}`);
  const body = await authed.json();
  assert.ok(Array.isArray(body), "history body should be a JSON array");
});
