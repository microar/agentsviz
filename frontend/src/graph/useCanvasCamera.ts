/**
 * Pan/zoom camera for the canvas graph (issue #40).
 *
 * Deliberately minimal — not agent-flow's exact camera feel, just enough to
 * be present and usable per the issue's acceptance criteria: drag to pan,
 * wheel/trackpad-pinch to zoom (desktop), and two-finger touch drag/pinch
 * to pan+zoom (mobile/tablet), all via the Pointer Events API so mouse and
 * touch share one code path.
 *
 * The camera is kept in a ref, not React state — it changes every frame
 * during a drag/pinch and is read by the render loop directly, so routing
 * it through `useState`/re-renders would be pure overhead (the canvas
 * already redraws continuously for the pulse/particle animations).
 * `getCamera`/`setCamera` are exposed for the render loop and for
 * hit-detection's screen-to-world conversion.
 */

import { useEffect, useRef } from 'react'
import type { Point } from './layout'

export interface Camera {
  /** World-space point currently centered under the canvas's top-left-relative origin offset. */
  x: number
  y: number
  scale: number
}

const MIN_SCALE = 0.3
const MAX_SCALE = 3

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export interface CanvasCameraHandle {
  getCamera: () => Camera
  setCamera: (camera: Camera) => void
  screenToWorld: (screenX: number, screenY: number) => Point
  /** True while the user is actively dragging/pinching — used to distinguish a click from a drag. */
  isInteracting: () => boolean
  /** True once the user has ever dragged/pinched/scrolled the camera — see GraphCanvas's auto-fit. */
  hasEverInteracted: () => boolean
  reset: () => void
}

export function useCanvasCamera(canvasRef: React.RefObject<HTMLCanvasElement | null>): CanvasCameraHandle {
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const draggedRef = useRef(false)
  const everInteractedRef = useRef(false)
  const pointersRef = useRef<Map<number, Point>>(new Map())
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null)

  const screenToWorld = (screenX: number, screenY: number): Point => {
    const cam = cameraRef.current
    return { x: (screenX - cam.x) / cam.scale, y: (screenY - cam.y) / cam.scale }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function pointFromEvent(e: PointerEvent): Point {
      const rect = canvas!.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    function midpoint(a: Point, b: Point): Point {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }

    function distance(a: Point, b: Point): number {
      return Math.hypot(a.x - b.x, a.y - b.y)
    }

    function onPointerDown(e: PointerEvent) {
      canvas!.setPointerCapture(e.pointerId)
      pointersRef.current.set(e.pointerId, pointFromEvent(e))
      draggedRef.current = false
      if (pointersRef.current.size === 2) {
        const pts = [...pointersRef.current.values()]
        pinchStartRef.current = { distance: distance(pts[0], pts[1]), scale: cameraRef.current.scale }
      }
    }

    function onPointerMove(e: PointerEvent) {
      const prev = pointersRef.current.get(e.pointerId)
      if (!prev) return
      const next = pointFromEvent(e)
      pointersRef.current.set(e.pointerId, next)

      if (pointersRef.current.size === 2 && pinchStartRef.current) {
        const pts = [...pointersRef.current.values()]
        const dist = distance(pts[0], pts[1])
        const mid = midpoint(pts[0], pts[1])
        const nextScale = clampScale(pinchStartRef.current.scale * (dist / pinchStartRef.current.distance))
        zoomAt(mid, nextScale)
        draggedRef.current = true
        everInteractedRef.current = true
        return
      }

      if (pointersRef.current.size === 1) {
        const dx = next.x - prev.x
        const dy = next.y - prev.y
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          draggedRef.current = true
          everInteractedRef.current = true
        }
        cameraRef.current = { ...cameraRef.current, x: cameraRef.current.x + dx, y: cameraRef.current.y + dy }
      }
    }

    function onPointerUp(e: PointerEvent) {
      pointersRef.current.delete(e.pointerId)
      if (pointersRef.current.size < 2) pinchStartRef.current = null
      // Leave draggedRef as-is until the caller (click handler) reads it —
      // it's reset on the next pointerdown.
    }

    function zoomAt(screenPoint: Point, nextScale: number) {
      const cam = cameraRef.current
      const worldPoint = { x: (screenPoint.x - cam.x) / cam.scale, y: (screenPoint.y - cam.y) / cam.scale }
      cameraRef.current = {
        scale: nextScale,
        x: screenPoint.x - worldPoint.x * nextScale,
        y: screenPoint.y - worldPoint.y * nextScale,
      }
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = canvas!.getBoundingClientRect()
      const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const zoomFactor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(screenPoint, clampScale(cameraRef.current.scale * zoomFactor))
      everInteractedRef.current = true
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [canvasRef])

  return {
    getCamera: () => cameraRef.current,
    setCamera: (camera) => {
      cameraRef.current = camera
    },
    screenToWorld,
    isInteracting: () => draggedRef.current,
    hasEverInteracted: () => everInteractedRef.current,
    reset: () => {
      cameraRef.current = { x: 0, y: 0, scale: 1 }
    },
  }
}
