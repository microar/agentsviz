/**
 * Timeline scrubber control (issue #43): a draggable handle along a
 * horizontal time axis spanning the session's recorded event range.
 * Dragging it left of the live edge puts the Graph tab into "history"
 * mode (see Graph.tsx); dragging back to the live edge, or clicking
 * "Live", resumes live WebSocket-driven rendering.
 *
 * Deliberately a plain `<input type="range">` rather than a custom
 * pointer-drag widget — it's natively keyboard/screen-reader accessible
 * (arrow keys, Home/End) for free, which a hand-rolled canvas or div-based
 * handle would have to reimplement.
 *
 * History playback (issue #85): when `playback` is supplied *and* the tab
 * is in history mode, a transport row appears below the scrubber — Play /
 * Pause, a Rewind / Forward direction toggle, and a 1× / 5× / 10× speed
 * selector. These drive `usePlayback`, which advances `scrubAtMs` over
 * wall-clock time so the graph animates through the recorded stream. The
 * controls are hidden entirely in live mode (nothing to play). Manually
 * dragging the handle, or clicking Live, pauses playback — that wiring
 * lives in `Graph.tsx` (the `onScrub` this component is handed already
 * pauses first).
 */

import type { PlaybackControls, PlaybackDirection, PlaybackSpeed } from './usePlayback'
import { PLAYBACK_SPEEDS } from './usePlayback'

function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour12: false })
}

export interface TimelineProps {
  earliestMs: number | null
  latestMs: number | null
  /** Current scrub position, or null when in live mode. */
  scrubAtMs: number | null
  onScrub: (ms: number | null) => void
  disabled?: boolean
  /**
   * History-playback transport (issue #85). Omitted → no transport UI at
   * all (the pre-#85 behaviour). Present → Play/Pause + rewind/ff + speed
   * are rendered, but only while `scrubAtMs !== null` (history mode).
   */
  playback?: PlaybackControls
}

export function Timeline({ earliestMs, latestMs, scrubAtMs, onScrub, disabled, playback }: TimelineProps) {
  const hasRange = earliestMs !== null && latestMs !== null && latestMs > earliestMs
  const min = earliestMs ?? 0
  const max = latestMs ?? 1
  const value = scrubAtMs ?? max
  const isHistory = scrubAtMs !== null
  const showTransport = playback !== undefined && isHistory

  function handleChange(raw: number) {
    // Snapping back to (or past) the live edge returns to live mode rather
    // than freezing on a scrub position that happens to equal "now".
    if (raw >= max) {
      onScrub(null)
      return
    }
    onScrub(raw)
  }

  return (
    <div className={`graph-timeline${isHistory ? ' graph-timeline--history' : ''}`}>
      <div className="graph-timeline-row">
        <span className="graph-timeline-label">{earliestMs !== null ? formatClock(min) : '—'}</span>
        <input
          type="range"
          className="graph-timeline-slider"
          min={min}
          max={max}
          value={value}
          step={1}
          disabled={disabled || !hasRange}
          onChange={(e) => handleChange(Number(e.target.value))}
          aria-label="Scrub graph state to a point in time"
        />
        <span className="graph-timeline-label">{latestMs !== null ? formatClock(max) : '—'}</span>
        <button
          type="button"
          className="graph-timeline-live-btn"
          onClick={() => onScrub(null)}
          disabled={!isHistory}
        >
          Live
        </button>
      </div>

      {/*
        Transport controls (issue #85) — history mode only. Real <button>s
        with aria-labels; the toggles carry aria-pressed so a screen reader
        announces the current play/direction/speed state. Keyboard operation
        is free (they're buttons).
      */}
      {showTransport && (
        <div className="graph-timeline-transport" role="group" aria-label="History playback controls">
          <button
            type="button"
            className="graph-transport-btn graph-transport-btn--play"
            aria-label={playback.playing ? 'Pause playback' : 'Play history from here'}
            aria-pressed={playback.playing}
            onClick={playback.toggle}
          >
            {playback.playing ? '❚❚ Pause' : '▶ Play'}
          </button>

          <span className="graph-transport-divider" aria-hidden="true" />

          <div className="graph-transport-dirs" role="group" aria-label="Playback direction">
            {([-1, 1] as PlaybackDirection[]).map((dir) => {
              const active = playback.direction === dir
              return (
                <button
                  key={dir}
                  type="button"
                  className={`graph-transport-btn graph-transport-btn--dir${active ? ' is-active' : ''}`}
                  aria-label={dir === -1 ? 'Rewind' : 'Fast-forward'}
                  aria-pressed={active}
                  onClick={() => playback.setDirection(dir)}
                >
                  {dir === -1 ? '⏪' : '⏩'}
                </button>
              )
            })}
          </div>

          <div className="graph-transport-speeds" role="group" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((sp: PlaybackSpeed) => {
              const active = playback.speed === sp
              return (
                <button
                  key={sp}
                  type="button"
                  className={`graph-transport-btn graph-transport-btn--speed${active ? ' is-active' : ''}`}
                  aria-label={`Playback speed ${sp} times`}
                  aria-pressed={active}
                  onClick={() => playback.setSpeed(sp)}
                >
                  {sp}×
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="graph-timeline-status" role="status">
        {isHistory ? (
          <span className="graph-timeline-badge graph-timeline-badge--history">
            VIEWING PAST — {formatClock(value)}
            {playback?.playing
              ? ` — ${playback.direction === -1 ? 'rewinding' : 'playing'} ${playback.speed}× — click Live to return`
              : ' — click Live to return'}
          </span>
        ) : (
          <span className="graph-timeline-badge graph-timeline-badge--live">LIVE</span>
        )}
      </div>
    </div>
  )
}
