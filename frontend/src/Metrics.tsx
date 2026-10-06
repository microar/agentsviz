/**
 * Metrics view (issue #56): success/error rates and tool latency.
 *
 * Unlike the Graph/Logs/Teams/Spend tabs this doesn't read the live event
 * store: the numbers are pre-aggregated by the server
 * (`GET /metrics/summary`, see server/src/metrics.ts) so the browser never
 * has to fold the whole history itself. Fetched on mount, re-fetched on a
 * timer and via the Refresh button.
 *
 * Deliberately simple for v1: stat tiles, one stacked outcome bar, and
 * tables whose error-rate column carries an inline bar. Every bar sits
 * next to its exact number, so nothing relies on colour alone.
 */

import { useCallback, useEffect, useState } from 'react'
import { viewerToken } from './ws'

type AgentOutcome = 'running' | 'success' | 'error' | 'inferred'

interface OutcomeCounts {
  running: number
  success: number
  error: number
  inferred: number
}

interface LatencyPercentiles {
  p50: number
  p95: number
  p99: number
}

/** Mirrors `MetricsSummary` in server/src/metrics.ts. */
interface MetricsSummary {
  agents: { total: number; counts: OutcomeCounts; rates: OutcomeCounts }
  toolCalls: {
    calls: number
    completed: number
    errors: number
    errorRate: number
    latencySamples: number
    latencyMs: LatencyPercentiles | null
  }
  byTool: {
    tool: string
    calls: number
    completed: number
    errors: number
    errorRate: number
    latencySamples: number
    latencyMs: LatencyPercentiles | null
  }[]
  byAgent: {
    agentId: string
    team?: string
    outcome: AgentOutcome
    toolCalls: number
    completedToolCalls: number
    toolErrors: number
    toolErrorRate: number
  }[]
}

const REFRESH_MS = 15_000
/** A tool/agent at or above this error rate is flagged as flaky. */
const FLAKY_ERROR_RATE = 0.2

const OUTCOMES: { id: AgentOutcome; label: string }[] = [
  { id: 'success', label: 'Success' },
  { id: 'error', label: 'Error' },
  { id: 'inferred', label: 'Stale (presumed stopped)' },
  { id: 'running', label: 'Running' },
]

const count = new Intl.NumberFormat()

/** Resolves the metrics endpoint URL, honoring VITE_METRICS_URL like graph/history.ts. */
function defaultMetricsUrl(): string {
  const fromEnv = import.meta.env.VITE_METRICS_URL as string | undefined
  if (fromEnv) return fromEnv
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http'
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  return `${protocol}://${host}:4000/metrics/summary`
}

async function fetchMetrics(): Promise<MetricsSummary> {
  const res = await fetch(defaultMetricsUrl(), { headers: { Authorization: `Bearer ${viewerToken()}` } })
  if (!res.ok) throw new Error(`Server responded ${res.status}`)
  return (await res.json()) as MetricsSummary
}

function pct(rate: number): string {
  const v = rate * 100
  return `${v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`
}

function ms(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
  return `${Math.round(value)} ms`
}

function ErrorRateCell({ rate, completed }: { rate: number; completed: number }) {
  const flaky = completed > 0 && rate >= FLAKY_ERROR_RATE
  return (
    <td className="spend-bar-col">
      <div className="metrics-rate">
        <div className="spend-bar-track" title={`Error rate ${pct(rate)}`}>
          {rate > 0 && (
            <div className="metrics-bar-error" style={{ width: `${Math.max(rate * 100, 1)}%` }} />
          )}
        </div>
        <span className={`metrics-rate-value${flaky ? ' is-flaky' : ''}`}>
          {completed === 0 ? '—' : pct(rate)}
          {flaky && <span className="metrics-flaky-badge">flaky</span>}
        </span>
      </div>
    </td>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="spend-tile">
      <span className="spend-tile-label">{label}</span>
      <strong className="spend-tile-value">{value}</strong>
      {sub && <span className="spend-tile-label">{sub}</span>}
    </div>
  )
}

export function MetricsTab() {
  const [data, setData] = useState<MetricsSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  // Re-runs on mount, on every manual Refresh (tick) and on the timer.
  useEffect(() => {
    let cancelled = false
    fetchMetrics().then(
      (summary) => {
        if (cancelled) return
        setData(summary)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Request failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])

  const refresh = (
    <button type="button" className="logs-scroll-toggle" onClick={reload}>
      Refresh
    </button>
  )

  if (!data) {
    return (
      <div>
        <h2>Metrics</h2>
        {error ? (
          <p className="empty-state">Could not load metrics ({error}). {refresh}</p>
        ) : (
          <p className="empty-state">Loading metrics…</p>
        )}
      </div>
    )
  }

  const { agents, toolCalls, byTool, byAgent } = data
  if (agents.total === 0 && toolCalls.calls === 0) {
    return (
      <div>
        <h2>Metrics</h2>
        <p className="empty-state">No agent or tool-call events recorded yet. {refresh}</p>
      </div>
    )
  }

  // Share of finished runs that succeeded; running/stale agents have no
  // reliable outcome yet, so they're excluded from this headline figure.
  const finished = agents.counts.success + agents.counts.error
  const successRate = finished > 0 ? agents.counts.success / finished : 0

  return (
    <div>
      <h2>Metrics</h2>
      <div className="spend-toolbar">
        Across all recorded events. {refresh}
        {error && <span className="metrics-stale-note">Refresh failed ({error}) — showing last data.</span>}
      </div>

      <div className="spend-tiles">
        <Tile label="Agents" value={count.format(agents.total)} />
        <Tile
          label="Agent success rate"
          value={finished > 0 ? pct(successRate) : '—'}
          sub={`${count.format(agents.counts.success)} of ${count.format(finished)} finished`}
        />
        <Tile label="Tool calls" value={count.format(toolCalls.calls)} sub={`${count.format(toolCalls.completed)} completed`} />
        <Tile
          label="Tool error rate"
          value={toolCalls.completed > 0 ? pct(toolCalls.errorRate) : '—'}
          sub={`${count.format(toolCalls.errors)} errors`}
        />
        <Tile label="Tool latency p50 / p95" value={`${ms(toolCalls.latencyMs?.p50)} / ${ms(toolCalls.latencyMs?.p95)}`} />
      </div>

      <section className="spend-section">
        <h3>Agent outcomes</h3>
        {agents.total > 0 && (
          <div className="metrics-stack" role="img" aria-label="Agent outcome shares">
            {OUTCOMES.map(({ id, label }) =>
              agents.counts[id] > 0 ? (
                <div
                  key={id}
                  className={`metrics-seg metrics-seg--${id}`}
                  style={{ width: `${agents.rates[id] * 100}%` }}
                  title={`${label}: ${agents.counts[id]} (${pct(agents.rates[id])})`}
                />
              ) : null,
            )}
          </div>
        )}
        <ul className="metrics-legend">
          {OUTCOMES.map(({ id, label }) => (
            <li key={id}>
              <span className={`metrics-swatch metrics-seg--${id}`} aria-hidden="true" />
              {label}: <strong>{count.format(agents.counts[id])}</strong> ({pct(agents.rates[id])})
            </li>
          ))}
        </ul>
      </section>

      <section className="spend-section">
        <h3>By tool</h3>
        {byTool.length === 0 ? (
          <p className="empty-state">No tool calls recorded yet.</p>
        ) : (
          <table className="spend-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="spend-num">Calls</th>
                <th scope="col" className="spend-num">Errors</th>
                <th scope="col" className="spend-bar-col">Error rate</th>
                <th scope="col" className="spend-num">p50</th>
                <th scope="col" className="spend-num">p95</th>
                <th scope="col" className="spend-num">p99</th>
              </tr>
            </thead>
            <tbody>
              {byTool.map((t) => (
                <tr key={t.tool}>
                  <th scope="row" className="spend-name" title={t.tool}>{t.tool}</th>
                  <td className="spend-num">{count.format(t.calls)}</td>
                  <td className="spend-num">{count.format(t.errors)}</td>
                  <ErrorRateCell rate={t.errorRate} completed={t.completed} />
                  <td className="spend-num">{ms(t.latencyMs?.p50)}</td>
                  <td className="spend-num">{ms(t.latencyMs?.p95)}</td>
                  <td className="spend-num">{ms(t.latencyMs?.p99)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="metrics-note">
          Error rate = errors / completed calls. Latency covers completed calls only.
        </p>
      </section>

      <section className="spend-section">
        <h3>By agent</h3>
        {byAgent.length === 0 ? (
          <p className="empty-state">No agents recorded yet.</p>
        ) : (
          <table className="spend-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="spend-num">Tool calls</th>
                <th scope="col" className="spend-num">Tool errors</th>
                <th scope="col" className="spend-bar-col">Tool error rate</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.map((a) => (
                <tr key={a.agentId}>
                  <th scope="row" className="spend-name" title={a.agentId}>
                    {a.agentId}
                    {a.team && <span className="spend-sublabel">{a.team}</span>}
                  </th>
                  <td>
                    <span className={`metrics-outcome metrics-outcome--${a.outcome}`}>
                      {OUTCOMES.find((o) => o.id === a.outcome)?.label ?? a.outcome}
                    </span>
                  </td>
                  <td className="spend-num">{count.format(a.toolCalls)}</td>
                  <td className="spend-num">{count.format(a.toolErrors)}</td>
                  <ErrorRateCell rate={a.toolErrorRate} completed={a.completedToolCalls} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
