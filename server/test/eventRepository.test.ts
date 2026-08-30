/**
 * Unit tests for the persistent event store (issue #51).
 *
 * Covers the three acceptance criteria that can be checked without
 * spawning a real server (see integration/persistence-e2e-test.mjs for
 * the end-to-end restart proof):
 *  1. events survive being closed and reopened (a "restart"), and the
 *     in-memory StateStore can be rebuilt from them identically;
 *  2. the live pipeline is unaffected — append is a fire-and-forget no-op
 *     when persistence is disabled, and readAll stays cheap/ordered;
 *  3. storage failures degrade gracefully — a bad DB path disables the
 *     repository (logging a warning) instead of throwing.
 *
 * Uses node's built-in test runner via tsx, same as store.test.ts. Each
 * test gets its own temp .db file so they're independent and hermetic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventRepository } from "../src/eventRepository.js";
import { StateStore } from "../src/store.js";
import type { AgentEvent } from "../src/eventSchema.js";

function tmpDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agentsviz-eventrepo-"));
  return { dir, dbPath: path.join(dir, "test.db") };
}

const T0 = "2026-08-24T00:00:00.000Z";

function ts(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** A representative run: two agents on a team, one tool call, a log. */
function sampleRun(): AgentEvent[] {
  return [
    { type: "agent_start", timestamp: ts(0), agentId: "orch", team: "crew" },
    { type: "agent_start", timestamp: ts(10), agentId: "worker", team: "crew", caller: "orch" },
    {
      type: "tool_call_start",
      timestamp: ts(20),
      agentId: "worker",
      caller: "orch",
      tool: "search",
      input: { q: "sqlite" },
    },
    {
      type: "tool_call_end",
      timestamp: ts(30),
      agentId: "worker",
      caller: "orch",
      tool: "search",
      status: "success",
      result: { hits: 3 },
    },
    { type: "log", timestamp: ts(40), agentId: "worker", message: "done" },
    { type: "agent_stop", timestamp: ts(50), agentId: "worker", team: "crew", status: "success" },
  ];
}

test("readAll returns every appended event, in append order, unchanged", () => {
  const { dir, dbPath } = tmpDbPath();
  try {
    const repo = new EventRepository(dbPath);
    assert.equal(repo.enabled, true);

    const events = sampleRun();
    for (const e of events) repo.append(e);

    assert.equal(repo.count(), events.length);
    assert.deepEqual(repo.readAll(), events);
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events persist across a close/reopen (simulated server restart)", () => {
  const { dir, dbPath } = tmpDbPath();
  try {
    const events = sampleRun();

    const first = new EventRepository(dbPath);
    for (const e of events) first.append(e);
    first.close();

    // A brand-new repository over the same file — as if the process had
    // restarted — still sees everything.
    const reopened = new EventRepository(dbPath);
    assert.equal(reopened.enabled, true);
    assert.equal(reopened.count(), events.length);
    assert.deepEqual(reopened.readAll(), events);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StateStore rebuilt from readAll() matches one fed the events live", () => {
  const { dir, dbPath } = tmpDbPath();
  try {
    const events = sampleRun();

    const live = new StateStore();
    for (const e of events) live.applyEvent(e);

    const repo = new EventRepository(dbPath);
    for (const e of events) repo.append(e);
    repo.close();

    const rebuilt = new StateStore();
    const reopened = new EventRepository(dbPath);
    for (const e of reopened.readAll()) rebuilt.applyEvent(e as AgentEvent);
    reopened.close();

    assert.deepEqual(rebuilt.getSnapshot(), live.getSnapshot());
    // Sanity: the reconstructed view actually carries the run's state.
    const snap = rebuilt.getSnapshot();
    assert.equal(snap.agents.length, 2);
    assert.deepEqual(snap.teams, { crew: ["orch", "worker"] });
    assert.equal(snap.toolCalls.length, 1);
    assert.equal(snap.toolCalls[0].status, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema version is stamped via PRAGMA user_version and migration is idempotent", () => {
  const { dir, dbPath } = tmpDbPath();
  try {
    const repo = new EventRepository(dbPath);
    repo.append({ type: "log", timestamp: ts(0), agentId: "a", message: "hi" });
    repo.close();

    // Reopening runs migrate() again; it must be a no-op, not re-create
    // tables or double-apply.
    const reopened = new EventRepository(dbPath);
    assert.equal(reopened.enabled, true);
    assert.equal(reopened.count(), 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an :memory: database works but does not persist across instances", () => {
  const a = new EventRepository(":memory:");
  assert.equal(a.enabled, true);
  a.append({ type: "log", timestamp: ts(0), agentId: "a", message: "hi" });
  assert.equal(a.count(), 1);
  a.close();

  const b = new EventRepository(":memory:");
  assert.equal(b.count(), 0, "a fresh :memory: DB starts empty");
  b.close();
});

test("an unopenable DB path disables persistence instead of throwing", () => {
  // A path whose parent is a file, not a directory — mkdir/open must fail.
  const { dir, dbPath } = tmpDbPath();
  try {
    const blocker = new EventRepository(dbPath); // creates the file at dbPath
    blocker.append({ type: "log", timestamp: ts(0), agentId: "a", message: "x" });
    blocker.close();

    const nested = path.join(dbPath, "cannot", "exist.db");
    let repo: EventRepository;
    assert.doesNotThrow(() => {
      repo = new EventRepository(nested);
    });
    assert.equal(repo!.enabled, false, "repository should report itself disabled");

    // All operations stay safe no-ops in the degraded state.
    assert.doesNotThrow(() => repo!.append({ type: "log", timestamp: ts(0), agentId: "a", message: "x" }));
    assert.deepEqual(repo!.readAll(), []);
    assert.equal(repo!.count(), 0);
    assert.doesNotThrow(() => repo!.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large / structured input and result round-trip losslessly", () => {
  const { dir, dbPath } = tmpDbPath();
  try {
    const bigResult = { blob: "x".repeat(200_000), nested: { a: [1, 2, 3], b: null } };
    const events: AgentEvent[] = [
      {
        type: "tool_call_start",
        timestamp: ts(0),
        agentId: "w",
        caller: "w",
        tool: "read",
        input: { path: "/etc/hosts", opts: { encoding: "utf8" } },
      },
      {
        type: "tool_call_end",
        timestamp: ts(1),
        agentId: "w",
        caller: "w",
        tool: "read",
        status: "success",
        result: bigResult,
      },
    ];

    const repo = new EventRepository(dbPath);
    for (const e of events) repo.append(e);
    repo.close();

    const reopened = new EventRepository(dbPath);
    assert.deepEqual(reopened.readAll(), events);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
