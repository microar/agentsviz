/**
 * Fade-out-and-remove timing for stopped agents in the *live* Graph view
 * (issues #39, #40, #45, #49, #67).
 *
 * History: #39 introduced a 5s linger for stopped agents; #45 cut that to
 * near-instant removal (`FADE_MS` ~250ms) because a 5s linger of *every*
 * agent that ever ran cluttered a "live" view. That swung too far the
 * other way for the common case in #67: a Claude Code sub-agent (or any
 * short helper run) that lives 3–25s and then stops was gone from the
 * Graph tab ~250ms later, so a user who wasn't already staring at the
 * canvas at exactly the right moment saw nothing — the run only survived
 * in Teams and the timeline scrubber.
 *
 * The balance now:
 *   - A stopped **top-level** agent dims to `DIMMED_ALPHA` over `DIM_MS`
 *     (a quick, non-jarring de-emphasis so it's visually clear it's done),
 *     then lingers at that reduced opacity until `GRACE_MS` after it
 *     actually stopped, then is removed. `GRACE_MS` is long enough (60s)
 *     that a brief run is reliably caught by someone glancing at the tab,
 *     but short enough that the live view doesn't accumulate history.
 *   - A **sub-agent** (structural check below) still never dims or gets
 *     removed at all (#49) — the delegation tree is the whole point of a
 *     multi-agent view, and losing a child node right after it stops makes
 *     the tree impossible to read.
 *   - A **running** agent (including one that goes back to running after a
 *     presumed/explicit stop) is always fully opaque and never removed.
 *
 * Everything is a pure function of wall-clock time anchored to
 * `stoppedAt`, not to when this function first ran — so an agent that
 * stopped before the tab loaded, or mid-linger when the tab is switched
 * back to Graph, resumes exactly where the clock says it should be.
 *
 * History mode (issue #43) bypasses this entirely — see `GraphCanvas.tsx`'s
 * `historyMode` prop, which renders every agent in a reconstructed snapshot
 * at full opacity regardless of `computeFade`'s result.
 */

import type { AgentState } from '../types'

/** How long the dim-down ramp takes once an agent stops. */
export const DIM_MS = 400
/** Opacity a stopped top-level agent holds at during the grace window. */
export const DIMMED_ALPHA = 0.4
/**
 * How long after `stoppedAt` a stopped top-level agent stays on the live
 * Graph before it's removed (#67). Drives both the per-frame alpha in
 * `computeFade` and the removal re-render timer in `useGraphFadeOut`, so
 * the canvas and the tab's header/empty-state stay in lockstep.
 */
export const GRACE_MS = 60_000

export interface FadeState {
  /** 1 = fully visible, 0 = fully faded. */
  alpha: number
  /** True once the agent should be dropped from the Graph view entirely. */
  removed: boolean
}

/**
 * True iff `agent` is a sub-agent of another agent seen in this session —
 * i.e. its `caller` names an agentId present in `knownAgentIds` — rather
 * than a top-level agent (no `caller`, or a `caller` that isn't itself a
 * known agent, e.g. the instrumentation library's default `caller: "user"`).
 * `knownAgentIds` should be every agentId ever observed in the current
 * session's store, not just the currently-visible ones, since the store
 * never removes an agent entry once seen (see `store.tsx`) and a sub-agent
 * must stay recognized even if its caller has since faded out of view.
 */
export function isSubAgent(agent: AgentState, knownAgentIds: ReadonlySet<string>): boolean {
  return agent.caller !== undefined && knownAgentIds.has(agent.caller)
}

export function computeFade(
  agent: AgentState,
  now: number,
  knownAgentIds: ReadonlySet<string> = EMPTY_ID_SET,
): FadeState {
  if (isSubAgent(agent, knownAgentIds)) return { alpha: 1, removed: false }
  if (agent.status !== 'stopped') return { alpha: 1, removed: false }

  const stoppedAtMs = agent.stoppedAt ? Date.parse(agent.stoppedAt) : now
  const anchor = Number.isNaN(stoppedAtMs) ? now : stoppedAtMs
  const elapsed = Math.max(0, now - anchor)

  // Quick ramp from full opacity down to DIMMED_ALPHA, then hold there for
  // the rest of the grace window.
  const dimProgress = Math.min(1, elapsed / DIM_MS)
  const alpha = 1 - dimProgress * (1 - DIMMED_ALPHA)
  return { alpha, removed: elapsed >= GRACE_MS }
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set()
