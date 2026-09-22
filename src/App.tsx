import { useEffect, useState } from 'react';
import { Dashboard } from './screens/Dashboard';
import { Agent } from './screens/Agent';
import { Portfolio } from './screens/Portfolio';
import { Backtest } from './screens/Backtest';
import { Settings } from './screens/Settings';
import { useAppState } from './state/StoreProvider';

type Tab = 'dashboard' | 'agent' | 'portfolio' | 'backtest' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Desk', icon: '◈' },
  { id: 'agent', label: 'Agent', icon: '◉' },
  { id: 'portfolio', label: 'Book', icon: '▤' },
  { id: 'backtest', label: 'Test', icon: '◫' },
  { id: 'settings', label: 'Setup', icon: '⚙' },
];

export function App() {
  const state = useAppState();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [marketId, setMarketId] = useState(state.watchlist[0] ?? 'BTC/USDT');

  // Keep the inspected market valid if the watchlist changes underneath us.
  useEffect(() => {
    if (!state.watchlist.includes(marketId) && state.watchlist.length) {
      setMarketId(state.watchlist[0]);
    }
  }, [state.watchlist, marketId]);

  // Reflect the agent's state in the phone's status bar colour.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute('content', state.agent.halted ? '#3b0d17' : '#0b1020');
  }, [state.agent.halted]);

  const openMarket = (id: string) => {
    setMarketId(id);
    setTab('agent');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">PaperDesk</span>
        </div>
        <div className="topbar-status">
          <span
            className={`dot ${state.agent.halted ? 'dot-neg' : state.agent.running ? 'dot-live' : 'dot-idle'}`}
          />
          <span className="topbar-text">
            {state.agent.halted ? 'halted' : state.agent.running ? 'live' : 'stopped'}
          </span>
        </div>
      </header>

      <main className="main">
        {tab === 'dashboard' && <Dashboard onOpenMarket={openMarket} />}
        {tab === 'agent' && <Agent marketId={marketId} />}
        {tab === 'portfolio' && <Portfolio />}
        {tab === 'backtest' && <Backtest />}
        {tab === 'settings' && <Settings />}
      </main>

      <nav className="tabbar" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
