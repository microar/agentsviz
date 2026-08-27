/**
 * Edge rendering: caller-agent → tool lines (issue #40).
 *
 * One edge per (caller agent, tool) pair, matching the pre-#40 SVG
 * implementation's semantics — a settled edge flips back to "active" if the
 * same agent calls the same tool again, since edges are keyed by the pair,
 * not by individual call.
 */

import { COLORS } from './colors'
import type { Point } from './layout'
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
