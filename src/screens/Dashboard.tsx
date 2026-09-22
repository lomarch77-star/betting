import { EquityChart, Sparkline } from '../components/Charts';
import { Badge, Card, ChangeBadge, Empty, Row, Stat } from '../components/ui';
import { useAppState, useNow, useOnline, useStore } from '../state/StoreProvider';
import { MARKETS, marketById } from '../lib/data/markets';
import { fmtAgo, fmtMoney, fmtPct, fmtPrice, fmtQty, fmtSigned, tone } from '../lib/format';
import { equityOf } from '../lib/engine';
import { positionViews } from '../lib/agent';

export function Dashboard({ onOpenMarket }: { onOpenMarket: (marketId: string) => void }) {
  const store = useStore();
  const state = useAppState();
  const now = useNow();
  const online = useOnline();

  const { agent, tickers, candles } = state;
  const prices = Object.fromEntries(
    Object.entries(tickers).map(([id, t]) => [id, t.price]),
  ) as Record<string, number>;

  const equity = equityOf(agent.portfolio, prices);
  const start = agent.risk.startingCash;
  const totalPnl = equity - start;
  const totalPct = start > 0 ? (totalPnl / start) * 100 : 0;

  const views = positionViews(agent.portfolio, prices, agent.risk);
  const openPnl = views.reduce((a, v) => a + v.pnl, 0);
  const realised = agent.portfolio.trades.reduce((a, t) => a + t.pnl, 0);
  const wins = agent.portfolio.trades.filter((t) => t.pnl > 0).length;

  return (
    <div className="screen">
      {/* Three distinct situations, three distinct messages: a dead network, a
          deliberate offline setting, and live sources that have all failed. */}
      {!online && !state.offline && (
        <div className="banner banner-warn">
          No network — falling back to the deterministic simulator. The agent keeps trading paper
          money and will resume live prices automatically.
        </div>
      )}
      {state.offline && (
        <div className="banner banner-warn">
          Offline mode is on — prices come from the deterministic simulator. Turn it off in Setup to
          use live exchange data.
        </div>
      )}
      {online && !state.offline && state.degraded && (
        <div className="banner banner-warn">
          Every live exchange is unreachable
          {state.lastError ? ` (${state.lastError})` : ''} — using simulated prices. Your cash is
          still paper, nothing is at risk.
        </div>
      )}

      <Card className="hero">
        <div className="hero-top">
          <div>
            <span className="hero-label">Paper equity</span>
            <span className="hero-value">{fmtMoney(equity)}</span>
          </div>
          <div className="hero-right">
            <span className={`hero-pnl ${tone(totalPnl)}`}>{fmtSigned(totalPnl)}</span>
            <span className={`hero-pct ${tone(totalPnl)}`}>{fmtPct(totalPct)}</span>
          </div>
        </div>

        <EquityChart points={agent.equityCurve} />

        <div className="stat-grid">
          <Stat label="Cash" value={fmtMoney(agent.portfolio.cash)} />
          <Stat
            label="Open P&L"
            value={fmtSigned(openPnl)}
            valueTone={tone(openPnl)}
            sub={`${views.length}/${agent.risk.maxOpenPositions} slots`}
          />
          <Stat
            label="Realised"
            value={fmtSigned(realised)}
            valueTone={tone(realised)}
            sub={`${agent.portfolio.trades.length} trades`}
          />
          <Stat
            label="Win rate"
            value={
              agent.portfolio.trades.length
                ? `${Math.round((wins / agent.portfolio.trades.length) * 100)}%`
                : '—'
            }
          />
        </div>
      </Card>

      <Card
        title="Agent"
        actions={
          agent.halted ? (
            <Badge kind="neg">HALTED</Badge>
          ) : agent.running ? (
            <Badge kind="live">RUNNING</Badge>
          ) : (
            <Badge kind="neutral">STOPPED</Badge>
          )
        }
      >
        <div className="btn-row">
          <button
            className={`btn ${agent.running ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => store.setRunning(!agent.running)}
            disabled={agent.halted}
          >
            {agent.running ? 'Stop agent' : 'Start agent'}
          </button>
          <button className="btn" onClick={() => void store.refresh()} disabled={state.refreshing}>
            {state.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {agent.halted && (
            <button className="btn btn-primary" onClick={() => store.resume()}>
              Resume
            </button>
          )}
        </div>

        {agent.halted && (
          <div className="banner banner-neg">
            Risk halt: {agent.haltReason} All positions were flattened. Fix your risk settings, then
            resume.
          </div>
        )}

        <div className="meta-line">
          <span>
            Data: <strong>{state.degraded ? 'simulator' : state.liveSource}</strong>
          </span>
          <span>
            Timeframe: <strong>{state.timeframe}</strong>
          </span>
          <span>
            Last tick: <strong>{agent.lastTickAt ? fmtAgo(agent.lastTickAt, now) : 'never'}</strong>
          </span>
        </div>
      </Card>

      <Card title="Positions" subtitle={`${views.length} open`}>
        {views.length === 0 ? (
          <Empty>No open positions. The agent enters when every enabled rule lines up.</Empty>
        ) : (
          views.map((v) => (
            <div className="position" key={v.marketId}>
              <Row
                left={v.marketId}
                sub={`${fmtQty(v.qty)} @ ${fmtPrice(v.entryPrice)}`}
                right={
                  <div className="position-right">
                    <span className={`pos-pnl ${tone(v.pnl)}`}>{fmtSigned(v.pnl)}</span>
                    <span className={`pos-pct ${tone(v.pnl)}`}>{fmtPct(v.pnlPct)}</span>
                  </div>
                }
              />
              <div className="bracket-line">
                <span>Stop {fmtPrice(v.stopLoss)}</span>
                <span>Mark {fmtPrice(v.price)}</span>
                <span>Target {fmtPrice(v.takeProfit)}</span>
              </div>
              <button className="btn btn-small" onClick={() => store.closeNow(v.marketId)}>
                Close now
              </button>
            </div>
          ))
        )}
      </Card>

      <Card title="Watchlist" subtitle="Tap to inspect the rules">
        {state.watchlist.map((id) => {
          const t = tickers[id];
          const market = marketById(id);
          const series = (candles[id] ?? []).slice(-40).map((c) => c.c);
          return (
            <button className="watch-row" key={id} onClick={() => onOpenMarket(id)}>
              <div className="watch-left">
                <span className="watch-name">{market?.name ?? id}</span>
                <span className="watch-id">{id}</span>
              </div>
              <Sparkline values={series} />
              <div className="watch-right">
                <span className="watch-price">{t ? fmtPrice(t.price) : '—'}</span>
                <ChangeBadge value={t?.change24hPct ?? NaN} />
              </div>
            </button>
          );
        })}
      </Card>

      <Card title="Add markets">
        <div className="chip-row">
          {MARKETS.filter((m) => !state.watchlist.includes(m.id)).map((m) => (
            <button key={m.id} className="chip" onClick={() => store.toggleWatch(m.id)}>
              + {m.id}
            </button>
          ))}
          {MARKETS.every((m) => state.watchlist.includes(m.id)) && (
            <Empty>Every market is already on the watchlist.</Empty>
          )}
        </div>
      </Card>
    </div>
  );
}
