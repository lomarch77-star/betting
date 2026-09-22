/**
 * Application store.
 *
 * A small observable store rather than a reducer, because the agent loop is
 * asynchronous and repeatedly replaces the snapshot — `useSyncExternalStore`
 * gives React a stable snapshot cheaply, and the mutable-in-flight details
 * (abort controllers, timers, in-flight guard) live outside the state tree.
 *
 * Nothing here talks to a server: state is loaded from localStorage, prices come
 * from public endpoints, and the agent runs in this tab.
 */

import type {
  BacktestResult,
  Candle,
  DataSourceId,
  Market,
  RiskConfig,
  StrategyConfig,
  Ticker,
  Timeframe,
} from '../lib/types';
import { DEFAULT_RISK, DEFAULT_STRATEGY } from '../lib/types';
import { MarketDataService, type SourceHealth } from '../lib/data';
import { MARKETS, dropPartial, marketById } from '../lib/data/markets';
import { createSnapshot, stepAgent, type AgentSnapshot } from '../lib/agent';
import { closePosition } from '../lib/engine';
import { runBacktest } from '../lib/backtest';
import { loadState, saveState, clearState } from '../lib/storage';
import { sanitiseRisk, sanitiseStrategy } from '../lib/validate';

export const CANDLE_LIMIT = 300;

export interface AppState {
  ready: boolean;
  agent: AgentSnapshot;
  watchlist: string[];
  timeframe: Timeframe;
  offline: boolean;
  providerOrder: DataSourceId[];
  tickers: Record<string, Ticker>;
  candles: Record<string, Candle[]>;
  health: SourceHealth[];
  liveSource: DataSourceId | 'none';
  degraded: boolean;
  refreshing: boolean;
  lastError?: string;
  backtest?: BacktestResult;
}

const DEFAULTS = {
  agent: createSnapshot(DEFAULT_RISK, DEFAULT_STRATEGY, '1h'),
  watchlist: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  timeframe: '1h' as Timeframe,
  offline: false,
  providerOrder: ['binance', 'coinbase', 'kraken', 'coingecko'] as DataSourceId[],
};

export const ALL_PROVIDERS: DataSourceId[] = [
  'binance',
  'coinbase',
  'kraken',
  'coingecko',
  'simulator',
];

/** How often the loop wakes up, per timeframe. */
const TICK_MS: Record<Timeframe, number> = {
  '1m': 15_000,
  '5m': 30_000,
  '15m': 60_000,
  '1h': 60_000,
  '4h': 120_000,
  '1d': 300_000,
};

export class AppStore {
  private state: AppState;
  private listeners = new Set<() => void>();
  private service: MarketDataService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: AbortController | null = null;
  private reevaluateTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor() {
    const saved = loadState(DEFAULTS);
    this.state = {
      ready: false,
      agent: saved.agent,
      watchlist: saved.watchlist,
      timeframe: saved.timeframe,
      offline: saved.offline,
      providerOrder: saved.providerOrder,
      tickers: {},
      candles: {},
      health: [],
      liveSource: 'none',
      degraded: saved.offline,
      refreshing: false,
      backtest: undefined,
    };
    this.service = new MarketDataService({
      order: saved.providerOrder,
      offline: saved.offline,
      seedPrices: Object.fromEntries(
        Object.values(saved.agent.portfolio.positions).map((p) => [p.marketId, p.entryPrice]),
      ),
    });
    this.service.setOrder(this.liveOrder());
  }

  /* ------------------------------ plumbing ------------------------------ */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): AppState => this.state;

  private set = (partial: Partial<AppState>, persist = true) => {
    this.state = { ...this.state, ...partial };
    if (persist) this.persist();
    for (const fn of this.listeners) fn();
  };

  private persist = () => {
    saveState({
      agent: this.state.agent,
      watchlist: this.state.watchlist,
      timeframe: this.state.timeframe,
      offline: this.state.offline,
      providerOrder: this.state.providerOrder,
    });
  };

  /** Live providers, honouring the user's ordering and dropping the simulator. */
  private liveOrder = (): DataSourceId[] => {
    return this.state.providerOrder.filter((p) => p !== 'simulator');
  };

  get markets(): Market[] {
    return this.state.watchlist
      .map((id) => marketById(id))
      .filter((m): m is Market => m !== undefined);
  }

  /* ------------------------------ lifecycle ----------------------------- */

  init = async () => {
    this.set({ ready: true }, false);
    await this.refresh();
    this.syncTimer();
  };

  dispose = () => {
    this.stopTimer();
    if (this.reevaluateTimer) clearTimeout(this.reevaluateTimer);
    this.inFlight?.abort();
  };

  private startTimer = () => {
    this.stopTimer();
    const period = TICK_MS[this.state.timeframe];
    this.timer = setInterval(() => void this.refresh(), period);
  };

  private stopTimer = () => {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  };

  private syncTimer = () => {
    if (this.state.agent.running && !this.state.agent.halted) this.startTimer();
    else this.stopTimer();
  };

  /* ------------------------------- actions ------------------------------ */

  setRunning = (running: boolean) => {
    const agent = { ...this.state.agent, running };
    this.set({ agent });
    this.syncTimer();
    if (running) void this.refresh();
  };

  setTimeframe = (timeframe: Timeframe) => {
    this.set({ timeframe, candles: {} });
    const agent = { ...this.state.agent, timeframe };
    this.set({ agent });
    this.syncTimer();
    void this.refresh();
  };

  setOffline = (offline: boolean) => {
    this.service.setOffline(offline);
    this.set({ offline, degraded: offline });
    void this.refresh();
  };

  setProviderOrder = (order: DataSourceId[]) => {
    this.service.setOrder(order.filter((p) => p !== 'simulator'));
    this.set({ providerOrder: order });
    void this.refresh();
  };

  setWatchlist = (watchlist: string[]) => {
    if (watchlist.length === 0) return;
    this.set({ watchlist });
    // Drop cached candles for markets no longer watched.
    const candles: Record<string, Candle[]> = {};
    for (const id of watchlist) if (this.state.candles[id]) candles[id] = this.state.candles[id];
    this.set({ candles });
    void this.refresh();
  };

  toggleWatch = (marketId: string) => {
    const has = this.state.watchlist.includes(marketId);
    const next = has
      ? this.state.watchlist.filter((id) => id !== marketId)
      : [...this.state.watchlist, marketId];
    this.setWatchlist(next);
  };

  setStrategy = (patch: Partial<StrategyConfig>) => {
    const strategy = sanitiseStrategy({ ...this.state.agent.strategy, ...patch });
    this.set({ agent: { ...this.state.agent, strategy } });
    this.scheduleReevaluate();
  };

  setRisk = (patch: Partial<RiskConfig>) => {
    const risk = sanitiseRisk({ ...this.state.agent.risk, ...patch });
    this.set({ agent: { ...this.state.agent, risk } });
    this.scheduleReevaluate();
  };

  /**
   * Re-runs the rules shortly after the last edit.
   *
   * Debounced because the settings screen writes on every keystroke: clearing a
   * field fires an intermediate value, and re-evaluating (then possibly trading)
   * on a half-typed number would be a nasty surprise.
   */
  private scheduleReevaluate = () => {
    if (this.reevaluateTimer) clearTimeout(this.reevaluateTimer);
    this.reevaluateTimer = setTimeout(() => {
      this.reevaluateTimer = null;
      void this.refresh();
    }, 600);
  };

  resume = () => {
    const agent = {
      ...this.state.agent,
      halted: false,
      haltReason: undefined,
      portfolio: {
        ...this.state.agent.portfolio,
        equityHighWaterMark: 0,
      },
    };
    this.set({ agent });
    this.syncTimer();
    void this.refresh();
  };

  reset = () => {
    this.stopTimer();
    clearState();
    const agent = createSnapshot(
      this.state.agent.risk,
      this.state.agent.strategy,
      this.state.timeframe,
    );
    this.set({ agent, backtest: undefined, candles: {} });
    void this.refresh();
  };

  /** Manual order: flatten a single position at the last known price. */
  closeNow = (marketId: string) => {
    const price = this.state.tickers[marketId]?.price;
    if (!price) return;
    const result = closePosition(
      this.state.agent.portfolio,
      { marketId, price, reason: 'manual' },
      { feeBps: this.state.agent.risk.feeBps, slippageBps: this.state.agent.risk.slippageBps },
    );
    if ('error' in result) {
      this.set({ lastError: result.error });
      return;
    }
    this.set({
      agent: { ...this.state.agent, portfolio: result.portfolio },
    });
  };

  /* -------------------------------- data -------------------------------- */

  refresh = async () => {
    if (this.busy) return;
    this.busy = true;
    this.set({ refreshing: true }, false);

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const markets = this.markets;
      if (markets.length === 0) {
        this.set({ refreshing: false }, false);
        return;
      }

      const timeframes = this.state.timeframe;

      const [tickerResult, ...candleResults] = await Promise.all([
        this.service.tickers(markets, controller.signal),
        ...markets.map((m) => this.service.candles(m, timeframes, CANDLE_LIMIT, controller.signal)),
      ]);

      const tickers: Record<string, Ticker> = { ...this.state.tickers };
      for (const t of tickerResult.data) tickers[t.marketId] = t;

      const candles: Record<string, Candle[]> = { ...this.state.candles };
      markets.forEach((m, i) => {
        const res = candleResults[i];
        if (res && res.data.length) candles[m.id] = dropPartial(res.data, timeframes);
      });

      const errors = [...tickerResult.errors, ...candleResults.flatMap((r) => r?.errors ?? [])];
      const degraded = tickerResult.degraded || candleResults.some((r) => r?.degraded);
      const source = degraded ? 'simulator' : tickerResult.source;

      // The agent only ever sees data that is already in state.
      const stepped = stepAgent(this.state.agent, {
        candlesByMarket: candles,
        tickersByMarket: tickers,
      });

      this.set({
        tickers,
        candles,
        agent: stepped.snapshot,
        health: [...this.service.health.values()],
        liveSource: source,
        degraded,
        refreshing: false,
        lastError: errors.length && degraded ? errors[errors.length - 1].error : undefined,
      });
      this.syncTimer();
    } catch (err) {
      this.set(
        {
          refreshing: false,
          lastError: err instanceof Error ? err.message : String(err),
        },
        false,
      );
    } finally {
      this.busy = false;
      if (this.inFlight === controller) this.inFlight = null;
    }
  };

  /* ------------------------------ backtest ------------------------------ */

  runBacktest = (opts: { marketId: string; bars: number }): BacktestResult => {
    const market = marketById(opts.marketId) ?? MARKETS[0];
    // Prefer live candles when we already hold them; otherwise simulate.
    const live = this.state.candles[market.id];
    const candles =
      live && live.length >= 100
        ? live
        : this.service.simulated(market, this.state.timeframe, Math.max(opts.bars, 300));

    const result = runBacktest(candles, {
      marketId: market.id,
      timeframe: this.state.timeframe,
      strategy: this.state.agent.strategy,
      risk: this.state.agent.risk,
    });
    this.set({ backtest: result }, false);
    return result;
  };
}
