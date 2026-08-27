/**
 * Stable node layout for the canvas graph (issue #40 / originally #7).
 *
 * Layout is deliberately NOT a physics/force simulation — those tend to
 * jitter and re-settle every time a node is added, which fails the "layout
 * doesn't jump erratically on updates" acceptance criterion carried over
 * from #7. Instead each node gets a permanent slot the first time its id is
 * seen (`useStableLayout` below), placed with a phyllotaxis (sunflower)
 * spiral: slot i sits at `radius = spacing * sqrt(i)`,
 * `angle = i * goldenAngle`. That formula only depends on a node's own
 * index, never on the total node count, so existing nodes never move when a
 * new one is assigned the next index — it just lands in the next open ring
 * position. Agents and tools get separate spirals (two clusters) so the
 * graph stays legible as an "agents call tools" graph.
 *
 * This is also this module's "render cache": positions are recomputed only
 * when the id set actually changes (memoized on the joined id list), never
 * once per animation frame. The canvas render loop (`GraphCanvas.tsx`)
 * reads the resulting position maps directly every frame without touching
 * this hook, so panning/zooming/pulsing/particle motion never re-runs the
 * layout math.
 */

import { useMemo, useRef } from 'react'

export const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5)) // ~137.5deg, in radians

export interface Point {
  x: number
  y: number
}

export function phyllotaxisPoint(index: number, center: Point, spacing: number): Point {
  const angle = index * GOLDEN_ANGLE_RAD
  const radius = spacing * Math.sqrt(index)
  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle),
  }
}

/**
 * Assigns each id a permanent index the first time it's seen (in a ref, so
 * it survives re-renders) and derives a phyllotaxis position from that
 * index. Existing ids keep their slot forever; only brand-new ids get a new
 * (always-next) index, so old nodes never move.
 */
export function useStableLayout(ids: string[], center: Point, spacing: number): Map<string, Point> {
  const slotsRef = useRef<Map<string, number>>(new Map())

  return useMemo(() => {
    const slots = slotsRef.current
    for (const id of ids) {
      if (!slots.has(id)) {
        slots.set(id, slots.size)
      }
    }
    const positions = new Map<string, Point>()
    for (const id of ids) {
      positions.set(id, phyllotaxisPoint(slots.get(id)!, center, spacing))
    }
    return positions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|'), center.x, center.y, spacing])
}

export const AGENT_CENTER: Point = { x: 260, y: 300 }
export const TOOL_CENTER: Point = { x: 660, y: 300 }
export const AGENT_SPACING = 30
export const TOOL_SPACING = 46
export const AGENT_RADIUS = 20
export const TOOL_SIZE = 22

export function agentLabel(agentId: string): string {
  return agentId.length > 14 ? `${agentId.slice(0, 13)}…` : agentId
}

export function toolLabel(tool: string): string {
  return tool.length > 12 ? `${tool.slice(0, 11)}…` : tool
}
