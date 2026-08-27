/**
 * Particle / tool-call activity effects (issue #40) — the "alive" visual
 * agent-flow is going for: a flowing dot along an edge while a tool call is
 * pending, and a brief expanding ring burst on the tool node the instant a
 * call settles (success/error). Both are purely additive over the static
 * edge/node drawing in draw-edges.ts / draw-tool-nodes.ts.
 *
 * Per-edge animation state (which particle phase it's on, whether a settle
 * burst is currently playing) is tracked in a small `Map` owned by the
 * caller (GraphCanvas) and mutated in place by `updateEdgeAnimStates` once
 * per frame — this avoids allocating a fresh Map every frame and lets
 * finished bursts / vanished edges get pruned cheaply.
 */

import { COLORS } from './colors'
import type { Point } from './layout'
import type { Edge } from './draw-edges'

const PARTICLES_PER_EDGE = 2
const PARTICLE_PERIOD_MS = 1100
const BURST_DURATION_MS = 600

export interface EdgeAnimState {
  prevStatus: 'pending' | 'success' | 'error'
  burstStartMs: number | null
}

/** Mutates `states` in place: detects pending->settled transitions (arms a burst) and prunes edges no longer present. */
export function updateEdgeAnimStates(states: Map<string, EdgeAnimState>, edges: Edge[], nowMs: number) {
  const liveKeys = new Set(edges.map((e) => e.key))
  for (const key of states.keys()) {
    if (!liveKeys.has(key)) states.delete(key)
  }
  for (const edge of edges) {
    const status = edge.call.status
    const prev = states.get(edge.key)
    if (!prev) {
      states.set(edge.key, { prevStatus: status, burstStartMs: null })
      continue
    }
    if (prev.prevStatus === 'pending' && status !== 'pending') {
      states.set(edge.key, { prevStatus: status, burstStartMs: nowMs })
    } else if (prev.prevStatus !== status) {
      states.set(edge.key, { ...prev, prevStatus: status })
    }
  }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export function drawEdgeParticles(
  ctx: CanvasRenderingContext2D,
  edge: Edge,
  from: Point,
  to: Point,
  state: EdgeAnimState | undefined,
  nowMs: number,
  alpha: number,
) {
  if (edge.call.status === 'pending') {
    for (let i = 0; i < PARTICLES_PER_EDGE; i++) {
      const offset = i / PARTICLES_PER_EDGE
      const t = ((nowMs / PARTICLE_PERIOD_MS + offset) % 1 + 1) % 1
      const pos = lerp(from, to, t)
      // Fade in/out near the endpoints so particles don't visually "pop".
      const edgeFade = Math.min(1, t * 8, (1 - t) * 8)
      ctx.save()
      ctx.globalAlpha = alpha * edgeFade
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.edgePending
      ctx.shadowColor = COLORS.edgePending
      ctx.shadowBlur = 6
      ctx.fill()
      ctx.restore()
    }
    return
  }

  if (state?.burstStartMs != null) {
    const elapsed = nowMs - state.burstStartMs
    if (elapsed >= 0 && elapsed < BURST_DURATION_MS) {
      const t = elapsed / BURST_DURATION_MS
      const radius = 6 + t * 16
      const color = edge.call.status === 'error' ? COLORS.edgeError : COLORS.edgeSuccess
      ctx.save()
      ctx.globalAlpha = alpha * (1 - t)
      ctx.beginPath()
      ctx.arc(to.x, to.y, radius, 0, Math.PI * 2)
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.stroke()
      ctx.restore()
    }
  }
}
