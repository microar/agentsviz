/**
 * Unit tests for eventLogger.ts's `getLogFilePath` export (issue #43).
 *
 * The `/events/history` route (server/src/index.ts) reads back whatever
 * file `getLogFilePath()` points to, so the two things that matter here
 * are: (1) it resolves to the same path `logEvent` actually writes to, and
 * (2) that path stays stable across repeated calls even though it's only
 * lazily resolved on first use (see `ensureResolvedPath` in eventLogger.ts)
 * — a second, differently-timestamped path would silently break history
 * for a run that hasn't logged anything yet when the route is first hit.
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts. Sets
 * `EVENT_LOG_PATH` to a temp file and imports the module dynamically
 * (after setting the env var) so eventLogger.ts's lazy path resolution
 * picks it up deterministically instead of falling back to the
 * timestamped default.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "agentsviz-eventlogger-"));
const logPath = path.join(dir, "history-test.jsonl");
process.env.EVENT_LOG_PATH = logPath;

const { logEvent, getLogFilePath } = await import("../src/eventLogger.js");

test("getLogFilePath resolves EVENT_LOG_PATH and is stable across calls", () => {
  assert.equal(getLogFilePath(), path.resolve(logPath));
  // Called again (e.g. by a second /events/history request) — must return
  // the exact same path, not re-resolve a fresh timestamped default.
  assert.equal(getLogFilePath(), getLogFilePath());
});

test("logEvent appends JSON lines to the path getLogFilePath reports, readable back for history", async () => {
  assert.equal(existsSync(logPath), false, "file should not exist before the first logEvent call");

  logEvent({ type: "agent_start", agentId: "a1", timestamp: "2026-01-01T00:00:00.000Z" });
  logEvent({
    type: "agent_stop",
    agentId: "a1",
    timestamp: "2026-01-01T00:00:01.000Z",
    status: "success",
  });

  // logEvent is fire-and-forget (writes via a WriteStream callback) — give
  // the event loop a tick so both writes flush before reading the file
  // back, the same way the /events/history route would.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(getLogFilePath(), path.resolve(logPath));
  const raw = readFileSync(getLogFilePath(), "utf8");
  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "agent_start");
  assert.equal(events[1].type, "agent_stop");

  rmSync(dir, { recursive: true, force: true });
});
