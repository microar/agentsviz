/**
 * Tracks which stopped agents should still be shown in the Graph view (#39)
 * and drives a React re-render at the moment each one finishes fading, so
 * the tab's header stats / empty-state message stay in sync with the
 * canvas even though nothing else about the store changed.
 *
 * This is the same timer-driven approach as the pre-#40 DOM implementation
 * (one `setTimeout` per agent, anchored to `stoppedAt` wall-clock time, not
 * to whenever this hook first happened to see the agent stopped) — moved
 * here unchanged because it's still exactly what's needed to know *when to
 * re-render*, i.e. when an agent should be spliced out of `agentList`. The
 * canvas itself no longer depends on this hook's timers for its per-frame
 * opacity, though — see fade.ts's `computeFade`, which the render loop
 * calls every frame to get a continuously-updated alpha (canvas alpha
 * instead of a CSS `transition: opacity`), driven by the same `FADE_MS`
 * window and the same `stoppedAt` anchor so the two stay in lockstep.
 *
 * Sub-agents (issue #49, see `isSubAgent` in fade.ts) are exempt from
 * fade-out entirely — no timer is ever scheduled for one, and any pending
 * removal is cancelled if an agent turns out to be a sub-agent. `agents`
 * doubles as the source of "every agentId known this session" for that
 * check, since the store never removes an agent entry once seen (see
 * `store.tsx`), so the full history is always present in the list this
 * hook is called with.
 */

import { useEffect, useRef, useState } from 'react'
import type { AgentState } from '../types'
import { FADE_MS, isSubAgent } from './fade'

export function useGraphFadeOut(agents: AgentState[]): {
  isRemoved: (agentId: string) => boolean
} {
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const timers = timersRef.current
    const now = Date.now()
    const knownAgentIds = new Set(agents.map((a) => a.agentId))

    for (const agent of agents) {
      const id = agent.agentId
      if (isSubAgent(agent, knownAgentIds)) {
        // Permanently visible — cancel any pending/completed removal.
        const timer = timers.get(id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(id)
        }
        setRemovedIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      } else if (agent.status === 'stopped') {
        if (timers.has(id)) continue // fade already scheduled for this stop

        const stoppedAtMs = agent.stoppedAt ? Date.parse(agent.stoppedAt) : now
        const remaining = FADE_MS - (now - (Number.isNaN(stoppedAtMs) ? now : stoppedAtMs))

        if (remaining <= 0) {
          setRemovedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
          continue
        }

        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id)
            setRemovedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
          }, remaining),
        )
      } else {
        // Running (again) — cancel any pending removal so the node
        // reappears (a reconnect/resume; shouldn't normally happen, but
        // handled defensively as in the original hook).
        const timer = timers.get(id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(id)
        }
        setRemovedIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  return { isRemoved: (agentId) => removedIds.has(agentId) }
}
