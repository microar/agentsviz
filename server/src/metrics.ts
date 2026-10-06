/**
 * Aggregate metrics over the recorded run (issue #56): agent outcome
 * buckets, per-agent and per-tool error rates, and tool-call latency
 * percentiles.
 *
 * Pure: `computeMetrics` takes the agent/tool-call state a `StateStore`
 * already derives from the event stream (`StateStore.getSnapshot()`) and
 * summarizes it — no I/O, no clock — so it is trivially unit-testable.
 * `computeMetricsFromEvents` is the same thing for a raw event list (e.g.
 * `GET /events/history`'s payload): it folds the events through a fresh
 * `StateStore` first, so start/end correlation and the `inferred` marking
 * have exactly one implementation.
 *
 * Definitions:
 *  - Agent outcome buckets are mutually exclusive: `running`, `inferred`
 *    (reaped by the liveness sweep, #37 — never counted as an explicit
 *    error even though the store records `stopStatus: "error"` for it),
 *    `success`, `error`. Rates are shares of all agents.
 *  - A tool call is "completed" once it has an end event. Error rate is
 *    errors / completed; still-pending calls are counted in `calls` but
 *    not in the rate.
 *  - Latency is `endedAt - startedAt` of completed calls only. Calls with
 *    no end event never contribute, and neither do calls whose timestamps
 *    don't parse or run backwards. Caveat: a `tool_call_end` whose start
 *    was never observed is stored with `startedAt === endedAt` (see
 *    StateStore.applyToolCallEnd), so it counts as a 0ms sample.
 *  - Percentiles use the nearest-rank method (the smallest sample with at
 *    least p% of samples at or below it), so they are always real
 *    observed durations, never interpolated values.
 */

import type { AgentEvent } from "./eventSchema.js";
import { StateStore, type AgentState, type StateSnapshot, type ToolCallState } from "./store.js";

export type AgentOutcome = "running" | "success" | "error" | "inferred";

export interface AgentOutcomeCounts {
  running: number;
  success: number;
  error: number;
  inferred: number;
}

export interface AgentOutcomeSummary {
  total: number;
  counts: AgentOutcomeCounts;
  /** Share of all agents per bucket, 0..1 (all 0 when there are no agents). */
  rates: AgentOutcomeCounts;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface ToolMetrics {
  tool: string;
  /** All calls seen, including still-pending ones. */
  calls: number;
  /** Calls with an end event (success + error). */
  completed: number;
  errors: number;
  /** errors / completed, 0..1; 0 when nothing has completed. */
  errorRate: number;
  /** Number of calls that contributed to the latency percentiles. */
  latencySamples: number;
  /** Milliseconds; null when no call has a measurable duration. */
  latencyMs: LatencyPercentiles | null;
}

export interface AgentMetrics {
  agentId: string;
  team?: string;
  outcome: AgentOutcome;
  toolCalls: number;
  completedToolCalls: number;
  toolErrors: number;
  /** toolErrors / completedToolCalls, 0..1; 0 when nothing has completed. */
  toolErrorRate: number;
}

export interface ToolCallTotals {
  calls: number;
  completed: number;
  errors: number;
  errorRate: number;
  latencySamples: number;
  latencyMs: LatencyPercentiles | null;
}

export interface MetricsSummary {
  agents: AgentOutcomeSummary;
  toolCalls: ToolCallTotals;
  byTool: ToolMetrics[];
  byAgent: AgentMetrics[];
}

/** Nearest-rank percentile of an ascending-sorted array; `p` in (0, 100]. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function latencyPercentiles(durations: number[]): LatencyPercentiles | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

/** `endedAt - startedAt` in ms, or undefined for pending / unmeasurable calls. */
function callDurationMs(call: ToolCallState): number | undefined {
  if (!call.endedAt) return undefined;
  const ms = Date.parse(call.endedAt) - Date.parse(call.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function agentOutcome(agent: AgentState): AgentOutcome {
  if (agent.status === "running") return "running";
  if (agent.inferred) return "inferred";
  return agent.stopStatus === "error" ? "error" : "success";
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

interface ToolAccumulator {
  calls: number;
  completed: number;
  errors: number;
  durations: number[];
}

function newAccumulator(): ToolAccumulator {
  return { calls: 0, completed: 0, errors: 0, durations: [] };
}

function accumulate(acc: ToolAccumulator, call: ToolCallState): void {
  acc.calls += 1;
  if (call.status === "pending") return;
  acc.completed += 1;
  if (call.status === "error") acc.errors += 1;
  const ms = callDurationMs(call);
  if (ms !== undefined) acc.durations.push(ms);
}

export function computeMetrics(snapshot: Pick<StateSnapshot, "agents" | "toolCalls">): MetricsSummary {
  const counts: AgentOutcomeCounts = { running: 0, success: 0, error: 0, inferred: 0 };
  const outcomeById = new Map<string, AgentOutcome>();
  for (const agent of snapshot.agents) {
    const outcome = agentOutcome(agent);
    counts[outcome] += 1;
    outcomeById.set(agent.agentId, outcome);
  }
  const totalAgents = snapshot.agents.length;

  const overall = newAccumulator();
  const perTool = new Map<string, ToolAccumulator>();
  const perAgent = new Map<string, ToolAccumulator>();
  for (const call of snapshot.toolCalls) {
    accumulate(overall, call);
    if (!perTool.has(call.tool)) perTool.set(call.tool, newAccumulator());
    accumulate(perTool.get(call.tool)!, call);
    if (!perAgent.has(call.agentId)) perAgent.set(call.agentId, newAccumulator());
    accumulate(perAgent.get(call.agentId)!, call);
  }

  const byTool: ToolMetrics[] = [...perTool.entries()]
    .map(([tool, a]) => ({
      tool,
      calls: a.calls,
      completed: a.completed,
      errors: a.errors,
      errorRate: ratio(a.errors, a.completed),
      latencySamples: a.durations.length,
      latencyMs: latencyPercentiles(a.durations),
    }))
    .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));

  const byAgent: AgentMetrics[] = snapshot.agents
    .map((agent) => {
      const a = perAgent.get(agent.agentId) ?? newAccumulator();
      return {
        agentId: agent.agentId,
        team: agent.team,
        outcome: outcomeById.get(agent.agentId)!,
        toolCalls: a.calls,
        completedToolCalls: a.completed,
        toolErrors: a.errors,
        toolErrorRate: ratio(a.errors, a.completed),
      };
    })
    .sort((x, y) => x.agentId.localeCompare(y.agentId));

  return {
    agents: {
      total: totalAgents,
      counts,
      rates: {
        running: ratio(counts.running, totalAgents),
        success: ratio(counts.success, totalAgents),
        error: ratio(counts.error, totalAgents),
        inferred: ratio(counts.inferred, totalAgents),
      },
    },
    toolCalls: {
      calls: overall.calls,
      completed: overall.completed,
      errors: overall.errors,
      errorRate: ratio(overall.errors, overall.completed),
      latencySamples: overall.durations.length,
      latencyMs: latencyPercentiles(overall.durations),
    },
    byTool,
    byAgent,
  };
}

/**
 * Metrics from a raw, oldest-first event list. When `staleTimeoutMs` is
 * given, agents silent for that long as of `now` are reaped (marked
 * `inferred`) exactly as the live server's liveness sweep would.
 */
export function computeMetricsFromEvents(
  events: readonly AgentEvent[],
  options: { staleTimeoutMs?: number; now?: number } = {},
): MetricsSummary {
  const store = new StateStore();
  for (const event of events) store.applyEvent(event);
  if (options.staleTimeoutMs !== undefined) {
    store.reapStaleAgents(options.staleTimeoutMs, options.now);
  }
  return computeMetrics(store.getSnapshot());
}
