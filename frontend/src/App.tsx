import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import './App.css'
import { EventStoreProvider, useEventStore } from './store'
import { GraphTab } from './Graph'
import { TeamsTab } from './Teams'
import { agentLabel } from './graph/labels'
import {
  ALL_SESSIONS,
  ALL_TEAMS,
  computeVisibleAgentIds,
  DashboardFilterContext,
  listSessionRoots,
  listTeams,
  loadPersistedSelection,
  loadSeenScopes,
  recordSeenScopes,
  resolveSelection,
  savePersistedSelection,
  saveSeenScopes,
  useDashboardFilter,
  type DashboardFilterValue,
  type FilterSelection,
} from './filterModel'

type TabId = 'graph' | 'logs' | 'teams'

const TABS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'logs', label: 'Logs' },
  { id: 'teams', label: 'Teams' },
]

function ConnectionBadge() {
  const { connectionStatus } = useEventStore()
  return (
    <span className={`connection-badge connection-badge--${connectionStatus}`}>
      {connectionStatus === 'open' ? 'connected' : connectionStatus}
    </span>
  )
}

const ALL_AGENTS = '__all__'

/** Distance (px) from the bottom within which we still consider the user "at the bottom". */
const AUTO_SCROLL_THRESHOLD = 24

/**
 * Shared team/session selection (issue #73). Holds the *raw* pick (so a
 * team that's momentarily absent — e.g. before the WS snapshot lands on a
 * fresh reload — is restored once it reappears) and hands consumers the
 * *resolved* selection plus the live dropdown option lists. Persisted to
 * localStorage on every change; `loadPersistedSelection` /
 * `savePersistedSelection` swallow storage failures.
 */
function DashboardFilterProvider({ children }: { children: ReactNode }) {
  const { agents, logs } = useEventStore()
  const [raw, setRaw] = useState<FilterSelection>(loadPersistedSelection)

  useEffect(() => {
    savePersistedSelection(raw)
  }, [raw])

  // Every team/session root this browser has ever seen (issue: a finished
  // run's team must stay selectable). Seeded from localStorage so it
  // survives reloads and server restarts, then grown during render via the
  // React "adjust state while rendering" pattern — `recordSeenScopes`
  // returns the same identity when nothing is new, so the guarded setState
  // can't loop.
  const [seen, setSeen] = useState(loadSeenScopes)
  const nextSeen = recordSeenScopes(seen, agents, logs)
  if (nextSeen !== seen) setSeen(nextSeen)

  useEffect(() => {
    saveSeenScopes(seen)
  }, [seen])

  const value = useMemo<DashboardFilterValue>(() => {
    const resolved = resolveSelection(raw, agents, logs, seen)
    return {
      ...resolved,
      teams: listTeams(agents, logs, seen),
      sessionRoots: listSessionRoots(resolved.team, agents, logs, seen),
      // Changing the team always drops back to "All sessions" — a root from
      // the previous team is meaningless under the new one.
      setTeam: (team: string) => setRaw({ team, sessionRoot: ALL_SESSIONS }),
      setSessionRoot: (sessionRoot: string) => setRaw((prev) => ({ ...prev, sessionRoot })),
    }
  }, [raw, agents, logs, seen])

  return <DashboardFilterContext.Provider value={value}>{children}</DashboardFilterContext.Provider>
}

/** The two header dropdowns. Dropdown 2 (Session) only renders once a team is picked. */
function DashboardFilterControls() {
  const { team, sessionRoot, teams, sessionRoots, setTeam, setSessionRoot } = useDashboardFilter()
  return (
    <div className="dashboard-filter">
      <label className="dashboard-filter-field">
        Team:{' '}
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value={ALL_TEAMS}>All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {team !== ALL_TEAMS && (
        <label className="dashboard-filter-field">
          Session:{' '}
          <select value={sessionRoot} onChange={(e) => setSessionRoot(e.target.value)}>
            <option value={ALL_SESSIONS}>All sessions</option>
            {sessionRoots.map((root) => (
              <option key={root} value={root}>
                {agentLabel(root)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

function LogsTab() {
  const { agents, logs } = useEventStore()
  const { team, sessionRoot } = useDashboardFilter()
  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS)
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLUListElement | null>(null)

  // Team/session scope from the header (issue #73). null => no team picked,
  // so nothing is hidden.
  const visibleIds = useMemo(
    () => computeVisibleAgentIds({ team, sessionRoot }, agents, logs),
    [team, sessionRoot, agents, logs],
  )

  // The per-agent dropdown below is scoped to that visible set, so a pick
  // left over from a previous team/session would silently hide every line —
  // reset it to "All agents" whenever the header selection changes. Done as
  // a render-time reset (the React "adjust state when a prop changes"
  // pattern) rather than an effect so it lands in the same commit.
  const selectionKey = JSON.stringify([team, sessionRoot])
  const [lastSelectionKey, setLastSelectionKey] = useState(selectionKey)
  if (lastSelectionKey !== selectionKey) {
    setLastSelectionKey(selectionKey)
    setAgentFilter(ALL_AGENTS)
  }

  // Known agents to populate the filter dropdown — union of agents seen via
  // agent_start/stop and any agentId that has shown up on a log/error line
  // (covers the case where a log arrives before/without a lifecycle event),
  // restricted to the header's visible set.
  const agentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(agents)) if (!visibleIds || visibleIds.has(id)) ids.add(id)
    for (const entry of logs) if (!visibleIds || visibleIds.has(entry.agentId)) ids.add(entry.agentId)
    return Array.from(ids).sort()
  }, [agents, logs, visibleIds])

  const filteredLogs = useMemo(
    () =>
      logs.filter((entry) => {
        if (visibleIds && !visibleIds.has(entry.agentId)) return false
        return agentFilter === ALL_AGENTS || entry.agentId === agentFilter
      }),
    [logs, visibleIds, agentFilter],
  )

  // Auto-scroll to the bottom whenever new lines arrive, unless the user has
  // scrolled up (paused) to read earlier lines.
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [filteredLogs, autoScroll])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setAutoScroll(distanceFromBottom <= AUTO_SCROLL_THRESHOLD)
  }

  function resumeAutoScroll() {
    setAutoScroll(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div>
      <h2>Logs</h2>
      <div className="logs-toolbar">
        <label className="logs-filter">
          Agent:{' '}
          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
            <option value={ALL_AGENTS}>All agents</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="logs-scroll-toggle" onClick={autoScroll ? () => setAutoScroll(false) : resumeAutoScroll}>
          {autoScroll ? 'Pause scroll' : 'Resume auto-scroll'}
        </button>
      </div>

      {filteredLogs.length === 0 ? (
        <p className="empty-state">
          {logs.length === 0
            ? 'No log events yet — waiting for live data.'
            : 'No log events match the current filter yet.'}
        </p>
      ) : (
        <ul className="log-list" ref={scrollRef} onScroll={handleScroll}>
          {filteredLogs.map((entry) => (
            <li key={entry.id} className={`log-entry log-entry--${entry.kind}`}>
              <span className="log-entry-time">{entry.timestamp}</span>
              <span className="log-entry-agent">{entry.agentId}</span>
              {entry.kind === 'error' && <span className="log-entry-badge">ERROR</span>}
              <span className="log-entry-message">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const TAB_COMPONENTS: Record<TabId, ComponentType> = {
  graph: GraphTab,
  logs: LogsTab,
  teams: TeamsTab,
}

function DashboardShell() {
  const [activeTab, setActiveTab] = useState<TabId>('graph')
  const ActiveTabComponent = TAB_COMPONENTS[activeTab]

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>AgentsViz</h1>
        <p className="app-subtitle">
          Agent activity dashboard <ConnectionBadge />
        </p>
        <DashboardFilterControls />
      </header>

      <nav className="tab-bar" role="tablist" aria-label="Dashboard sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.id}
            className={`tab-button${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="tab-panel" role="tabpanel">
        <ActiveTabComponent />
      </main>
    </div>
  )
}

function App() {
  return (
    <EventStoreProvider>
      <DashboardFilterProvider>
        <DashboardShell />
      </DashboardFilterProvider>
    </EventStoreProvider>
  )
}

export default App
