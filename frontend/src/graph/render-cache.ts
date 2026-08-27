/**
 * Perf: avoid recomputing static geometry every animation frame (issue
 * #40's "render-cache" concern).
 *
 * Two things would otherwise get recomputed 60x/sec for no reason:
 *  1. World-space bounds (used to size/center the initial camera) — these
 *     only depend on the current set of node positions, which only change
 *     when a node is added (see layout.ts's own id-set memoization). We
 *     memoize on the same joined-id-list key here.
 *  2. The backing-store (device-pixel) size of the `<canvas>` — resizing a
 *     canvas element is expensive (it clears and reallocates the bitmap),
 *     so it must only happen when the CSS size or devicePixelRatio
 *     actually changed, never unconditionally at the top of the render
 *     loop.
 *
 * Per-frame work (fade alpha, pulse phase, particle position, camera
 * transform) is unavoidably dynamic and stays in the render loop itself
 * (GraphCanvas.tsx) — this module only caches the parts that aren't.
 */

import { useMemo } from 'react'
import type { Point } from './layout'

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function useWorldBounds(positions: Map<string, Point>[], padding: number): Bounds {
  const key = positions.map((m) => [...m.entries()].map(([id, p]) => `${id}:${p.x},${p.y}`).join(',')).join('|')
  return useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const map of positions) {
      for (const p of map.values()) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    }
    return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, padding])
}

/**
 * Resizes a canvas's backing store to match its CSS box at the current
 * devicePixelRatio, but only when something actually changed — returns
 * true if a resize happened (caller may want to know, e.g. to re-derive an
 * initial camera fit) so callers can skip the (expensive) clear+realloc on
 * every frame.
 */
export function syncCanvasSize(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): boolean {
  const dpr = window.devicePixelRatio || 1
  const targetW = Math.max(1, Math.round(cssWidth * dpr))
  const targetH = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width === targetW && canvas.height === targetH) return false
  canvas.width = targetW
  canvas.height = targetH
  return true
}
