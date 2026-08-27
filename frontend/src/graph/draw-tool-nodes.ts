/**
 * Tool node rendering (issue #40) — the small squares tool calls land on,
 * matching the pre-#40 `.graph-tool-rect` look.
 */

import { COLORS } from './colors'
import { TOOL_SIZE, toolLabel, type Point } from './layout'

export function drawToolNode(ctx: CanvasRenderingContext2D, tool: string, pos: Point, labelColor: string, active: boolean) {
  const half = TOOL_SIZE / 2
  ctx.save()
  ctx.beginPath()
  const radius = 4
  ctx.moveTo(pos.x - half + radius, pos.y - half)
  ctx.arcTo(pos.x + half, pos.y - half, pos.x + half, pos.y + half, radius)
  ctx.arcTo(pos.x + half, pos.y + half, pos.x - half, pos.y + half, radius)
  ctx.arcTo(pos.x - half, pos.y + half, pos.x - half, pos.y - half, radius)
  ctx.arcTo(pos.x - half, pos.y - half, pos.x + half, pos.y - half, radius)
  ctx.closePath()
  ctx.fillStyle = active ? 'rgba(217, 119, 6, 0.16)' : COLORS.toolFill
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = active ? COLORS.edgePending : COLORS.toolStroke
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.fillStyle = labelColor
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(toolLabel(tool), pos.x, pos.y + half + 4)
  ctx.restore()
}
