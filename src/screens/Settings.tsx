import { useState } from 'react';
import { Badge, Card, NumberField, Toggle } from '../components/ui';
import { useAppState, useStore } from '../state/StoreProvider';
import { ALL_PROVIDERS } from '../state/store';
import { MARKETS } from '../lib/data/markets';
import { fmtAgo, fmtBytes } from '../lib/format';
import { storageBytes } from '../lib/storage';
import type { DataSourceId } from '../lib/types';

export function Settings() {
  const store = useStore();
  const state = useAppState();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const { risk, strategy } = state.agent;

  const bytes = storageBytes();

  return (
    <div className="screen">
      <Card
        title="Risk"
        subtitle="Limits are enforced before every entry, and a breached limit halts the agent."
      >
        <div className="field-row">
          <NumberField
            label="Starting cash"
            suffix="quote"
            value={risk.startingCash}
            min={100}
            step={100}
            onChange={(n) => store.setRisk({ startingCash: n })}
            hint="Applies on reset"
          />
          <NumberField
            label="Max open positions"
            value={risk.maxOpenPositions}
            min={1}
            max={10}
            onChange={(n) => store.setRisk({ maxOpenPositions: Math.round(n) })}
          />
          <NumberField
            label="Risk per trade"
            suffix="%"
            value={strategy.riskPerTradePct}
            min={0.1}
            max={10}
            step={0.1}
            onChange={(n) => store.setStrategy({ riskPerTradePct: n })}
            hint="Of equity, lost if the stop is hit"
          />
          <NumberField
            label="Max position"
            suffix="% of equity"
            value={strategy.maxPositionPct}
            min={1}
            max={100}
            onChange={(n) => store.setStrategy({ maxPositionPct: n })}
          />
          <NumberField
            label="Max drawdown"
            suffix="%"
            value={risk.maxDrawdownPct}
            min={1}
            max={100}
            onChange={(n) => store.setRisk({ maxDrawdownPct: n })}
            hint="Halts and flattens"
          />
          <NumberField
            label="Max 24h loss"
            suffix="%"
            value={risk.maxDailyLossPct}
            min={1}
            max={100}
            onChange={(n) => store.setRisk({ maxDailyLossPct: n })}
          />
          <NumberField
            label="Fee"
            suffix="bps"
            value={risk.feeBps}
            min={0}
            max={200}
            step={0.5}
            onChange={(n) => store.setRisk({ feeBps: n })}
            hint="10 bps = 0.10%"
          />
          <NumberField
            label="Slippage"
            suffix="bps"
            value={risk.slippageBps}
            min={0}
            max={200}
            step={0.5}
            onChange={(n) => store.setRisk({ slippageBps: n })}
          />
        </div>
      </Card>

      <Card
        title="Strategy"
        subtitle="Every entry rule must pass. Exits fire on the first bearish trigger."
      >
        <div className="field-row">
          <NumberField
            label="Fast EMA"
            value={strategy.fastPeriod}
            min={2}
            max={100}
            onChange={(n) => store.setStrategy({ fastPeriod: Math.round(n) })}
          />
          <NumberField
            label="Slow EMA"
            value={strategy.slowPeriod}
            min={3}
            max={300}
            onChange={(n) => store.setStrategy({ slowPeriod: Math.round(n) })}
          />
          <NumberField
            label="Trend EMA"
            value={strategy.trendPeriod}
            min={10}
            max={400}
            onChange={(n) => store.setStrategy({ trendPeriod: Math.round(n) })}
          />
          <NumberField
            label="RSI period"
            value={strategy.rsiPeriod}
            min={2}
            max={50}
            onChange={(n) => store.setStrategy({ rsiPeriod: Math.round(n) })}
          />
          <NumberField
            label="RSI overbought"
            value={strategy.rsiOverbought}
            min={50}
            max={100}
            onChange={(n) => store.setStrategy({ rsiOverbought: n })}
          />
          <NumberField
            label="ATR period"
            value={strategy.atrPeriod}
            min={2}
            max={50}
            onChange={(n) => store.setStrategy({ atrPeriod: Math.round(n) })}
          />
          <NumberField
            label="Stop"
            suffix="× ATR"
            value={strategy.atrStopMultiple}
            min={0.5}
            max={10}
            step={0.5}
            onChange={(n) => store.setStrategy({ atrStopMultiple: n })}
          />
          <NumberField
            label="Target"
            suffix="× ATR"
            value={strategy.atrTargetMultiple}
            min={0.5}
            max={20}
            step={0.5}
            onChange={(n) => store.setStrategy({ atrTargetMultiple: n })}
          />
          <NumberField
            label="Cooldown after exit"
            suffix="bars"
            value={strategy.cooldownBars}
            min={0}
            max={100}
            onChange={(n) => store.setStrategy({ cooldownBars: Math.round(n) })}
          />
        </div>

        <div className="toggle-list">
          <Toggle
            label="Trend filter"
            hint="Only enter above the slow trend EMA"
            checked={strategy.useTrendFilter}
            onChange={(v) => store.setStrategy({ useTrendFilter: v })}
          />
          <Toggle
            label="RSI filter"
            hint="Skip entries that are already overbought"
            checked={strategy.useRsiFilter}
            onChange={(v) => store.setStrategy({ useRsiFilter: v })}
          />
          <Toggle
            label="Trailing stop"
            hint="Ratchet the stop up behind the high-water mark"
            checked={strategy.useTrailingStop}
            onChange={(v) => store.setStrategy({ useTrailingStop: v })}
          />
        </div>
      </Card>

      <Card
        title="Data"
        subtitle="Provider order — the agent falls through to the next on failure."
      >
        <div className="provider-list">
          {orderedProviders(state.providerOrder).map(({ id, rank }) => {
            const health = state.health.find((h) => h.id === id);
            const isSim = id === 'simulator';
            return (
              <div className="provider" key={id}>
                <div className="provider-main">
                  <span className="provider-name">{labelFor(id)}</span>
                  <span className="provider-status">
                    {isSim ? (
                      <Badge kind="sim">always available</Badge>
                    ) : health ? (
                      <Badge kind={health.ok ? 'pos' : 'neg'}>
                        {health.ok ? 'ok' : `failed · ${fmtAgo(health.at)}`}
                      </Badge>
                    ) : (
                      <Badge kind="neutral">not tried</Badge>
                    )}
                  </span>
                </div>
                {!isSim && (
                  <div className="provider-controls">
                    <button
                      className="btn btn-tiny"
                      disabled={rank <= 0}
                      onClick={() => move(state.providerOrder, rank, -1, store.setProviderOrder)}
                      aria-label={`Move ${id} earlier`}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-tiny"
                      disabled={rank >= state.providerOrder.length - 2}
                      onClick={() => move(state.providerOrder, rank, 1, store.setProviderOrder)}
                      aria-label={`Move ${id} later`}
                    >
                      ↓
                    </button>
                    <span className="provider-rank">#{rank + 1}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="toggle-list">
          <Toggle
            label="Offline mode"
            hint="Skip the network entirely and run on the simulator"
            checked={state.offline}
            onChange={store.setOffline}
          />
        </div>

        <p className="caption">
          PaperDesk never sends your portfolio anywhere. Requests to price endpoints carry no
          account, key or identifier — they are the same public quotes any browser can fetch.
        </p>
      </Card>

      <Card title="Watchlist">
        <div className="chip-row">
          {MARKETS.map((m) => {
            const on = state.watchlist.includes(m.id);
            return (
              <button
                key={m.id}
                className={`chip ${on ? 'chip-active' : ''}`}
                onClick={() => store.toggleWatch(m.id)}
              >
                {on ? '● ' : '+ '}
                {m.id}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Data on this device">
        <p className="caption">
          {fmtBytes(bytes)} stored locally under <code>paperdesk.state.v1</code>. Cleared when you
          reset or clear site data.
        </p>
        {confirmWipe ? (
          <div className="btn-row">
            <button
              className="btn btn-danger"
              onClick={() => {
                store.reset();
                setConfirmWipe(false);
              }}
            >
              Yes, wipe everything
            </button>
            <button className="btn" onClick={() => setConfirmWipe(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-danger" onClick={() => setConfirmWipe(true)}>
            Reset portfolio &amp; settings
          </button>
        )}
      </Card>

      <Card title="About">
        <p className="caption">
          PaperDesk is a local-first paper-trading agent. It runs entirely in this browser tab: no
          server, no account, no API keys, and no real orders. Money shown is simulated. Nothing
          here is investment advice.
        </p>
      </Card>
    </div>
  );
}

function move(
  order: DataSourceId[],
  from: number,
  delta: number,
  apply: (o: DataSourceId[]) => void,
) {
  const to = from + delta;
  if (to < 0 || to >= order.length) return;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  apply(next);
}

/**
 * Live providers in their actual failover order, with the simulator pinned last
 * — it is the floor the agent lands on when everything else fails, so it is not
 * a reorderable choice.
 */
function orderedProviders(order: DataSourceId[]): { id: DataSourceId; rank: number }[] {
  return ALL_PROVIDERS.map((id) => {
    const at = order.indexOf(id);
    return { id, rank: id === 'simulator' ? order.length : at < 0 ? order.length : at };
  }).sort((a, b) => a.rank - b.rank);
}

function labelFor(id: DataSourceId): string {
  const labels: Partial<Record<DataSourceId, string>> = {
    binance: 'Binance (public REST)',
    coinbase: 'Coinbase (public REST)',
    kraken: 'Kraken (public REST)',
    coingecko: 'CoinGecko (public REST)',
    simulator: 'Built-in simulator',
  };
  return labels[id] ?? id;
}
