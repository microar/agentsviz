/**
 * Canvas-based rendering pipeline for the Graph tab (issue #40).
 *
 * Replaces the pre-#40 SVG graph with a native Canvas 2D `<canvas>` and a
 * `requestAnimationFrame` render loop, in the spirit of agent-flow's
 * hand-rolled canvas renderer (draw-agents/draw-edges/draw-particles/etc.
 * as separate modules — see the sibling files in this directory) — no code
 * from that project is used, this is an original implementation over this
 * repo's own store/types.
 *
 * State that changes every frame (pan/zoom camera, fade alpha, pulse
 * phase, particle position) is kept in refs and read directly inside the
 * loop; state that only changes when the underlying data changes (node
 * layout, the edge list) is computed by React as normal (see layout.ts /
 * render-cache.ts) and pushed into a ref for the loop to pick up, so
 * panning/zooming never triggers a React re-render and adding a new agent
 * never re-runs the pan/zoom math.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentState } from '../types'
import { drawAgentNode } from './draw-agents'
import { drawToolNode } from './draw-tool-nodes'
import { drawEdge, type Edge } from './draw-edges'
import { drawEdgeParticles, updateEdgeAnimStates, type EdgeAnimState } from './draw-particles'
import { computeFade } from './fade'
import { hitTestAgent } from './hit-detection'
import {
  AGENT_CENTER,
  AGENT_SPACING,
  TOOL_CENTER,
  TOOL_SPACING,
  useStableLayout,
  type Point,
} from './layout'
import { useWorldBounds, syncCanvasSize } from './render-cache'
import { useCanvasCamera } from './useCanvasCamera'

export interface GraphCanvasProps {
  allAgents: AgentState[]
  toolNames: string[]
  edges: Edge[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  /**
   * Every agentId ever seen this session (issue #49) — used by `computeFade`
   * to recognize a sub-agent (an agent whose `caller` names another agent in
   * this set) so it can be exempted from fade-out/removal. Deliberately the
   * *full* session history, not just `allAgents` (which, in live mode, is
   * already filtered down to not-yet-removed agents) — a sub-agent must stay
   * recognized as such even after the top-level agent that spawned it has
   * itself faded out of `allAgents`.
   */
  knownAgentIds: ReadonlySet<string>
  /**
   * True when rendering a reconstructed historical snapshot rather than
   * live state (issue #43). Skips the #39 fade-out-on-stop timer entirely:
   * a historical snapshot already reflects state exactly as of the
   * scrubbed instant, so a "stopped" agent in that snapshot is shown at
   * full opacity regardless of how long ago (relative to *now*) it
   * actually stopped — that's the point of scrubbing back to see agents
   * that would already be faded/gone in the live view.
   */
  historyMode?: boolean
}

function readCssColor(canvas: HTMLCanvasElement): { text: string; muted: string } {
  const style = getComputedStyle(canvas)
  return {
    text: style.getPropertyValue('--text-h').trim() || '#1f2937',
    muted: style.getPropertyValue('--text').trim() || '#6b7280',
  }
}

export function GraphCanvas({
  allAgents,
  toolNames,
  edges,
  selectedAgentId,
  onSelectAgent,
  knownAgentIds,
  historyMode = false,
}: GraphCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const camera = useCanvasCamera(canvasRef)
  // Read every frame/click by the render loop and hit-test handler below —
  // kept in a ref (rather than closed over directly) purely so those
  // effects, which intentionally run once on mount, still see live updates.
  const historyModeRef = useRef(historyMode)
  historyModeRef.current = historyMode
  // Bumped by a ResizeObserver below so the auto-fit effect re-runs once the
  // wrapper actually has its final flex-layout size, not just whatever size
  // (possibly 0, possibly a pre-layout guess) it had on first paint.
  const [sizeTick, setSizeTick] = useState(0)

  const agentIds = useMemo(() => allAgents.map((a) => a.agentId), [allAgents])
  const knownAgentIdsRef = useRef(knownAgentIds)
  knownAgentIdsRef.current = knownAgentIds
  const agentPositions = useStableLayout(agentIds, AGENT_CENTER, AGENT_SPACING)
  const toolPositions = useStableLayout(toolNames, TOOL_CENTER, TOOL_SPACING)
  const bounds = useWorldBounds([agentPositions, toolPositions], 90)

  // Data pushed into refs for the render loop — updated every React render,
  // read every animation frame, never causes the loop itself to restart.
  const agentsRef = useRef(allAgents)
  const agentPositionsRef = useRef(agentPositions)
  const toolPositionsRef = useRef(toolPositions)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selectedAgentId)
  agentsRef.current = allAgents
  agentPositionsRef.current = agentPositions
  toolPositionsRef.current = toolPositions
  edgesRef.current = edges
  selectedRef.current = selectedAgentId

  const edgeAnimStatesRef = useRef<Map<string, EdgeAnimState>>(new Map())

  // Fit the camera to the graph's content bounds exactly once — on initial
  // mount, not on every subsequent node-set change (issue #45: a live
  // dashboard whose camera silently re-fits/re-zooms every time an agent or
  // tool call shows up is disorienting; new nodes appearing off the
  // currently-framed view is an acceptable tradeoff, the user can pan to
  // find them). `hasFittedRef` latches true the first time a fit actually
  // happens and the effect becomes a no-op forever after, so it never
  // fights the user's own framing again — same as the `hasEverInteracted()`
  // guard below, kept for the case where the user pans/zooms before a fit
  // ever manages to happen.
  //
  // The effect still needs to *retry* on every bounds/size change up until
  // that first successful fit, though — that's not re-fitting, it's
  // "become able to fit at all": the very first layout pass can hand us a
  // 0×0 or not-yet-final wrapper size before CSS flex layout has settled,
  // or an empty content-bounds before the first node exists (originally
  // fixed in #40/#42).
  const hasFittedRef = useRef(false)
  useEffect(() => {
    if (hasFittedRef.current) return
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return
    if (camera.hasEverInteracted()) return
    const cssWidth = wrapper.clientWidth
    const cssHeight = wrapper.clientHeight
    if (cssWidth === 0 || cssHeight === 0) return

    const contentW = bounds.maxX - bounds.minX
    const contentH = bounds.maxY - bounds.minY
    if (contentW <= 0 || contentH <= 0) return

    const scale = Math.min(1, Math.min(cssWidth / contentW, cssHeight / contentH))
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    camera.setCamera({
      scale,
      x: cssWidth / 2 - centerX * scale,
      y: cssHeight / 2 - centerY * scale,
    })
    hasFittedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, sizeTick])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const observer = new ResizeObserver(() => setSizeTick((t) => t + 1))
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  // Click-to-inspect: hit-test against canvas coordinates (there are no DOM
  // click targets on a <canvas>) — see hit-detection.ts. Suppressed while
  // the camera reports an active drag/pinch so panning never opens a node.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function onClick(e: PointerEvent) {
      if (camera.isInteracting()) return
      const rect = canvas!.getBoundingClientRect()
      const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      const visibleIds = agentsRef.current
        .filter((a) => historyModeRef.current || !computeFade(a, Date.now(), knownAgentIdsRef.current).removed)
        .map((a) => a.agentId)
      const hit = hitTestAgent(world, agentPositionsRef.current, visibleIds)
      if (hit) onSelectAgent(hit)
    }

    canvas.addEventListener('pointerup', onClick)
    return () => canvas.removeEventListener('pointerup', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The render loop itself. Started once on mount; reads everything it
  // needs from refs so it never needs to be torn down/recreated as data or
  // selection changes.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !wrapper || !ctx) return

    let rafId: number
    let colors = readCssColor(canvas)
    let lastColorCheck = 0

    function frame(perfNow: number) {
      const cssWidth = wrapper!.clientWidth
      const cssHeight = wrapper!.clientHeight
      syncCanvasSize(canvas!, cssWidth, cssHeight)

      // Re-read theme colors occasionally (cheap, but no need every frame)
      // so a live light/dark theme switch is picked up without a full
      // remount.
      if (perfNow - lastColorCheck > 500) {
        colors = readCssColor(canvas!)
        lastColorCheck = perfNow
      }

      const dpr = window.devicePixelRatio || 1
      const cam = camera.getCamera()
      const nowMs = Date.now()

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, cssWidth, cssHeight)
      ctx!.translate(cam.x, cam.y)
      ctx!.scale(cam.scale, cam.scale)

      const agentPositions = agentPositionsRef.current
      const toolPositions = toolPositionsRef.current
      const edgeList = edgesRef.current
      const agents = agentsRef.current

      const alphaByAgent = new Map<string, number>()
      for (const agent of agents) {
        // History mode (issue #43): a reconstructed snapshot is already
        // "as of" the scrubbed instant, so every agent in it renders at
        // full opacity — no live fade-out timer applies.
        alphaByAgent.set(
          agent.agentId,
          historyModeRef.current ? 1 : computeFade(agent, nowMs, knownAgentIdsRef.current).alpha,
        )
      }

      updateEdgeAnimStates(edgeAnimStatesRef.current, edgeList, perfNow)

      // Edges (bottom layer).
      for (const edge of edgeList) {
        const from = agentPositions.get(edge.source)
        const to = toolPositions.get(edge.call.tool)
        const alpha = alphaByAgent.get(edge.source)
        if (!from || !to || alpha === undefined || alpha <= 0) continue
        drawEdge(ctx!, from, to, edge.call, perfNow, alpha)
      }

      // Particle / burst effects over the edges.
      for (const edge of edgeList) {
        const from = agentPositions.get(edge.source)
        const to = toolPositions.get(edge.call.tool)
        const alpha = alphaByAgent.get(edge.source)
        if (!from || !to || alpha === undefined || alpha <= 0) continue
        drawEdgeParticles(ctx!, edge, from, to, edgeAnimStatesRef.current.get(edge.key), perfNow, alpha)
      }

      // Tool nodes.
      const activeTools = new Set(edgeList.filter((e) => e.call.status === 'pending').map((e) => e.call.tool))
      for (const [tool, pos] of toolPositions) {
        drawToolNode(ctx!, tool, pos, colors.muted, activeTools.has(tool))
      }

      // Agent nodes (top layer).
      for (const agent of agents) {
        const pos = agentPositions.get(agent.agentId)
        const alpha = alphaByAgent.get(agent.agentId) ?? 1
        if (!pos || alpha <= 0) continue
        drawAgentNode(
          ctx!,
          { agent, pos, alpha, selected: agent.agentId === selectedRef.current },
          perfNow,
          colors.text,
        )
      }

      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Visually-hidden agent buttons keep click-to-inspect reachable via
  // keyboard/screen reader now that the graph itself is a flat canvas with
  // no individually-focusable DOM nodes.
  const visibleAgents = useMemo(
    () => allAgents.filter((a) => historyMode || !computeFade(a, Date.now(), knownAgentIds).removed),
    [allAgents, historyMode, knownAgentIds],
  )

  return (
    <div className={`graph-canvas-wrap${historyMode ? ' graph-canvas-wrap--history' : ''}`} ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className="graph-canvas-el"
        role="img"
        aria-label={historyMode ? 'Historical agent graph (viewing past state)' : 'Live agent graph'}
      />
      <div className="sr-only" aria-label="Agents (keyboard-accessible list)">
        {visibleAgents.map((agent) => (
          <button key={agent.agentId} type="button" onClick={() => onSelectAgent(agent.agentId)}>
            {agent.agentId}
            {agent.team ? ` (${agent.team})` : ''} — {agent.status}
            {agent.stopStatus ? `/${agent.stopStatus}` : ''}
            {agent.inferred ? ' (presumed)' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

export type { Point }
