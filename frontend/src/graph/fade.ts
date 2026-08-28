/**
 * Fade-out-and-remove timing for stopped agents (issue #39), reimplemented
 * for the canvas render loop (issue #40), then shortened to near-instant
 * removal per issue #45 — the original 5s window kept stale/stopped agents
 * cluttering a "live" view for longer than the dashboard's goal justifies.
 * `FADE_MS` is now just long enough (a couple hundred ms) to avoid a jarring
 * pop when a node disappears, not a real "linger" window.
 *
 * The original DOM implementation (`useGraphFadeOut` in the pre-#40
 * Graph.tsx) scheduled a `setTimeout` per agent and drove a CSS
 * `transition: opacity` from a captured "remaining ms" value. A canvas
 * render loop already recomputes visuals every frame, so the equivalent
 * here is a pure function of wall-clock time: alpha ramps linearly from 1
 * to 0 over `FADE_MS`, anchored to `stoppedAt` — not to whenever this
 * function first happened to run — so an agent that was already stopped
 * before the tab loaded (e.g. present in the initial snapshot) still
 * disappears ~`FADE_MS` after it *actually* stopped, and one mid-fade when
 * the tab is switched back to Graph resumes exactly where the clock says it
 * should be, not from a fresh window.
 *
 * A running agent (including one that goes back to running after a
 * presumed/explicit stop — a reconnect/resume, handled defensively as in
 * the original hook) is always fully opaque and never removed.
 *
 * History mode (issue #43) bypasses this entirely — see `GraphCanvas.tsx`'s
 * `historyMode` prop, which renders every agent in a reconstructed snapshot
 * at full opacity regardless of `computeFade`'s result.
 */

import type { AgentState } from '../types'

export const FADE_MS = 250

export interface FadeState {
  /** 1 = fully visible, 0 = fully faded. */
  alpha: number
  /** True once the agent should be dropped from the Graph view entirely. */
  removed: boolean
}

export function computeFade(agent: AgentState, now: number): FadeState {
  if (agent.status !== 'stopped') return { alpha: 1, removed: false }

  const stoppedAtMs = agent.stoppedAt ? Date.parse(agent.stoppedAt) : now
  const anchor = Number.isNaN(stoppedAtMs) ? now : stoppedAtMs
  const elapsed = now - anchor
  const alpha = Math.min(1, Math.max(0, 1 - elapsed / FADE_MS))
  return { alpha, removed: elapsed >= FADE_MS }
}
