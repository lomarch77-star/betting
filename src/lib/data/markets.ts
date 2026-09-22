import type { Candle, Market, Ticker, Timeframe } from '../types';
import { TIMEFRAME_MS } from '../types';

/** Canonical watchlist. Symbols are mapped per provider in `symbols`. */
export const MARKETS: Market[] = [
  {
    id: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    name: 'Bitcoin',
    decimals: 2,
    symbols: {
      binance: 'BTCUSDT',
      coinbase: 'BTC-USD',
      'cb-exchange': 'BTC-USD',
      kraken: 'XXBTZUSD',
      coingecko: 'bitcoin',
    },
  },
  {
    id: 'ETH/USDT',
    base: 'ETH',
    quote: 'USDT',
    name: 'Ethereum',
    decimals: 2,
    symbols: {
      binance: 'ETHUSDT',
      coinbase: 'ETH-USD',
      'cb-exchange': 'ETH-USD',
      kraken: 'XETHZUSD',
      coingecko: 'ethereum',
    },
  },
  {
    id: 'SOL/USDT',
    base: 'SOL',
    quote: 'USDT',
    name: 'Solana',
    decimals: 2,
    symbols: {
      binance: 'SOLUSDT',
      coinbase: 'SOL-USD',
      'cb-exchange': 'SOL-USD',
      kraken: 'SOLUSD',
      coingecko: 'solana',
    },
  },
  {
    id: 'BNB/USDT',
    base: 'BNB',
    quote: 'USDT',
    name: 'BNB',
    decimals: 2,
    symbols: {
      binance: 'BNBUSDT',
      coinbase: 'BNB-USD',
      kraken: 'BNBUSD',
      coingecko: 'binancecoin',
    },
  },
  {
    id: 'XRP/USDT',
    base: 'XRP',
    quote: 'USDT',
    name: 'XRP',
    decimals: 4,
    symbols: {
      binance: 'XRPUSDT',
      coinbase: 'XRP-USD',
      'cb-exchange': 'XRP-USD',
      kraken: 'XXRPZUSD',
      coingecko: 'ripple',
    },
  },
  {
    id: 'DOGE/USDT',
    base: 'DOGE',
    quote: 'USDT',
    name: 'Dogecoin',
    decimals: 5,
    symbols: {
      binance: 'DOGEUSDT',
      coinbase: 'DOGE-USD',
      kraken: 'XDGUSD',
      coingecko: 'dogecoin',
    },
  },
];

export function marketById(id: string): Market | undefined {
  return MARKETS.find((m) => m.id === id);
}

export const BARS_PER_YEAR: Record<Timeframe, number> = Object.fromEntries(
  (Object.keys(TIMEFRAME_MS) as Timeframe[]).map((tf) => [
    tf,
    (365 * 86_400_000) / TIMEFRAME_MS[tf],
  ]),
) as Record<Timeframe, number>;

/** Drops the still-forming final candle if its window has not closed yet. */
export function dropPartial(candles: Candle[], timeframe: Timeframe, now = Date.now()): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  return last.t + TIMEFRAME_MS[timeframe] > now ? candles.slice(0, -1) : candles;
}

/** Sorts ascending by time and removes duplicate timestamps. */
export function normaliseCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Merges a fresh partial candle into history, replacing any same-time bar. */
export function mergeCandles(history: Candle[], incoming: Candle[]): Candle[] {
  return normaliseCandles([...history, ...incoming]);
}

export function isTicker(t: unknown): t is Ticker {
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof (t as Ticker).price === 'number' &&
    Number.isFinite((t as Ticker).price)
  );
}
