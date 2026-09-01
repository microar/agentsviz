/**
 * Sub-agent recognition for the Graph canvas.
 *
 * History: this module used to own the fade-out-and-remove timing for
 * stopped agents in the live Graph view (issues #39, #45, #49, #67) — a
 * grace window during which a just-stopped agent lingered, dimmed, before
 * being dropped. Issue #83 reframed the Graph tab as a strictly *live*
 * view: it now renders only agents whose `status === 'running'`, so a
 * stopped/failed/stale agent disappears immediately and there is nothing
 * left to fade. `computeFade` and the `useGraphFadeOut` re-render timer
 * were removed with it (history mode never used them anyway — a
 * reconstructed snapshot is authoritative as of its scrubbed instant).
 *
 * The one piece still needed is `isSubAgent`: `GraphCanvas` uses it to
 * decide whether an agent's `caller` names another known agent, i.e.
 * whether to draw a parent->child edge for it (issue #71).
 */

import type { AgentState } from '../types'

/**
 * True iff `agent` is a sub-agent of another agent seen in this session —
 * i.e. its `caller` names an agentId present in `knownAgentIds` — rather
 * than a top-level agent (no `caller`, or a `caller` that isn't itself a
 * known agent, e.g. the instrumentation library's default `caller: "user"`).
 * `knownAgentIds` should be every agentId ever observed in the current
 * session's store, not just the currently-visible ones, since the store
 * never removes an agent entry once seen (see `store.tsx`) and a sub-agent
 * must stay recognized even if its caller is no longer being drawn.
 */
export function isSubAgent(agent: AgentState, knownAgentIds: ReadonlySet<string>): boolean {
  return agent.caller !== undefined && knownAgentIds.has(agent.caller)
}
