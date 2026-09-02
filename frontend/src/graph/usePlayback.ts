/**
 * History-playback transport for the Graph timeline scrubber (issue #85).
 *
 * Issue #43 gave the Graph tab a scrubber that reconstructs a point-in-time
 * snapshot from `scrubAtMs`; issue #85 makes that position *move on its own*.
 * Once the user has scrubbed into the past, they can play the recorded event
 * stream forward from that point, pause it, and fast-forward / rewind at
 * 1×, 5×, or 10×. Each animation frame this hook advances `scrubAtMs` by the
 * real elapsed wall-clock time scaled by `speed * direction`, so at 1×
 * forward one second of playback advances history by one second of recorded
 * time. `Graph.tsx` re-runs `reconstructStateAt` on every `scrubAtMs` change,
 * so the graph animates through history as the position moves.
 *
 * Follows the same ref-driven rAF pattern as `GraphCanvas` / `useCanvasCamera`
 * (issue #40): everything the loop needs — bounds, speed, direction, the
 * float position accumulator — lives in refs it reads directly, so changing
 * speed or direction mid-play never tears the loop down, and the loop never
 * forces a React re-render beyond the throttled `onScrub` position emit.
 *
 * `requestAnimationFrame` (not `setInterval`) per the issue: it stays in
 * lockstep with paint and auto-throttles in background tabs, so a
 * backgrounded playback doesn't race ahead on a burst of catch-up ticks.
 *
 * Reconstruction-cost note (issue #85): `reconstructStateAt` folds the whole
 * event list from scratch on every `scrubAtMs` change — O(events) per call.
 * Rather than emit a new position (and thus a reconstruction) on every one
 * of the ~60 frames/sec, the loop advances a float accumulator every frame
 * but only pushes it out through `onScrub` at ~15 Hz (`EMIT_INTERVAL_MS`).
 * The scrubber handle is bound to that same emitted value, so handle and
 * graph step together ~15×/sec — visually smooth, but a bounded
 * reconstruction load on large streams.
 *
 * Playback is local-only UI state, exactly like `scrubAtMs` itself — it is
 * never sent over the WebSocket.
 *
 * `prefers-reduced-motion` (issue #85): playback is strictly user-initiated
 * (they press Play), so it still runs when reduced motion is requested —
 * there is just no extra easing / momentum flourish layered on top; the
 * position moves linearly with real time.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Playback rates, forward or reverse. Issue #85 fixes these three. */
export type PlaybackSpeed = 1 | 5 | 10
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 5, 10]

/** +1 = fast-forward through history, -1 = rewind. */
export type PlaybackDirection = 1 | -1

/** How often the rAF loop pushes its float position out through `onScrub`
 *  (and thus triggers a `reconstructStateAt`) — see the module comment. */
const EMIT_INTERVAL_MS = 66

export interface PlaybackControls {
  /** True while the rAF loop is advancing the scrub position. */
  playing: boolean
  speed: PlaybackSpeed
  direction: PlaybackDirection
  /** Start advancing from the current `scrubAtMs`. No-op outside history mode. */
  play: () => void
  /** Freeze at the current position, staying in history mode. */
  pause: () => void
  /** Play when paused, pause when playing. */
  toggle: () => void
  setSpeed: (speed: PlaybackSpeed) => void
  setDirection: (direction: PlaybackDirection) => void
}

export interface UsePlaybackArgs {
  /** Current scrub position (epoch ms), or null in live mode. */
  scrubAtMs: number | null
  /** Session bounds from `useEventTimeline`; null before any event is seen. */
  earliestMs: number | null
  latestMs: number | null
  /**
   * Same setter the scrubber uses. The loop calls it with a rounded epoch-ms
   * position while playing, and with `null` when forward playback reaches the
   * live edge (matching the scrubber's own "snap to live edge → live" rule).
   */
  onScrub: (ms: number | null) => void
}

export function usePlayback({ scrubAtMs, earliestMs, latestMs, onScrub }: UsePlaybackArgs): PlaybackControls {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  const [direction, setDirection] = useState<PlaybackDirection>(1)

  // Live values for the rAF loop to read without being a dependency of the
  // loop effect (which is keyed on `playing` alone, so it starts/stops but
  // never restarts on a speed/direction/bounds change). Kept in sync from a
  // post-commit effect rather than assigned during render, so the loop
  // always reads the values from the latest paint.
  const scrubAtMsRef = useRef(scrubAtMs)
  const earliestMsRef = useRef(earliestMs)
  const latestMsRef = useRef(latestMs)
  const speedRef = useRef(speed)
  const directionRef = useRef(direction)
  const onScrubRef = useRef(onScrub)
  useEffect(() => {
    scrubAtMsRef.current = scrubAtMs
    earliestMsRef.current = earliestMs
    latestMsRef.current = latestMs
    speedRef.current = speed
    directionRef.current = direction
    onScrubRef.current = onScrub
  })

  // Float ms accumulator. `scrubAtMs` state is integer-rounded on every emit;
  // integrating the sub-millisecond-per-frame deltas here instead keeps 1×
  // playback from drifting slow over a long session.
  const positionRef = useRef<number>(scrubAtMs ?? 0)

  const pause = useCallback(() => setPlaying(false), [])
  const play = useCallback(() => {
    // Only meaningful in history mode — there is nothing to play forward from
    // once you're already live.
    if (scrubAtMsRef.current === null) return
    setPlaying(true)
  }, [])
  const toggle = useCallback(() => {
    if (scrubAtMsRef.current === null) return
    setPlaying((p) => !p)
  }, [])

  // Leaving history mode always stops playback, but that never needs its own
  // effect: every transition to live mode already pauses first — the Live
  // button and a drag to the live edge both go through `Graph.tsx`'s
  // `handleManualScrub` (which calls `pause()`), and forward playback
  // reaching the edge calls `setPlaying(false)` itself in the loop below.
  // The loop's own `startAt === null` guard is the backstop.

  // The playback loop. Started when `playing` flips true, cancelled on pause
  // / unmount. Seeds the accumulator from wherever the handle currently sits
  // so pressing Play after a manual drag resumes from the drop point.
  useEffect(() => {
    if (!playing) return
    const startAt = scrubAtMsRef.current
    if (startAt === null) return

    positionRef.current = startAt
    let rafId = 0
    let lastFrameMs = performance.now()
    let lastEmitMs = lastFrameMs

    function frame(now: number) {
      const realDeltaMs = now - lastFrameMs
      lastFrameMs = now

      const earliest = earliestMsRef.current
      const latest = latestMsRef.current
      if (earliest === null || latest === null) {
        rafId = requestAnimationFrame(frame)
        return
      }

      // Core integration: history time advances by real elapsed time scaled
      // by the current speed and direction (issue #85).
      positionRef.current += realDeltaMs * speedRef.current * directionRef.current

      // Forward playback caught up to the live edge → stop and return to live
      // mode, exactly as dragging the handle to `max` does (issue #43).
      if (directionRef.current === 1 && positionRef.current >= latest) {
        setPlaying(false)
        onScrubRef.current(null)
        return
      }
      // Rewind hit session start → clamp there and stay paused in history
      // mode (the user can still play forward again from the start).
      if (directionRef.current === -1 && positionRef.current <= earliest) {
        positionRef.current = earliest
        setPlaying(false)
        onScrubRef.current(earliest)
        return
      }

      // Throttle the state write / reconstruction to ~15 Hz (see module
      // comment) while still integrating every frame above.
      if (now - lastEmitMs >= EMIT_INTERVAL_MS) {
        lastEmitMs = now
        onScrubRef.current(Math.round(positionRef.current))
      }

      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [playing])

  return { playing, speed, direction, play, pause, toggle, setSpeed, setDirection }
}
