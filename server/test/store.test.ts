/**
 * Unit tests for StateStore.reapStaleAgents (issue #37).
 *
 * Uses node's built-in test runner (`node:test`) directly against
 * `src/store.ts` via tsx — no separate test framework dependency, in
 * keeping with this repo's minimal-tooling style (see integration/'s
 * plain `.mjs` scripts). `reapStaleAgents` takes `now` as an explicit
 * parameter specifically so these tests can drive it deterministically
 * without real timers or sleeps.
 *
 * Run with `npm test` (see package.json).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { StateStore } from "../src/store.js";
import type { AgentEvent } from "../src/eventSchema.js";

const START = Date.parse("2026-08-24T00:00:00.000Z");
const FIVE_MIN_MS = 5 * 60 * 1000;

function agentStart(agentId: string, timestamp: number): AgentEvent {
  return { type: "agent_start", timestamp: new Date(timestamp).toISOString(), agentId };
}

function logEvent(agentId: string, timestamp: number): AgentEvent {
  return {
    type: "log",
    timestamp: new Date(timestamp).toISOString(),
    agentId,
    message: "still working",
  };
}

test("an agent with no events for >= the timeout is reaped as stopped/inferred", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));

  // Nothing else ever happens for agent-a. Sweep at exactly START + timeout.
  const reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS);

  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].agentId, "agent-a");
  assert.equal(reaped[0].status, "stopped");
  assert.equal(reaped[0].inferred, true);
  assert.equal(reaped[0].stopStatus, "error");
  assert.match(reaped[0].stopMessage ?? "", /no activity for 5 minutes/i);

  const snapshot = store.getSnapshot();
  const stored = snapshot.agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.status, "stopped");
  assert.equal(stored?.inferred, true);
});

test("an agent is never reaped before the timeout elapses", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));

  // One second short of the timeout — still running.
  const reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS - 1000);

  assert.equal(reaped.length, 0);
  const stored = store.getSnapshot().agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.inferred, undefined);
});

test("events of any type (not just tool calls) reset the liveness clock", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));

  // A log event arrives just before the original deadline would hit.
  store.applyEvent(logEvent("agent-a", START + FIVE_MIN_MS - 1000));

  // Sweeping at the original deadline must NOT reap it — the log reset the clock.
  let reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS);
  assert.equal(reaped.length, 0, "log event should have reset the liveness clock");

  // But it IS reaped once timeoutMs has elapsed since that log event.
  reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS - 1000 + FIVE_MIN_MS);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].inferred, true);
});

test("an agent that already stopped cleanly (agent_stop) is never reaped", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));
  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START + 1000).toISOString(),
    agentId: "agent-a",
    status: "success",
  });

  const reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS * 10);

  assert.equal(reaped.length, 0);
  const stored = store.getSnapshot().agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.status, "stopped");
  assert.equal(stored?.inferred, undefined, "a clean agent_stop must never carry inferred");
});

test("a late explicit agent_stop after reaping clears the inferred flag", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));
  store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS);

  let stored = store.getSnapshot().agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.inferred, true);

  // A late agent_stop finally arrives (e.g. a delayed POST retry).
  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START + FIVE_MIN_MS + 1000).toISOString(),
    agentId: "agent-a",
    status: "success",
  });

  stored = store.getSnapshot().agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.status, "stopped");
  assert.equal(stored?.inferred, undefined, "explicit agent_stop should win over the earlier inferred stop");
});

test("a fresh agent_start clears a previous inferred-stopped state for the same agentId", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));
  store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS);

  store.applyEvent(agentStart("agent-a", START + FIVE_MIN_MS + 1000));

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "agent-a");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.inferred, undefined);
});

test("multiple agents: only the truly stale one is reaped", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("agent-a", START));
  store.applyEvent(agentStart("agent-b", START));

  // agent-b stays active via a stream of log events.
  store.applyEvent(logEvent("agent-b", START + FIVE_MIN_MS - 500));

  const reaped = store.reapStaleAgents(FIVE_MIN_MS, START + FIVE_MIN_MS);

  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].agentId, "agent-a");

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.agents.find((a) => a.agentId === "agent-b")?.status, "running");
});
