import { PnlBars } from '../components/Charts';
import { Badge, Card, Empty, Stat } from '../components/ui';
import { useAppState, useStore } from '../state/StoreProvider';
import {
  fmtDateTime,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtRatio,
  fmtSigned,
  tone,
} from '../lib/format';
import { equityOf, maxDrawdownPct, sharpeRatio, winStats } from '../lib/engine';
import { positionViews } from '../lib/agent';
import { BARS_PER_YEAR } from '../lib/data/markets';

export function Portfolio() {
  const store = useStore();
  const state = useAppState();
  const { agent } = state;

  const prices = Object.fromEntries(
    Object.entries(state.tickers).map(([id, t]) => [id, t.price]),
  ) as Record<string, number>;

  const equity = equityOf(agent.portfolio, prices);
  const trades = agent.portfolio.trades;
  const stats = winStats(trades);
  const views = positionViews(agent.portfolio, prices, agent.risk);
  const curve = agent.equityCurve.map((p) => p.equity);
  const drawdown = maxDrawdownPct(curve);
  const sharpe = sharpeRatio(curve, BARS_PER_YEAR[state.timeframe]);

  const start = agent.risk.startingCash;
  const feesPaid = trades.reduce((a, t) => {
    const gross = (t.exitPrice - t.entryPrice) * t.qty;
    return a + Math.abs(gross - t.pnl);
  }, 0);

  return (
    <div className="screen">
      <Card title="Performance" subtitle={`${trades.length} closed trades`}>
        <div className="stat-grid">
          <Stat label="Equity" value={fmtMoney(equity)} />
          <Stat
            label="Total return"
            value={fmtPct(((equity - start) / start) * 100)}
            valueTone={tone(equity - start)}
          />
          <Stat
            label="Win rate"
            value={`${stats.winRatePct.toFixed(1)}%`}
            sub={`${stats.wins}W / ${stats.losses}L`}
          />
          <Stat label="Profit factor" value={fmtRatio(stats.profitFactor)} />
          <Stat
            label="Max drawdown"
            value={`−${drawdown.toFixed(2)}%`}
            valueTone={drawdown > 0 ? 'neg' : 'flat'}
          />
          <Stat label="Sharpe" value={sharpe.toFixed(2)} />
          <Stat label="Avg hold" value={`${stats.avgBarsHeld.toFixed(1)} bars`} />
          <Stat label="Fees + slippage" value={fmtMoney(feesPaid)} valueTone={tone(-feesPaid)} />
        </div>

        <PnlBars trades={trades} />
        <p className="caption">Last {Math.min(trades.length, 40)} trades by net P&L after costs.</p>
      </Card>

      <Card
        title="Open positions"
        subtitle={`${views.length} of ${agent.risk.maxOpenPositions} slots`}
      >
        {views.length === 0 ? (
          <Empty>Flat. No capital at risk right now.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Value</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {views.map((v) => (
                <tr key={v.marketId}>
                  <td>{v.marketId}</td>
                  <td>{fmtQty(v.qty)}</td>
                  <td>{fmtPrice(v.entryPrice)}</td>
                  <td>{fmtPrice(v.price)}</td>
                  <td>{fmtMoney(v.value)}</td>
                  <td className={tone(v.pnl)}>
                    {fmtSigned(v.pnl)}
                    <span className="cell-sub">{fmtPct(v.pnlPct)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Trade history" subtitle="Newest first, net of fees and slippage">
        {trades.length === 0 ? (
          <Empty>No closed trades yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Market</th>
                <th>In → Out</th>
                <th>Bars</th>
                <th>Exit</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {[...trades]
                .reverse()
                .slice(0, 60)
                .map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{fmtDateTime(t.exitTime)}</td>
                    <td>{t.marketId}</td>
                    <td className="nowrap">
                      {fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)}
                    </td>
                    <td>{t.barsHeld}</td>
                    <td>
                      <Badge
                        kind={
                          t.exitReason === 'stop_loss'
                            ? 'neg'
                            : t.exitReason === 'take_profit'
                              ? 'pos'
                              : 'neutral'
                        }
                      >
                        {t.exitReason.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className={tone(t.pnl)}>
                      {fmtSigned(t.pnl)}
                      <span className="cell-sub">{fmtPct(t.pnlPct)}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Danger zone">
        <p className="caption">
          Resetting wipes the paper portfolio, the trade history and the activity log from this
          device. Prices and settings are unaffected.
        </p>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm('Reset the paper portfolio? This cannot be undone.')) store.reset();
          }}
        >
          Reset portfolio
        </button>
      </Card>
    </div>
  );
}
