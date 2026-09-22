import { PriceChart } from '../components/Charts';
import { Badge, Card, Empty } from '../components/ui';
import { useAppState, useNow, useStore } from '../state/StoreProvider';
import { marketById, MARKETS } from '../lib/data/markets';
import { fmtAgo, fmtPrice, fmtPct, fmtQty } from '../lib/format';
import type { Decision, RuleCheck } from '../lib/types';
import { TIMEFRAMES } from '../lib/types';

/**
 * The transparency screen.
 *
 * Every rule the engine evaluated is listed with its actual inputs, so a user
 * can audit any decision instead of trusting a black box. This is the whole
 * reason the engine emits a `checks` trace rather than just an action.
 */
export function Agent({ marketId }: { marketId: string }) {
  const store = useStore();
  const state = useAppState();
  const now = useNow();

  const decision: Decision | undefined = state.agent.decisions[marketId];
  const candles = state.candles[marketId] ?? [];
  const ticker = state.tickers[marketId];
  const market = marketById(marketId);

  const position = state.agent.portfolio.positions[marketId];
  const myTrades = state.agent.portfolio.trades.filter((t) => t.marketId === marketId);

  return (
    <div className="screen">
      <Card
        title={market ? `${market.name} · ${market.id}` : marketId}
        subtitle={
          ticker ? `${fmtPrice(ticker.price)} · ${fmtPct(ticker.change24hPct)} 24h` : 'no quote'
        }
        actions={
          <Badge kind={state.degraded ? 'sim' : 'live'}>{state.degraded ? 'SIM' : 'LIVE'}</Badge>
        }
      >
        <PriceChart
          candles={candles}
          tradeMarkers={myTrades.slice(-8).flatMap((t) => [
            { t: t.entryTime, kind: 'entry' as const },
            { t: t.exitTime, kind: 'exit' as const },
          ])}
          markers={
            position
              ? [
                  {
                    price: position.stopLoss,
                    label: `stop ${fmtPrice(position.stopLoss)}`,
                    tone: 'neg' as const,
                  },
                  {
                    price: position.takeProfit,
                    label: `target ${fmtPrice(position.takeProfit)}`,
                    tone: 'pos' as const,
                  },
                ]
              : []
          }
        />

        <div className="segmented">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={`segment ${state.timeframe === tf ? 'segment-active' : ''}`}
              onClick={() => store.setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="chip-row">
          {MARKETS.map((m) => (
            <button
              key={m.id}
              className={`chip ${m.id === marketId ? 'chip-active' : ''}`}
              onClick={() => store.toggleWatch(m.id)}
            >
              {state.watchlist.includes(m.id) ? '● ' : '+ '}
              {m.id}
            </button>
          ))}
        </div>
      </Card>

      <Card
        title="Current decision"
        subtitle={decision ? decision.reason : 'The agent has not evaluated this market yet.'}
      >
        {decision ? (
          <>
            <div className="decision-head">
              <Badge
                kind={
                  decision.action === 'OPEN_LONG'
                    ? 'pos'
                    : decision.action === 'CLOSE'
                      ? 'neg'
                      : 'neutral'
                }
              >
                {decision.action}
              </Badge>
              <span className="decision-score">score {decision.score}</span>
            </div>

            <ul className="rules">
              {decision.checks.map((check) => (
                <RuleRow key={`${check.id}-${check.label}`} check={check} />
              ))}
            </ul>

            <div className="kv-grid">
              <Kv k="Fast EMA" v={fmtPrice(decision.indicators.fast)} />
              <Kv k="Slow EMA" v={fmtPrice(decision.indicators.slow)} />
              <Kv k="Trend EMA" v={fmtPrice(decision.indicators.trend)} />
              <Kv k="RSI" v={decision.indicators.rsi.toFixed(1)} />
              <Kv k="ATR" v={fmtPrice(decision.indicators.atr)} />
              <Kv k="Price" v={fmtPrice(decision.indicators.price)} />
            </div>

            {position ? (
              <div className="banner banner-info">
                Holding {fmtQty(position.qty)} from {fmtPrice(position.entryPrice)}. Stop{' '}
                {fmtPrice(position.stopLoss)}, target {fmtPrice(position.takeProfit)}. High since
                entry {fmtPrice(position.highWaterMark)}.
              </div>
            ) : (
              <div className="banner banner-info">
                Flat. If the entry rules pass the agent will risk{' '}
                {state.agent.strategy.riskPerTradePct}% of equity against a{' '}
                {fmtPrice(stopDistance(decision))} stop distance, capped at{' '}
                {state.agent.strategy.maxPositionPct}% of equity per position.
              </div>
            )}
          </>
        ) : (
          <Empty>Start the agent or press refresh to evaluate this market.</Empty>
        )}
      </Card>

      <Card title="Trade history" subtitle={`${myTrades.length} closed`}>
        {myTrades.length === 0 ? (
          <Empty>No closed trades in this market.</Empty>
        ) : (
          <ul className="trade-list">
            {[...myTrades]
              .reverse()
              .slice(0, 25)
              .map((t) => (
                <li key={t.id} className="trade">
                  <div className="trade-top">
                    <span className={t.pnl >= 0 ? 'pos' : 'neg'}>
                      {t.pnl >= 0 ? '+' : ''}
                      {t.pnl.toFixed(2)}
                    </span>
                    <Badge kind={t.pnl >= 0 ? 'pos' : 'neg'}>
                      {t.exitReason.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="trade-meta">
                    {fmtQty(t.qty)} @ {fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)} ·{' '}
                    {t.barsHeld} bars
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card
        title="Activity"
        subtitle={`${state.agent.events.length} recent events`}
        actions={
          <span className="card-sub">
            refreshed {state.agent.lastTickAt ? fmtAgo(state.agent.lastTickAt, now) : '—'}
          </span>
        }
      >
        {state.agent.events.length === 0 ? (
          <Empty>The log fills as the agent ticks.</Empty>
        ) : (
          <ul className="log">
            {[...state.agent.events]
              .reverse()
              .slice(0, 60)
              .map((e) => (
                <li key={e.id} className={`log-item log-${e.kind}`}>
                  <span className="log-time">
                    {new Date(e.at).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="log-msg">{e.message}</span>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Distance from entry to stop, i.e. what the risk sizing is measured against. */
function stopDistance(d: Decision): number {
  const stop = d.stopLoss ?? d.indicators.price;
  return Math.abs(d.indicators.price - stop);
}

function RuleRow({ check }: { check: RuleCheck }) {
  const state = check.pass === null ? 'skip' : check.pass ? 'pass' : 'fail';
  return (
    <li className={`rule rule-${state}`}>
      <span className="rule-mark" aria-hidden="true">
        {check.pass === null ? '–' : check.pass ? '✓' : '✕'}
      </span>
      <div className="rule-body">
        <span className="rule-label">{check.label}</span>
        <span className="rule-detail">{check.detail}</span>
      </div>
    </li>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}
