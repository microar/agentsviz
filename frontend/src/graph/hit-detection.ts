/**
 * Click/hover picking against canvas coordinates (issue #40).
 *
 * There are no DOM click targets on a `<canvas>`, so clicking an agent node
 * to open the detail drawer (issue #12) needs manual hit-testing: convert
 * the click's screen coordinates to world coordinates via the camera (see
 * useCanvasCamera.ts), then find the nearest agent node whose radius
 * contains that point.
 */

import { AGENT_RADIUS, type Point } from './layout'

const HIT_PADDING = 4 // slightly forgiving beyond the drawn radius, esp. for touch

export function hitTestAgent(worldPoint: Point, agentPositions: Map<string, Point>, agentIds: string[]): string | null {
  const maxDistSq = (AGENT_RADIUS + HIT_PADDING) ** 2
  let closestId: string | null = null
  let closestDistSq = Infinity

  for (const id of agentIds) {
    const pos = agentPositions.get(id)
    if (!pos) continue
    const dx = pos.x - worldPoint.x
    const dy = pos.y - worldPoint.y
    const distSq = dx * dx + dy * dy
    if (distSq <= maxDistSq && distSq < closestDistSq) {
      closestDistSq = distSq
      closestId = id
    }
  }

  return closestId
}
