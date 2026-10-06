/**
 * Unit tests for the pure aggregation in src/metrics.ts (issue #56):
 * percentile math, per-tool error rate, and agent outcome buckets
 * (success / error / running / inferred-stale).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics, computeMetricsFromEvents, percentile } from "../src/metrics.js";
import type { AgentEvent } from "../src/eventSchema.js";

const T0 = Date.parse("2026-08-24T00:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function start(agentId: string, at: number, team?: string): AgentEvent {
  return { type: "agent_start", timestamp: iso(at), agentId, team };
}
function stop(agentId: string, at: number, status: "success" | "error"): AgentEvent {
  return { type: "agent_stop", timestamp: iso(at), agentId, status };
}
function toolStart(agentId: string, tool: string, at: number): AgentEvent {
  return { type: "tool_call_start", timestamp: iso(at), agentId, caller: agentId, tool, input: {} };
}
function toolEnd(agentId: string, tool: string, at: number, status: "success" | "error"): AgentEvent {
  return { type: "tool_call_end", timestamp: iso(at), agentId, caller: agentId, tool, status };
}
/** A complete call of `tool` lasting `ms`. */
function call(agentId: string, tool: string, at: number, ms: number, status: "success" | "error" = "success"): AgentEvent[] {
  return [toolStart(agentId, tool, at), toolEnd(agentId, tool, at + ms, status)];
}

test("percentile uses nearest-rank on sorted samples", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 95), 10);
  assert.equal(percentile(ten, 99), 10);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 99), 99);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("latency percentiles are computed per tool from endedAt - startedAt", () => {
  const events: AgentEvent[] = [start("a", 0)];
  // 20 calls of "search" with durations 100, 200, ... 2000ms.
  for (let i = 1; i <= 20; i++) events.push(...call("a", "search", i * 10_000, i * 100));
  events.push(...call("a", "read", 500_000, 7));
  const m = computeMetricsFromEvents(events);

  const search = m.byTool.find((t) => t.tool === "search")!;
  assert.equal(search.latencySamples, 20);
  assert.deepEqual(search.latencyMs, { p50: 1000, p95: 1900, p99: 2000 });
  const read = m.byTool.find((t) => t.tool === "read")!;
  assert.deepEqual(read.latencyMs, { p50: 7, p95: 7, p99: 7 });
  assert.equal(m.toolCalls.latencySamples, 21);
});

test("tool calls with no end event are excluded from latency but counted as calls", () => {
  const events: AgentEvent[] = [
    start("a", 0),
    ...call("a", "search", 1_000, 100),
    toolStart("a", "search", 5_000), // never ends
  ];
  const m = computeMetricsFromEvents(events);
  const search = m.byTool[0];
  assert.equal(search.calls, 2);
  assert.equal(search.completed, 1);
  assert.equal(search.latencySamples, 1);
  assert.deepEqual(search.latencyMs, { p50: 100, p95: 100, p99: 100 });
  // Only pending calls -> no percentiles at all, and a 0 (not NaN) error rate.
  const pendingOnly = computeMetricsFromEvents([start("b", 0), toolStart("b", "slow", 10)]);
  assert.equal(pendingOnly.byTool[0].latencyMs, null);
  assert.equal(pendingOnly.byTool[0].errorRate, 0);
  assert.equal(pendingOnly.toolCalls.latencyMs, null);
});

test("error rate per tool is errors / completed calls, making a flaky tool stand out", () => {
  const events: AgentEvent[] = [start("a", 0)];
  for (let i = 0; i < 4; i++) events.push(...call("a", "flaky", 10_000 * (i + 1), 50, i < 3 ? "error" : "success"));
  for (let i = 0; i < 4; i++) events.push(...call("a", "solid", 100_000 + 10_000 * i, 50, "success"));
  events.push(toolStart("a", "flaky", 900_000)); // pending: not in the rate
  const m = computeMetricsFromEvents(events);

  const flaky = m.byTool.find((t) => t.tool === "flaky")!;
  assert.equal(flaky.calls, 5);
  assert.equal(flaky.completed, 4);
  assert.equal(flaky.errors, 3);
  assert.equal(flaky.errorRate, 0.75);
  assert.equal(m.byTool.find((t) => t.tool === "solid")!.errorRate, 0);
  assert.equal(m.toolCalls.errors, 3);
  assert.equal(m.toolCalls.completed, 8);
  assert.equal(m.toolCalls.errorRate, 3 / 8);
});

test("agent outcome buckets: success, error, running and inferred (stale) are exclusive", () => {
  const events: AgentEvent[] = [
    start("ok", 0),
    stop("ok", 1_000, "success"),
    start("bad", 0),
    stop("bad", 1_000, "error"),
    start("live", 9 * 60_000),
    start("ghost", 0), // silent for > timeout
  ];
  const timeout = 5 * 60_000;
  const now = T0 + 10 * 60_000;
  const m = computeMetricsFromEvents(events, { staleTimeoutMs: timeout, now });

  assert.equal(m.agents.total, 4);
  assert.deepEqual(m.agents.counts, { running: 1, success: 1, error: 1, inferred: 1 });
  assert.deepEqual(m.agents.rates, { running: 0.25, success: 0.25, error: 0.25, inferred: 0.25 });
  const outcome = (id: string) => m.byAgent.find((a) => a.agentId === id)!.outcome;
  assert.equal(outcome("ok"), "success");
  assert.equal(outcome("bad"), "error");
  assert.equal(outcome("live"), "running");
  assert.equal(outcome("ghost"), "inferred");

  // Without a stale sweep the silent agent is still just running.
  const noSweep = computeMetricsFromEvents(events);
  assert.equal(noSweep.agents.counts.inferred, 0);
  assert.equal(noSweep.agents.counts.running, 2);
});

test("per-agent tool error rate and an empty history", () => {
  const events: AgentEvent[] = [
    start("a", 0, "t1"),
    start("b", 0),
    ...call("a", "x", 1_000, 10, "error"),
    ...call("a", "x", 2_000, 10, "success"),
    ...call("b", "x", 3_000, 10, "success"),
  ];
  const m = computeMetricsFromEvents(events);
  const a = m.byAgent.find((r) => r.agentId === "a")!;
  assert.equal(a.team, "t1");
  assert.equal(a.toolCalls, 2);
  assert.equal(a.toolErrors, 1);
  assert.equal(a.toolErrorRate, 0.5);
  assert.equal(m.byAgent.find((r) => r.agentId === "b")!.toolErrorRate, 0);

  const empty = computeMetrics({ agents: [], toolCalls: [] });
  assert.equal(empty.agents.total, 0);
  assert.deepEqual(empty.agents.rates, { running: 0, success: 0, error: 0, inferred: 0 });
  assert.deepEqual(empty.byTool, []);
  assert.equal(empty.toolCalls.latencyMs, null);
});
