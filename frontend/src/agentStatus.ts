/**
 * Shared "what status label does this agent have" model (issue #81).
 *
 * The Teams tab (#79/#80) introduced a clickable status filter on its
 * legend; the Graph tab has a visually identical legend and wants the exact
 * same behaviour. Rather than copy-paste the label derivation and the
 * legend shape into both tabs, they live here and both import them, so the
 * two tabs can never drift apart on what counts as `running` vs `stale` vs
 * `error`.
 *
 * `agentStatusLabel` collapses an `AgentState` down to one of four buckets,
 * matching the priority order Graph.tsx's canvas renderer
 * (`agentStatusClass` in `graph/`) already uses:
 *   running > presumed-stopped (`inferred`) > error (`stopStatus`) > stopped
 */

import type { AgentState } from './types'

export type StatusFilter = 'running' | 'stopped' | 'error' | 'stale'

/** Legend entries, in display order; also the clickable status filters. */
export const STATUS_LEGEND: { status: StatusFilter; label: string }[] = [
  { status: 'running', label: 'running' },
  { status: 'stopped', label: 'stopped' },
  { status: 'error', label: 'error' },
  { status: 'stale', label: 'presumed stopped' },
]

export function agentStatusLabel(agent: AgentState): StatusFilter {
  if (agent.status === 'running') return 'running'
  // A presumed (not explicitly reported) stop gets its own label — see the
  // canvas renderer's status-class logic for the same priority reasoning.
  if (agent.inferred) return 'stale'
  if (agent.stopStatus === 'error') return 'error'
  return 'stopped'
}
