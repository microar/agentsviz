/**
 * Unit tests for StateStore.reapStaleAgents (issue #37) and for carrying
 * `caller` onto agent records from tool-call / agent_stop events (#69).
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

// --- caller carried onto agent records (#69) ----------------------------
//
// A Claude Code sub-agent never emits `agent_start` (no SessionStart hook
// fires for one). Its only events are `tool_call_start`/`_end` (which carry
// `caller` = parent) and a final `agent_stop` (mapped from SubagentStop,
// which carries `caller` post-#69). The store must fold that `caller` onto
// the agent record so it reaches `getSnapshot()` — otherwise a reloaded /
// late-opened dashboard sees the sub-agent as top-level and drops it after
// the Graph grace window (#67/#68 regression).

function toolCallStart(
  agentId: string,
  caller: string,
  timestamp: number,
): AgentEvent {
  return {
    type: "tool_call_start",
    timestamp: new Date(timestamp).toISOString(),
    agentId,
    caller,
    tool: "Read",
    input: { file: "x.ts" },
  };
}

test("tool_call_start then agent_stop for an agent with no agent_start: snapshot record carries caller", () => {
  const store = new StateStore();

  // No agent_start is ever seen for the sub-agent, exactly like Claude Code.
  store.applyEvent(toolCallStart("parent-1-sub-1", "parent-1", START));
  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START + 5000).toISOString(),
    agentId: "parent-1-sub-1",
    status: "success",
  });

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "parent-1-sub-1");
  assert.equal(stored?.status, "stopped");
  assert.equal(stored?.caller, "parent-1", "sub-agent snapshot record must point back at the parent");
});

test("agent_stop's own caller is used as a fallback when no earlier event supplied one", () => {
  const store = new StateStore();

  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START).toISOString(),
    agentId: "parent-1-sub-2",
    caller: "parent-1",
    status: "success",
  });

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "parent-1-sub-2");
  assert.equal(stored?.caller, "parent-1");
});

test("a tool call also makes the sub-agent visible (running) before its agent_stop arrives", () => {
  const store = new StateStore();
  store.applyEvent(toolCallStart("parent-1-sub-3", "parent-1", START));

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "parent-1-sub-3");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.caller, "parent-1");
});

test("a top-level agent's self-referential caller is not recorded on its record", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("top-1", START));
  // Top-level tool calls carry caller === agentId (a self-reference).
  store.applyEvent(toolCallStart("top-1", "top-1", START + 1000));
  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START + 2000).toISOString(),
    agentId: "top-1",
    caller: "top-1",
    status: "success",
  });

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "top-1");
  assert.equal(stored?.caller, undefined, "a self-reference must not make an agent look like its own sub-agent");
});

test("an existing caller is never overwritten by a later tool call", () => {
  const store = new StateStore();
  store.applyEvent({
    type: "agent_start",
    timestamp: new Date(START).toISOString(),
    agentId: "sub-x",
    caller: "parent-a",
  });
  // A later tool call reports a different caller — the first one wins.
  store.applyEvent(toolCallStart("sub-x", "parent-b", START + 1000));

  const stored = store.getSnapshot().agents.find((a) => a.agentId === "sub-x");
  assert.equal(stored?.caller, "parent-a");
});

// ---------------------------------------------------------------------------
// Token/cost aggregation (#55)
// ---------------------------------------------------------------------------

function toolCallEndWithCost(
  agentId: string,
  timestamp: number,
  cost: { tokensIn?: number; tokensOut?: number; costUsd?: number },
  team?: string,
): AgentEvent {
  return {
    type: "tool_call_end",
    timestamp: new Date(timestamp).toISOString(),
    agentId,
    tool: "search",
    status: "success",
    ...(team ? { team } : {}),
    ...cost,
  };
}

test("spend starts at zero with empty breakdowns", () => {
  const { spend } = new StateStore().getSnapshot();
  assert.deepEqual(spend, { byAgent: {}, byTeam: {}, total: { tokensIn: 0, tokensOut: 0, costUsd: 0 } });
});

test("tool_call_end and agent_stop costs aggregate per agent, per team, and in total", () => {
  const store = new StateStore();
  store.applyEvent({ type: "agent_start", timestamp: new Date(START).toISOString(), agentId: "a", team: "red" });
  store.applyEvent(toolCallEndWithCost("a", START + 1000, { tokensIn: 100, tokensOut: 50, costUsd: 0.01 }));
  store.applyEvent(toolCallEndWithCost("a", START + 2000, { tokensIn: 10, costUsd: 0.002 }));
  store.applyEvent({
    type: "agent_stop",
    timestamp: new Date(START + 3000).toISOString(),
    agentId: "a",
    status: "success",
    tokensIn: 5,
    tokensOut: 5,
    costUsd: 0.5,
  });

  const { spend } = store.getSnapshot();
  assert.equal(spend.byAgent.a.tokensIn, 115);
  assert.equal(spend.byAgent.a.tokensOut, 55);
  assert.ok(Math.abs(spend.byAgent.a.costUsd - 0.512) < 1e-9);
  assert.deepEqual(spend.byTeam.red, spend.byAgent.a, "team resolved from the agent record");
  assert.deepEqual(spend.total, spend.byAgent.a);
});

test("events without cost fields leave spend untouched", () => {
  const store = new StateStore();
  store.applyEvent(agentStart("a", START));
  store.applyEvent(logEvent("a", START + 1000));
  store.applyEvent({
    type: "tool_call_end",
    timestamp: new Date(START + 2000).toISOString(),
    agentId: "a",
    tool: "search",
    status: "success",
  });
  store.applyEvent({ type: "agent_stop", timestamp: new Date(START + 3000).toISOString(), agentId: "a", status: "success" });

  const { spend } = store.getSnapshot();
  assert.deepEqual(spend.byAgent, {});
  assert.deepEqual(spend.byTeam, {});
  assert.deepEqual(spend.total, { tokensIn: 0, tokensOut: 0, costUsd: 0 });
});

test("spend is kept separate per team; agents without a team only count toward byAgent/total", () => {
  const store = new StateStore();
  store.applyEvent(toolCallEndWithCost("a1", START, { costUsd: 1 }, "red"));
  store.applyEvent(toolCallEndWithCost("a2", START + 1, { costUsd: 2 }, "red"));
  store.applyEvent(toolCallEndWithCost("b1", START + 2, { costUsd: 4 }, "blue"));
  store.applyEvent(toolCallEndWithCost("solo", START + 3, { costUsd: 8 }));

  const { spend } = store.getSnapshot();
  assert.equal(spend.byTeam.red.costUsd, 3);
  assert.equal(spend.byTeam.blue.costUsd, 4);
  assert.deepEqual(Object.keys(spend.byTeam).sort(), ["blue", "red"]);
  assert.equal(spend.byAgent.solo.costUsd, 8);
  assert.equal(spend.total.costUsd, 15);
});

test("replaying the same events into a fresh store yields identical spend", () => {
  const events: AgentEvent[] = [
    { type: "agent_start", timestamp: new Date(START).toISOString(), agentId: "a", team: "red" },
    toolCallEndWithCost("a", START + 1000, { tokensIn: 7, tokensOut: 3, costUsd: 0.25 }),
    toolCallEndWithCost("b", START + 2000, { tokensOut: 11 }, "blue"),
    {
      type: "agent_stop",
      timestamp: new Date(START + 3000).toISOString(),
      agentId: "a",
      status: "error",
      costUsd: 0.75,
    },
  ];
  const first = new StateStore();
  const second = new StateStore();
  for (const e of events) first.applyEvent(e);
  for (const e of events) second.applyEvent(e);
  assert.deepEqual(second.getSnapshot().spend, first.getSnapshot().spend);
  assert.equal(first.getSnapshot().spend.total.costUsd, 1);
});
