/**
 * Exchange providers.
 *
 * Every request goes through `apiGet`, which tries the same-origin dev proxy
 * first (no CORS, works behind restrictive networks) and falls back to the
 * public host. Providers are pure adapters: same `Candle`/`Ticker` shape out,
 * no provider detail escapes this module.
 */

import type { Candle, DataSourceId, Market, Ticker, Timeframe } from '../types';

/** proxy path -> public origin, matching the table in vite.config.ts */
const ORIGINS: Record<string, string> = {
  '/api/binance': 'https://api.binance.com',
  '/api/coinbase': 'https://api.coinbase.com',
  '/api/cb-exchange': 'https://api.exchange.coinbase.com',
  '/api/kraken': 'https://api.kraken.com',
  '/api/coingecko': 'https://api.coingecko.com',
};

export class ProviderError extends Error {
  constructor(
    public provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

export interface ApiOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * GET JSON, preferring the local proxy. `proxyBase` is a key of ORIGINS.
 * Throws ProviderError with a readable reason on any failure.
 */
export async function apiGet<T>(
  proxyBase: keyof typeof ORIGINS,
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const target = path.startsWith('/') ? path : `/${path}`;
  const candidates = [`${proxyBase}${target}`, `${ORIGINS[proxyBase]}${target}`];

  let lastError = 'unreachable';
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort);

      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }

      if (!res.ok) {
        // 4xx means the provider understood us and said no — trying the
        // alternate origin will not help, so surface it immediately.
        if (res.status >= 400 && res.status < 500) {
          throw new ProviderError(proxyBase, `HTTP ${res.status} ${url}`);
        }
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new ProviderError(proxyBase, lastError);
}

export interface DataProvider {
  id: DataSourceId;
  label: string;
  candles(
    market: Market,
    timeframe: Timeframe,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Candle[]>;
  tickers(markets: Market[], signal?: AbortSignal): Promise<Ticker[]>;
}

/* ------------------------------- Binance ------------------------------- */

const BINANCE_INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];

export const binance: DataProvider = {
  id: 'binance',
  label: 'Binance',

  async candles(market, timeframe, limit, signal) {
    const symbol = market.symbols.binance;
    if (!symbol) throw new ProviderError('binance', `no symbol for ${market.id}`);
    const rows = await apiGet<BinanceKline[]>(
      '/api/binance',
      `/api/v3/klines?symbol=${symbol}&interval=${BINANCE_INTERVAL[timeframe]}&limit=${limit}`,
      { signal },
    );
    return rows.map((r) => ({
      t: r[0],
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }));
  },

  async tickers(markets, signal) {
    const syms = markets.map((m) => m.symbols.binance).filter(Boolean);
    const rows = await apiGet<
      {
        symbol: string;
        lastPrice: string;
        priceChangePercent: string;
        highPrice: string;
        lowPrice: string;
        quoteVolume: string;
        closeTime: number;
      }[]
    >('/api/binance', `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`, {
      signal,
    });
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    const out: Ticker[] = [];
    for (const m of markets) {
      const r = bySymbol.get(m.symbols.binance);
      if (!r) continue;
      out.push({
        marketId: m.id,
        price: Number(r.lastPrice),
        change24hPct: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.quoteVolume),
        at: r.closeTime,
        source: 'binance',
      });
    }
    return out;
  },
};

/* ------------------------------- Coinbase ------------------------------ */

const COINBASE_GRANULARITY: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export const coinbase: DataProvider = {
  id: 'coinbase',
  label: 'Coinbase',

  async candles(market, timeframe, limit, signal) {
    const product = market.symbols['cb-exchange'];
    if (!product) throw new ProviderError('coinbase', `no product for ${market.id}`);
    // Coinbase caps a single request at 300 candles and returns newest-first.
    const rows = await apiGet<[number, number, number, number, number, number][]>(
      '/api/cb-exchange',
      `/products/${product}/candles?granularity=${COINBASE_GRANULARITY[timeframe]}`,
      { signal },
    );
    return rows
      .map((r) => ({ t: r[0] * 1000, o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] }))
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
  },

  async tickers(markets, signal) {
    // Coinbase has no batch quote endpoint with 24h stats, so this is
    // per-symbol spot. Slower, but it is only ever a fallback provider.
    const out: Ticker[] = [];
    for (const m of markets) {
      const pair = m.symbols.coinbase;
      if (!pair) continue;
      try {
        const direct = await apiGet<{ data: { amount: string } }>(
          '/api/coinbase',
          `/v2/prices/${pair}/spot`,
          { signal },
        );
        const price = Number(direct.data.amount);
        if (!Number.isFinite(price)) continue;
        out.push({
          marketId: m.id,
          price,
          change24hPct: NaN,
          high24h: NaN,
          low24h: NaN,
          volume24h: NaN,
          at: Date.now(),
          source: 'coinbase',
        });
      } catch {
        // Skip this symbol; a partial result beats a failed refresh.
      }
    }
    if (out.length === 0) throw new ProviderError('coinbase', 'no quotes returned');
    return out;
  },
};

/* -------------------------------- Kraken ------------------------------- */

const KRAKEN_INTERVAL: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

export const kraken: DataProvider = {
  id: 'kraken',
  label: 'Kraken',

  async candles(market, timeframe, limit, signal) {
    const pair = market.symbols.kraken;
    if (!pair) throw new ProviderError('kraken', `no pair for ${market.id}`);
    const res = await apiGet<{ error: string[]; result: Record<string, unknown> }>(
      '/api/kraken',
      `/0/public/OHLC?pair=${pair}&interval=${KRAKEN_INTERVAL[timeframe]}`,
      { signal },
    );
    if (res.error?.length) throw new ProviderError('kraken', res.error.join('; '));
    const rows = res.result[pair] as [
      number,
      string,
      string,
      string,
      string,
      string,
      string,
      number,
    ][];
    if (!rows) throw new ProviderError('kraken', `unexpected response for ${pair}`);
    return rows
      .map((r) => ({
        t: r[0] * 1000,
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[6]),
      }))
      .slice(-limit);
  },

  async tickers(markets, signal) {
    const pairs = markets.filter((m) => m.symbols.kraken);
    const res = await apiGet<{
      error: string[];
      result: Record<string, { c: string[]; o: string; h: string[]; l: string[]; q: string[] }>;
    }>('/api/kraken', `/0/public/Ticker?pair=${pairs.map((m) => m.symbols.kraken).join(',')}`, {
      signal,
    });
    if (res.error?.length) throw new ProviderError('kraken', res.error.join('; '));
    const out: Ticker[] = [];
    for (const m of pairs) {
      const t = res.result[m.symbols.kraken];
      if (!t) continue;
      const price = Number(t.c[0]);
      const open = Number(t.o);
      out.push({
        marketId: m.id,
        price,
        change24hPct: open > 0 ? ((price - open) / open) * 100 : NaN,
        high24h: Number(t.h[1]),
        low24h: Number(t.l[1]),
        volume24h: Number(t.q[1]),
        at: Date.now(),
        source: 'kraken',
      });
    }
    return out;
  },
};

/* ------------------------------ CoinGecko ------------------------------ */

const COINGECKO_DAYS: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 1,
  '15m': 7,
  '1h': 14,
  '4h': 90,
  '1d': 365,
};

export const coingecko: DataProvider = {
  id: 'coingecko',
  label: 'CoinGecko',

  async candles(market, timeframe, limit, signal) {
    const id = market.symbols.coingecko;
    if (!id) throw new ProviderError('coingecko', `no id for ${market.id}`);
    // CoinGecko fixes bar granularity from `days`; we cannot request an
    // arbitrary interval, so this provider is coarse by nature.
    const rows = await apiGet<[number, number, number, number, number][]>(
      '/api/coingecko',
      `/coins/${id}/ohlc?vs_currency=usd&days=${COINGECKO_DAYS[timeframe]}`,
      { signal },
    );
    return rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: 0 })).slice(-limit);
  },

  async tickers(markets, signal) {
    const ids = markets
      .map((m) => m.symbols.coingecko)
      .filter(Boolean)
      .join(',');
    const res = await apiGet<
      Record<string, { usd: number; usd_24h_change: number; usd_24h_vol: number }>
    >(
      '/api/coingecko',
      `/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      { signal },
    );
    const out: Ticker[] = [];
    for (const m of markets) {
      const r = res[m.symbols.coingecko];
      if (!r) continue;
      out.push({
        marketId: m.id,
        price: r.usd,
        change24hPct: r.usd_24h_change,
        high24h: NaN,
        low24h: NaN,
        volume24h: r.usd_24h_vol,
        at: Date.now(),
        source: 'coingecko',
      });
    }
    return out;
  },
};

export const PROVIDERS: DataProvider[] = [binance, coinbase, kraken, coingecko];

export function providerById(id: DataSourceId): DataProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
