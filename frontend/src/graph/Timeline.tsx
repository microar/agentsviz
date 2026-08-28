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
 */

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
}

export function Timeline({ earliestMs, latestMs, scrubAtMs, onScrub, disabled }: TimelineProps) {
  const hasRange = earliestMs !== null && latestMs !== null && latestMs > earliestMs
  const min = earliestMs ?? 0
  const max = latestMs ?? 1
  const value = scrubAtMs ?? max
  const isHistory = scrubAtMs !== null

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
      <div className="graph-timeline-status" role="status">
        {isHistory ? (
          <span className="graph-timeline-badge graph-timeline-badge--history">
            VIEWING PAST — {formatClock(value)} — click Live to return
          </span>
        ) : (
          <span className="graph-timeline-badge graph-timeline-badge--live">LIVE</span>
        )}
      </div>
    </div>
  )
}
