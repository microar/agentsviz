/**
 * Edge rendering: caller-agent → tool lines (issue #40).
 *
 * One edge per (caller agent, tool) pair, matching the pre-#40 SVG
 * implementation's semantics — a settled edge flips back to "active" if the
 * same agent calls the same tool again, since edges are keyed by the pair,
 * not by individual call.
 */

import { COLORS } from './colors'
import { AGENT_RADIUS, type Point } from './layout'
import type { ToolCallState } from '../types'

export interface Edge {
  key: string
  call: ToolCallState
  source: string
}

export function drawEdge(ctx: CanvasRenderingContext2D, from: Point, to: Point, call: ToolCallState, timeMs: number, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineWidth = call.status === 'pending' ? 2.5 : 1.5
  ctx.strokeStyle =
    call.status === 'pending'
      ? COLORS.edgePending
      : call.status === 'error'
        ? COLORS.edgeError
        : call.status === 'success'
          ? COLORS.edgeSuccess
          : COLORS.edgeSettled

  if (call.status === 'pending') {
    // Animated marching-ants dash, matching the old CSS `graph-edge-flow`
    // keyframe (10px cycle, ~0.8s per cycle -> -10 offset per 800ms).
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -((timeMs / 800) * 10)
  } else {
    ctx.setLineDash([])
  }

  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

/**
 * Parent-agent -> spawned-sub-agent edge (issue #71): who spawned whom.
 *
 * Deliberately unlike `drawEdge` — a plain static line in a dedicated muted
 * blue (`COLORS.subAgentLink`), no marching-ants dash and no particles, so
 * the delegation relationship reads as a different kind of link than an
 * agent->tool call. A small filled arrowhead points at the child so the
 * direction is legible. Both ends are pulled in to the node's edge (rather
 * than its center) so the line doesn't disappear under the node circles and
 * the arrowhead sits just outside the child.
 */
export function drawSubAgentEdge(ctx: CanvasRenderingContext2D, parent: Point, child: Point, alpha: number) {
  const dx = child.x - parent.x
  const dy = child.y - parent.y
  const len = Math.hypot(dx, dy)
  if (len < 1) return
  const ux = dx / len
  const uy = dy / len

  const startX = parent.x + ux * AGENT_RADIUS
  const startY = parent.y + uy * AGENT_RADIUS
  const tipX = child.x - ux * (AGENT_RADIUS + 3)
  const tipY = child.y - uy * (AGENT_RADIUS + 3)
  // Nothing left to draw once the two nodes are basically touching.
  if ((tipX - startX) * ux + (tipY - startY) * uy <= 0) return

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = COLORS.subAgentLink
  ctx.fillStyle = COLORS.subAgentLink
  ctx.lineWidth = 1.5
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  const head = 7
  const angle = Math.atan2(dy, dx)
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - head * Math.cos(angle - Math.PI / 7), tipY - head * Math.sin(angle - Math.PI / 7))
  ctx.lineTo(tipX - head * Math.cos(angle + Math.PI / 7), tipY - head * Math.sin(angle + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
