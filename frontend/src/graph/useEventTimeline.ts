/**
 * Combines a one-time fetch of `/events/history` (events recorded before
 * this tab connected) with the live store's accumulated `rawEvents`
 * (events observed since) into a single chronological event list spanning
 * the whole session's recorded range — the data source for the Graph
 * timeline scrubber (issue #43). See `history.ts` for the fetch/merge/
 * reconstruct functions this wraps in a hook.
 */

import { useEffect, useMemo, useState } from 'react'
import { useEventStore } from '../store'
import type { LifecycleEvent } from '../types'
import { defaultHistoryUrl, fetchEventHistory, mergeEventHistory } from './history'

export interface EventTimeline {
  /** All known events (fetched history + live), sorted chronologically. */
  events: LifecycleEvent[]
  /** Epoch ms of the earliest recorded event, or null if none yet. */
  earliestMs: number | null
  /** Epoch ms of the latest recorded event, or null if none yet. */
  latestMs: number | null
  /** True while the initial `/events/history` fetch is in flight. */
  loading: boolean
}

export function useEventTimeline(historyUrl?: string): EventTimeline {
  const { rawEvents } = useEventStore()
  const [fetchedHistory, setFetchedHistory] = useState<LifecycleEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchEventHistory(historyUrl ?? defaultHistoryUrl()).then((events) => {
      if (cancelled) return
      setFetchedHistory(events)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // Only re-fetch if the caller explicitly changes the URL — this is a
    // one-time seed of "history before this tab connected", not a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyUrl])

  const events = useMemo(() => mergeEventHistory(fetchedHistory, rawEvents), [fetchedHistory, rawEvents])

  const { earliestMs, latestMs } = useMemo(() => {
    if (events.length === 0) return { earliestMs: null, latestMs: null }
    let min = Infinity
    let max = -Infinity
    for (const event of events) {
      const at = Date.parse(event.timestamp)
      if (Number.isNaN(at)) continue
      if (at < min) min = at
      if (at > max) max = at
    }
    if (min === Infinity) return { earliestMs: null, latestMs: null }
    return { earliestMs: min, latestMs: max }
  }, [events])

  return { events, earliestMs, latestMs, loading }
}
