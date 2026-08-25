import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import './App.css'
import { EventStoreProvider, useEventStore, useTeams } from './store'

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

function GraphTab() {
  const { agents, toolCalls } = useEventStore()
  const agentList = Object.values(agents)
  const running = agentList.filter((a) => a.status === 'running').length

  return (
    <div>
      <h2>Graph view — coming soon</h2>
      <p>The agent interaction graph will render here once live data is wired up.</p>
      <ul className="stat-list">
        <li>
          <strong>{agentList.length}</strong> agent{agentList.length === 1 ? '' : 's'} seen ({running} running)
        </li>
        <li>
          <strong>{toolCalls.length}</strong> tool call{toolCalls.length === 1 ? '' : 's'} recorded
        </li>
      </ul>
    </div>
  )
}

const ALL_AGENTS = '__all__'

/** Distance (px) from the bottom within which we still consider the user "at the bottom". */
const AUTO_SCROLL_THRESHOLD = 24

function LogsTab() {
  const { agents, logs } = useEventStore()
  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS)
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLUListElement | null>(null)

  // Known agents to populate the filter dropdown — union of agents seen via
  // agent_start/stop and any agentId that has shown up on a log/error line
  // (covers the case where a log arrives before/without a lifecycle event).
  const agentIds = useMemo(() => {
    const ids = new Set(Object.keys(agents))
    for (const entry of logs) ids.add(entry.agentId)
    return Array.from(ids).sort()
  }, [agents, logs])

  const filteredLogs = useMemo(
    () => (agentFilter === ALL_AGENTS ? logs : logs.filter((entry) => entry.agentId === agentFilter)),
    [logs, agentFilter],
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
          {logs.length === 0 ? 'No log events yet — waiting for live data.' : 'No log events for this agent yet.'}
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

function TeamsTab() {
  const teams = useTeams()
  const teamNames = Object.keys(teams)

  return (
    <div>
      <h2>Teams view — coming soon</h2>
      <p>Team membership and ownership details will appear here.</p>
      {teamNames.length === 0 ? (
        <p className="empty-state">No team data yet — waiting for live data.</p>
      ) : (
        <ul className="team-list">
          {teamNames.map((team) => (
            <li key={team}>
              <strong>{team}</strong>: {teams[team].length} agent{teams[team].length === 1 ? '' : 's'}
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
      <DashboardShell />
    </EventStoreProvider>
  )
}

export default App
