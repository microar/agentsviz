import { useState } from 'react'
import './App.css'

type TabId = 'graph' | 'logs' | 'teams'

const TABS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'logs', label: 'Logs' },
  { id: 'teams', label: 'Teams' },
]

const PLACEHOLDER_COPY: Record<TabId, { title: string; body: string }> = {
  graph: {
    title: 'Graph view — coming soon',
    body: 'The agent interaction graph will render here once live data is wired up.',
  },
  logs: {
    title: 'Logs view — coming soon',
    body: 'Streaming logs from agent runs will appear here.',
  },
  teams: {
    title: 'Teams view — coming soon',
    body: 'Team membership and ownership details will appear here.',
  },
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('graph')
  const { title, body } = PLACEHOLDER_COPY[activeTab]

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>AgentsViz</h1>
        <p className="app-subtitle">Agent activity dashboard</p>
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
        <h2>{title}</h2>
        <p>{body}</p>
      </main>
    </div>
  )
}

export default App
