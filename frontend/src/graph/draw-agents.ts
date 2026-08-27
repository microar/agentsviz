/**
 * Agent node rendering (issue #40).
 *
 * Visual states mirror the pre-#40 CSS classes 1:1 (see colors.ts):
 * running nodes pulse (stroke width/opacity oscillating, matching the old
 * `@keyframes graph-pulse` — 1.6s sine cycle), stopped/error/stale nodes are
 * static, and stale (#37 inferred stop) gets a dashed outline. The whole
 * node is drawn at `alpha` for the #39 fade-out-and-remove behavior — see
 * fade.ts.
 */

import { agentColors } from './colors'
import { AGENT_RADIUS, agentLabel, type Point } from './layout'
import type { AgentState } from '../types'

const PULSE_PERIOD_MS = 1600

export interface AgentNodeVisual {
  agent: AgentState
  pos: Point
  alpha: number
  selected: boolean
}

export function drawAgentNode(ctx: CanvasRenderingContext2D, visual: AgentNodeVisual, timeMs: number, labelColor: string) {
  const { agent, pos, alpha, selected } = visual
  const { fill, stroke, dashed } = agentColors(agent)

  let strokeWidth = 2
  let strokeAlphaFactor = 1
  if (agent.status === 'running') {
    // ease-in-out sine, matching the CSS keyframe's 0%/50%/100% shape.
    const phase = (timeMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS
    const wave = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2 // 0..1, starts at 0
    strokeWidth = 2 + wave * 1.5
    strokeAlphaFactor = 1 - wave * 0.4
  }

  ctx.save()
  ctx.globalAlpha = alpha

  if (selected) {
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, AGENT_RADIUS + 5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(100, 108, 255, 0.9)'
    ctx.lineWidth = 2
    ctx.setLineDash([])
    ctx.stroke()
  }

  ctx.beginPath()
  ctx.arc(pos.x, pos.y, AGENT_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.setLineDash(dashed ? [4, 3] : [])
  ctx.lineWidth = strokeWidth
  ctx.globalAlpha = alpha * strokeAlphaFactor
  ctx.strokeStyle = stroke
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = labelColor
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(agentLabel(agent.agentId), pos.x, pos.y + AGENT_RADIUS + 4)
  if (agent.team) {
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = 'rgba(127, 127, 127, 0.85)'
    ctx.fillText(agent.team, pos.x, pos.y + AGENT_RADIUS + 17)
  }
  ctx.restore()
}
