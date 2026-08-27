/**
 * Client-side history reconstruction for the Graph timeline scrubber
 * (issue #43).
 *
 * Architecture note (documented per the issue's request): reconstruction
 * happens entirely client-side rather than as a server-side
 * `?until=<timestamp>` endpoint. The server exposes one dumb read-only
 * route, `GET /events/history` (see server/src/index.ts), that returns the
 * current run's raw recorded events as a JSON array — no folding, no query
 * params. The frontend fetches that array once, merges it with whatever
 * live events have arrived over the WebSocket since this tab connected
 * (see `EventStoreState.rawEvents` in ../store.tsx), and re-folds the
 * combined list through the *exact same* `applyEvent` reducer the live
 * store already uses (exported from ../store.tsx) every time the user
 * drags the scrubber. This avoids a network round-trip per drag frame and
 * avoids maintaining two separate event-folding implementations (frontend
 * live reducer vs. a hypothetical server reconstruction endpoint) — the
 * "small pure reducer, duplicated as little as possible" option called out
 * in the issue, since the frontend already had one.
 */

import { applyEvent, initialState, type EventStoreState } from '../store'
import { isLifecycleEvent, type LifecycleEvent } from '../types'

/** Resolves the history endpoint URL, honoring VITE_HISTORY_URL like ws.ts's defaultWsUrl. */
export function defaultHistoryUrl(): string {
  const fromEnv = import.meta.env.VITE_HISTORY_URL as string | undefined
  if (fromEnv) return fromEnv

  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http'
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  return `${protocol}://${host}:4000/events/history`
}

/** Fetches the current run's recorded event stream. Returns `[]` on any failure. */
export async function fetchEventHistory(url: string): Promise<LifecycleEvent[]> {
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data: unknown = await res.json()
    if (!Array.isArray(data)) return []
    return data.filter(isLifecycleEvent)
  } catch {
    return []
  }
}

/** Stable dedupe key for merging fetched history with live-observed raw events. */
function eventKey(event: LifecycleEvent): string {
  return `${event.type}|${event.timestamp}|${event.agentId}|${event.tool ?? ''}|${event.caller ?? ''}|${event.status ?? ''}`
}

/**
 * Merges fetched history (events recorded before this tab's fetch) with
 * live-observed raw events (events the WS store has applied since), sorted
 * chronologically and de-duplicated for the overlap window where both
 * sources may contain the same event.
 */
export function mergeEventHistory(fetched: LifecycleEvent[], live: LifecycleEvent[]): LifecycleEvent[] {
  const seen = new Set<string>()
  const merged: LifecycleEvent[] = []
  for (const event of [...fetched, ...live]) {
    const key = eventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  merged.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  return merged
}

/**
 * Folds `events` (in chronological order) into store state as of `untilMs`
 * (inclusive) — a point-in-time snapshot, reusing the live store's own
 * `applyEvent` reducer rather than a separate implementation. Events with
 * an unparseable timestamp are excluded (there's no defensible "as of"
 * position for them).
 */
export function reconstructStateAt(events: LifecycleEvent[], untilMs: number): EventStoreState {
  let state = initialState
  for (const event of events) {
    const at = Date.parse(event.timestamp)
    if (Number.isNaN(at) || at > untilMs) continue
    state = applyEvent(state, event)
  }
  return state
}
