import { useState, type ComponentType } from 'react'
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

function LogsTab() {
  const { logs } = useEventStore()

  return (
    <div>
      <h2>Logs view — coming soon</h2>
      <p>Streaming logs from agent runs will appear here.</p>
      {logs.length === 0 ? (
        <p className="empty-state">No log events yet — waiting for live data.</p>
      ) : (
        <ul className="log-list">
          {logs
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.id} className={`log-entry log-entry--${entry.kind}`}>
                <span className="log-entry-time">{entry.timestamp}</span>
                <span className="log-entry-agent">{entry.agentId}</span>
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
