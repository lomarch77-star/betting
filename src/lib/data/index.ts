/**
 * Data access with provider failover and an offline simulator floor.
 *
 * A phone loses connectivity constantly — a lift, a tunnel, a dead zone. So the
 * rule here is that the app never hard-fails on the network: it walks the
 * provider list, and when every live source is down it serves the deterministic
 * simulator and says so loudly in the UI. The agent keeps working either way;
 * only the `source` field changes.
 */

import type { Candle, DataSourceId, Market, Ticker, Timeframe } from '../types';
import { PROVIDERS, ProviderError, type DataProvider } from './providers';
import { hashSeed, simulateCandles } from './simulator';

export interface SourceHealth {
  id: DataSourceId;
  ok: boolean;
  error?: string;
  at: number;
}

export interface FetchResult<T> {
  data: T;
  source: DataSourceId;
  degraded: boolean;
  errors: { source: DataSourceId; error: string }[];
}

export interface DataServiceOptions {
  /** Provider preference order. The simulator is always the final fallback. */
  order?: DataSourceId[];
  /** Turn off live network entirely (offline mode / airplane-mode testing). */
  offline?: boolean;
  /** Base price per market for the simulator, seeded from real quotes when known. */
  seedPrices?: Record<string, number>;
}

const DEFAULT_ORDER: DataSourceId[] = ['binance', 'coinbase', 'kraken', 'coingecko'];

export class MarketDataService {
  readonly health = new Map<DataSourceId, SourceHealth>();
  private order: DataSourceId[];
  private offline: boolean;
  private seedPrices: Record<string, number>;

  constructor(opts: DataServiceOptions = {}) {
    this.order = opts.order ?? DEFAULT_ORDER;
    this.offline = opts.offline ?? false;
    this.seedPrices = opts.seedPrices ?? {};
  }

  setOffline(offline: boolean) {
    this.offline = offline;
  }

  setOrder(order: DataSourceId[]) {
    this.order = order;
  }

  setSeedPrice(marketId: string, price: number) {
    if (Number.isFinite(price) && price > 0) this.seedPrices[marketId] = price;
  }

  get isOffline() {
    return this.offline;
  }

  private liveProviders(): DataProvider[] {
    return this.order
      .map((id) => PROVIDERS.find((p) => p.id === id))
      .filter((p): p is DataProvider => Boolean(p));
  }

  private mark(id: DataSourceId, ok: boolean, error?: string) {
    this.health.set(id, { id, ok, error, at: Date.now() });
  }

  /** Simulated candles, seeded per market+timeframe so replays are stable. */
  simulated(market: Market, timeframe: Timeframe, limit: number): Candle[] {
    const seed = hashSeed(`${market.id}:${timeframe}`);
    const startPrice = this.seedPrices[market.id] ?? defaultSeedPrice(market.base);
    return simulateCandles(limit, timeframe, { seed, startPrice });
  }

  simulatedTicker(market: Market, timeframe: Timeframe): Ticker {
    const candles = this.simulated(market, timeframe, 25);
    const last = candles[candles.length - 1];
    const dayAgo = candles[Math.max(0, candles.length - 24)];
    const high = Math.max(...candles.map((c) => c.h));
    const low = Math.min(...candles.map((c) => c.l));
    return {
      marketId: market.id,
      price: last.c,
      change24hPct: dayAgo.c > 0 ? ((last.c - dayAgo.c) / dayAgo.c) * 100 : 0,
      high24h: high,
      low24h: low,
      volume24h: candles.reduce((a, c) => a + c.v, 0),
      at: last.t,
      source: 'simulator',
    };
  }

  async candles(
    market: Market,
    timeframe: Timeframe,
    limit: number,
    signal?: AbortSignal,
  ): Promise<FetchResult<Candle[]>> {
    const errors: { source: DataSourceId; error: string }[] = [];

    if (!this.offline) {
      for (const provider of this.liveProviders()) {
        try {
          const data = await provider.candles(market, timeframe, limit, signal);
          if (!Array.isArray(data) || data.length === 0) {
            throw new ProviderError(provider.id, 'empty candle set');
          }
          this.mark(provider.id, true);
          const last = data[data.length - 1];
          if (last?.c) this.setSeedPrice(market.id, last.c);
          return { data, source: provider.id, degraded: false, errors };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.mark(provider.id, false, message);
          errors.push({ source: provider.id, error: message });
        }
      }
    }

    this.mark('simulator', true);
    return {
      data: this.simulated(market, timeframe, limit),
      source: 'simulator',
      degraded: true,
      errors,
    };
  }

  async tickers(markets: Market[], signal?: AbortSignal): Promise<FetchResult<Ticker[]>> {
    const errors: { source: DataSourceId; error: string }[] = [];

    if (!this.offline) {
      for (const provider of this.liveProviders()) {
        try {
          const data = await provider.tickers(markets, signal);
          if (data.length === 0) throw new ProviderError(provider.id, 'no tickers');
          this.mark(provider.id, true);
          for (const t of data) this.setSeedPrice(t.marketId, t.price);
          return { data, source: provider.id, degraded: false, errors };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.mark(provider.id, false, message);
          errors.push({ source: provider.id, error: message });
        }
      }
    }

    this.mark('simulator', true);
    return {
      data: markets.map((m) => this.simulatedTicker(m, '1h')),
      source: 'simulator',
      degraded: true,
      errors,
    };
  }

  /** Human-readable summary of what just happened, for the UI status bar. */
  describeHealth(): string {
    const rows = [...this.health.values()].sort((a, b) => b.at - a.at);
    const ok = rows.filter((r) => r.ok).map((r) => r.id);
    const bad = rows.filter((r) => !r.ok).map((r) => r.id);
    const parts: string[] = [];
    if (ok.length) parts.push(`live: ${ok.join(', ')}`);
    if (bad.length) parts.push(`down: ${bad.join(', ')}`);
    return parts.join(' · ') || 'no requests yet';
  }
}

function defaultSeedPrice(base: string): number {
  // Only used when no live quote has ever been seen. Order-of-magnitude is
  // enough for a simulator.
  const table: Record<string, number> = {
    BTC: 60_000,
    ETH: 3_000,
    SOL: 150,
    BNB: 550,
    XRP: 0.6,
    DOGE: 0.15,
  };
  return table[base] ?? 100;
}

export { ProviderError } from './providers';
export * from './markets';
export * from './simulator';
