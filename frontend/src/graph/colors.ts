/**
 * Canvas color tokens for the graph (issue #40).
 *
 * These are carried over verbatim from the pre-#40 SVG/CSS implementation
 * (`App.css`'s `.graph-node--*` / `.graph-edge--*` rules) rather than
 * invented fresh, so the status color language stays consistent with the
 * legend and with anyone's muscle memory from the previous view:
 *  - running: indigo, pulsing
 *  - stopped (clean success): green
 *  - stopped (error): red
 *  - inferred/presumed-stopped (#37): amber, dashed outline
 *  - tool node: neutral gray
 *  - edge pending: amber, dashed + animated
 *  - edge settled: neutral gray, tinted green/red to match the call outcome
 */

export const COLORS = {
  runningFill: 'rgba(100, 108, 255, 0.25)',
  runningStroke: '#646cff',

  stoppedFill: 'rgba(22, 163, 74, 0.15)',
  stoppedStroke: '#16a34a',

  errorFill: 'rgba(220, 38, 38, 0.18)',
  errorStroke: '#dc2626',

  staleFill: 'rgba(217, 119, 6, 0.12)',
  staleStroke: '#d97706',

  toolFill: 'rgba(127, 127, 127, 0.12)',
  toolStroke: 'rgba(127, 127, 127, 0.55)',

  edgeSettled: 'rgba(127, 127, 127, 0.4)',
  edgeSuccess: 'rgba(22, 163, 74, 0.55)',
  edgeError: 'rgba(220, 38, 38, 0.55)',
  edgePending: '#d97706',

  label: 'rgba(148, 148, 158, 0.95)',
  labelMuted: 'rgba(127, 127, 127, 0.75)',
} as const

export function agentColors(agent: { status: 'running' | 'stopped'; stopStatus?: 'success' | 'error'; inferred?: true }): {
  fill: string
  stroke: string
  dashed: boolean
} {
  if (agent.status === 'running') return { fill: COLORS.runningFill, stroke: COLORS.runningStroke, dashed: false }
  // A presumed (not explicitly reported) stop takes priority over
  // stopStatus — it's the server's best guess, not a confirmed clean/error
  // stop (mirrors agentStatusClass from the pre-#40 Graph.tsx).
  if (agent.inferred) return { fill: COLORS.staleFill, stroke: COLORS.staleStroke, dashed: true }
  if (agent.stopStatus === 'error') return { fill: COLORS.errorFill, stroke: COLORS.errorStroke, dashed: false }
  return { fill: COLORS.stoppedFill, stroke: COLORS.stoppedStroke, dashed: false }
}
