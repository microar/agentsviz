/**
 * Spend view (issue #55): aggregate token/cost by team and by agent, plus
 * a running session total.
 *
 * Reads `spend` from the shared event store (seeded from the server
 * snapshot, then updated live per `agent_stop` / `tool_call_end` — see
 * store.tsx's `recordCost`). Respects the header team/session filter the
 * same way Teams.tsx does: with no team picked it shows the server's
 * per-team breakdown and session total as-is; with a team (and optionally
 * a session) picked it shows only the visible agents and totals them.
 *
 * Deliberately simple for v1: stat tiles for the totals, then per-team and
 * per-agent tables whose share-of-total bar is a single-hue inline bar
 * (one series, so no legend; the exact numbers sit in the same row).
 */

import { useMemo, useState } from 'react'
import { useEventStore } from './store'
import { computeVisibleAgentIds, useDashboardFilter } from './filterModel'
import type { CostTotals } from './types'

type Metric = 'cost' | 'tokens'

const UNGROUPED = 'Ungrouped'

const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})
const count = new Intl.NumberFormat()

function metricValue(totals: CostTotals, metric: Metric): number {
  return metric === 'cost' ? totals.costUsd : totals.tokensIn + totals.tokensOut
}

function formatMetric(value: number, metric: Metric): string {
  return metric === 'cost' ? usd.format(value) : `${count.format(value)} tokens`
}

function sumTotals(list: CostTotals[]): CostTotals {
  return list.reduce(
    (acc, t) => ({
      tokensIn: acc.tokensIn + t.tokensIn,
      tokensOut: acc.tokensOut + t.tokensOut,
      costUsd: acc.costUsd + t.costUsd,
    }),
    { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  )
}

interface Row {
  key: string
  label: string
  sublabel?: string
  totals: CostTotals
}

function SpendTable({ title, rows, metric, nameHeader }: { title: string; rows: Row[]; metric: Metric; nameHeader: string }) {
  const max = Math.max(0, ...rows.map((r) => metricValue(r.totals, metric)))
  return (
    <section className="spend-section">
      <h3>{title}</h3>
      <table className="spend-table">
        <thead>
          <tr>
            <th scope="col">{nameHeader}</th>
            <th scope="col" className="spend-num">Tokens in</th>
            <th scope="col" className="spend-num">Tokens out</th>
            <th scope="col" className="spend-num">Cost</th>
            <th scope="col" className="spend-bar-col">
              <span className="sr-only">Relative {metric === 'cost' ? 'cost' : 'tokens'}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const value = metricValue(row.totals, metric)
            const pct = max > 0 ? (value / max) * 100 : 0
            return (
              <tr key={row.key}>
                <th scope="row" className="spend-name" title={row.label}>
                  {row.label}
                  {row.sublabel && <span className="spend-sublabel">{row.sublabel}</span>}
                </th>
                <td className="spend-num">{count.format(row.totals.tokensIn)}</td>
                <td className="spend-num">{count.format(row.totals.tokensOut)}</td>
                <td className="spend-num">{usd.format(row.totals.costUsd)}</td>
                <td className="spend-bar-col">
                  <div className="spend-bar-track" title={`${row.label}: ${formatMetric(value, metric)}`}>
                    {pct > 0 && <div className="spend-bar" style={{ width: `${Math.max(pct, 1)}%` }} />}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

export function SpendTab() {
  const { agents, spend } = useEventStore()
  const { team, sessionRoot } = useDashboardFilter()

  const visibleIds = useMemo(
    () => computeVisibleAgentIds({ team, sessionRoot }, agents),
    [team, sessionRoot, agents],
  )

  const agentRows = useMemo<Row[]>(
    () =>
      Object.entries(spend.byAgent)
        .filter(([agentId]) => !visibleIds || visibleIds.has(agentId))
        .map(([agentId, totals]) => ({
          key: agentId,
          label: agentId,
          sublabel: agents[agentId]?.team,
          totals,
        })),
    [spend.byAgent, visibleIds, agents],
  )

  // Unfiltered: the server's own per-team totals and session total. Filtered:
  // everything is derived from the visible agents, since server team totals
  // can't be narrowed to one session.
  const { teamRows, total } = useMemo(() => {
    if (!visibleIds) {
      const rows: Row[] = Object.entries(spend.byTeam).map(([name, totals]) => ({ key: name, label: name, totals }))
      const teamed = sumTotals(rows.map((r) => r.totals))
      const ungrouped: CostTotals = {
        tokensIn: spend.total.tokensIn - teamed.tokensIn,
        tokensOut: spend.total.tokensOut - teamed.tokensOut,
        costUsd: spend.total.costUsd - teamed.costUsd,
      }
      if (ungrouped.tokensIn > 0 || ungrouped.tokensOut > 0 || ungrouped.costUsd > 1e-12) {
        rows.push({ key: UNGROUPED, label: UNGROUPED, totals: ungrouped })
      }
      return { teamRows: rows, total: spend.total }
    }
    const byTeam = new Map<string, CostTotals[]>()
    for (const row of agentRows) {
      const name = row.sublabel ?? UNGROUPED
      byTeam.set(name, [...(byTeam.get(name) ?? []), row.totals])
    }
    const rows: Row[] = [...byTeam.entries()].map(([name, list]) => ({ key: name, label: name, totals: sumTotals(list) }))
    return { teamRows: rows, total: sumTotals(agentRows.map((r) => r.totals)) }
  }, [visibleIds, spend, agentRows])

  // Default the bar metric to cost when any cost was reported, else tokens
  // (e.g. hooks-emitter, which reports tokens but no USD). The user can flip it.
  const [metricOverride, setMetricOverride] = useState<Metric | null>(null)
  const metric: Metric = metricOverride ?? (total.costUsd > 0 ? 'cost' : 'tokens')

  const byMetricDesc = (a: Row, b: Row) =>
    metricValue(b.totals, metric) - metricValue(a.totals, metric) || a.label.localeCompare(b.label)
  const sortedAgents = [...agentRows].sort(byMetricDesc)
  const sortedTeams = [...teamRows].sort(byMetricDesc)

  if (agentRows.length === 0) {
    return (
      <div>
        <h2>Spend</h2>
        <p className="empty-state">
          {visibleIds
            ? 'No token/cost data for the current team/session filter.'
            : 'No token/cost data yet — emitters report it via tokensIn / tokensOut / costUsd on agent_stop or tool_call_end.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2>Spend</h2>
      <div className="spend-tiles">
        <div className="spend-tile">
          <span className="spend-tile-label">{visibleIds ? 'Filtered total cost' : 'Session total cost'}</span>
          <strong className="spend-tile-value">{usd.format(total.costUsd)}</strong>
        </div>
        <div className="spend-tile">
          <span className="spend-tile-label">Tokens in</span>
          <strong className="spend-tile-value">{count.format(total.tokensIn)}</strong>
        </div>
        <div className="spend-tile">
          <span className="spend-tile-label">Tokens out</span>
          <strong className="spend-tile-value">{count.format(total.tokensOut)}</strong>
        </div>
      </div>

      <div className="spend-toolbar" role="group" aria-label="Bar metric">
        Bars show:
        {(['cost', 'tokens'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`graph-legend-item graph-legend-item--filter${metric === m ? ' is-active' : ''}`}
            aria-pressed={metric === m}
            onClick={() => setMetricOverride(m)}
          >
            {m === 'cost' ? 'Cost (USD)' : 'Tokens (in + out)'}
          </button>
        ))}
      </div>

      <SpendTable title="By team" nameHeader="Team" rows={sortedTeams} metric={metric} />
      <SpendTable title="By agent" nameHeader="Agent" rows={sortedAgents} metric={metric} />
    </div>
  )
}
