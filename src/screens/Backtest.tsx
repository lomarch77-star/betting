import { useState } from 'react';
import { EquityChart } from '../components/Charts';
import { Card, Empty, Stat } from '../components/ui';
import { useAppState, useStore } from '../state/StoreProvider';
import { fmtMoney, fmtPct, fmtRatio, fmtSigned, tone } from '../lib/format';
import { MARKETS } from '../lib/data/markets';

/**
 * Backtest screen.
 *
 * Uses the same strategy and execution code as the live agent, so what you tune
 * here is exactly what runs. Past performance on a price series is not
 * predictive, and the copy says so.
 */
export function Backtest() {
  const store = useStore();
  const state = useAppState();
  const [marketId, setMarketId] = useState(state.watchlist[0] ?? MARKETS[0].id);
  const [bars, setBars] = useState(600);
  const [busy, setBusy] = useState(false);

  const result = state.backtest;

  const run = () => {
    setBusy(true);
    // Yield a frame so the button can show its busy state before the
    // synchronous replay blocks the main thread.
    setTimeout(() => {
      store.runBacktest({ marketId, bars });
      setBusy(false);
    }, 0);
  };

  return (
    <div className="screen">
      <Card
        title="Backtest"
        subtitle="The same engine, replayed over history with the current strategy and risk settings."
      >
        <div className="field-row">
          <label className="field">
            <span className="field-label">Market</span>
            <select
              className="input"
              value={marketId}
              onChange={(e) => setMarketId(e.target.value)}
            >
              {(state.watchlist.length ? state.watchlist : MARKETS.map((m) => m.id)).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">Bars</span>
            <select
              className="input"
              value={bars}
              onChange={(e) => setBars(Number(e.target.value))}
            >
              {[300, 600, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Replaying…' : 'Run backtest'}
        </button>

        <p className="caption">
          Replays the last {bars} bars of the selected market on the {state.timeframe} timeframe.
          Entries fill at the next bar's open — never the bar that produced the signal — and every
          fill pays the fee and slippage configured in Risk.
        </p>
      </Card>

      {!result ? (
        <Card title="Results">
          <Empty>Run a backtest to see how the current settings would have performed.</Empty>
        </Card>
      ) : (
        <>
          <Card title="Results" subtitle={`${result.bars} bars · ${result.tradeCount} trades`}>
            <div className="stat-grid">
              <Stat
                label="Strategy return"
                value={fmtPct(result.totalReturnPct)}
                valueTone={tone(result.totalReturnPct)}
                sub={fmtMoney(result.endEquity)}
              />
              <Stat
                label="Buy & hold"
                value={fmtPct(result.buyHoldReturnPct)}
                valueTone={tone(result.buyHoldReturnPct)}
                sub="benchmark"
              />
              <Stat
                label="vs benchmark"
                value={fmtPct(result.totalReturnPct - result.buyHoldReturnPct)}
                valueTone={tone(result.totalReturnPct - result.buyHoldReturnPct)}
              />
              <Stat
                label="Max drawdown"
                value={`−${result.maxDrawdownPct.toFixed(2)}%`}
                valueTone={result.maxDrawdownPct > 0 ? 'neg' : 'flat'}
              />
              <Stat label="Win rate" value={`${result.winRatePct.toFixed(1)}%`} />
              <Stat label="Profit factor" value={fmtRatio(result.profitFactor)} />
              <Stat label="Sharpe" value={result.sharpe.toFixed(2)} />
              <Stat label="Avg hold" value={`${result.avgBarsHeld.toFixed(1)} bars`} />
            </div>

            <EquityChart points={result.equityCurve} height={150} />
          </Card>

          <Card title="Simulated trades" subtitle="Newest first">
            {result.trades.length === 0 ? (
              <Empty>
                The strategy never triggered. Try disabling the trend or RSI filter, or loosen the
                crossover periods.
              </Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>In → Out</th>
                    <th>Bars</th>
                    <th>Exit</th>
                    <th>P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.trades]
                    .reverse()
                    .slice(0, 50)
                    .map((t, i) => (
                      <tr key={t.id}>
                        <td>{result.trades.length - i}</td>
                        <td className="nowrap">
                          {t.entryPrice.toFixed(2)} → {t.exitPrice.toFixed(2)}
                        </td>
                        <td>{t.barsHeld}</td>
                        <td>{t.exitReason.replace('_', ' ')}</td>
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

          <Card title="Caveats">
            <p className="caption">
              This replays history with today's settings: it is curve-fitting bait, not a forecast.
              The simulator's price series is synthetic and will not match any real market. Costs
              are modelled as a flat fee plus slippage, so thin markets and gaps will be flattered.
              Treat a good result as a reason to keep testing, never as a reason to trade real
              money.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
