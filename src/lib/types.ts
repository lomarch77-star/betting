/**
 * Core domain types for PaperDesk.
 *
 * Everything here is plain serialisable data: the whole app state round-trips
 * through JSON so it can live in localStorage / IndexedDB and survive a cold
 * start on a phone with no network.
 */

/** OHLCV candle. Timestamps are epoch milliseconds, UTC, at bar open. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface Market {
  /** Canonical id used everywhere in the app, e.g. `BTC/USDT`. */
  id: string;
  base: string;
  quote: string;
  name: string;
  /** Provider-specific symbol, e.g. `BTCUSDT` (Binance) / `BTC-USD` (Coinbase). */
  symbols: Record<string, string>;
  decimals: number;
}

export interface Ticker {
  marketId: string;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  at: number;
  source: DataSourceId;
}

export type DataSourceId = 'binance' | 'coinbase' | 'kraken' | 'coingecko' | 'simulator';

export const DATA_SOURCES: DataSourceId[] = [
  'binance',
  'coinbase',
  'kraken',
  'coingecko',
  'simulator',
];

/* ------------------------------------------------------------------ */
/* Strategy                                                            */
/* ------------------------------------------------------------------ */

export interface StrategyConfig {
  fastPeriod: number;
  slowPeriod: number;
  trendPeriod: number;
  useTrendFilter: boolean;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  useRsiFilter: boolean;
  atrPeriod: number;
  atrStopMultiple: number;
  atrTargetMultiple: number;
  useTrailingStop: boolean;
  riskPerTradePct: number;
  maxPositionPct: number;
  cooldownBars: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  fastPeriod: 12,
  slowPeriod: 26,
  trendPeriod: 100,
  useTrendFilter: true,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  useRsiFilter: true,
  atrPeriod: 14,
  atrStopMultiple: 2,
  atrTargetMultiple: 4,
  useTrailingStop: false,
  riskPerTradePct: 1,
  maxPositionPct: 25,
  cooldownBars: 3,
};

/* ------------------------------------------------------------------ */
/* Rules & decisions                                                   */
/* ------------------------------------------------------------------ */

export type RuleId =
  'data' | 'trend' | 'crossover' | 'momentum' | 'position' | 'stop' | 'target' | 'cooldown';

export interface RuleCheck {
  id: RuleId;
  label: string;
  /** null = rule not applicable (e.g. disabled filter). */
  pass: boolean | null;
  detail: string;
  /** +1 bullish, -1 bearish, 0 neutral — used for the composite score. */
  weight: number;
}

export type AgentAction = 'OPEN_LONG' | 'CLOSE' | 'HOLD';

export interface Decision {
  action: AgentAction;
  /** Sum of weights of the checks that applied. Positive = bullish. */
  score: number;
  checks: RuleCheck[];
  indicators: {
    fast: number;
    slow: number;
    trend: number;
    rsi: number;
    atr: number;
    price: number;
  };
  /** Suggested stop / target in price terms, computed from ATR. */
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Risk                                                                */
/* ------------------------------------------------------------------ */

export interface RiskConfig {
  startingCash: number;
  feeBps: number;
  slippageBps: number;
  maxOpenPositions: number;
  /** Halt the agent if equity falls this far below the session peak (%). */
  maxDrawdownPct: number;
  /** Halt the agent after this much loss in a rolling 24h window (%). */
  maxDailyLossPct: number;
  maxLeverage: number;
}

export const DEFAULT_RISK: RiskConfig = {
  startingCash: 10_000,
  feeBps: 10,
  slippageBps: 5,
  maxOpenPositions: 3,
  maxDrawdownPct: 20,
  maxDailyLossPct: 5,
  maxLeverage: 1,
};

/* ------------------------------------------------------------------ */
/* Portfolio                                                           */
/* ------------------------------------------------------------------ */

export type PositionSide = 'long';

export interface Position {
  id: string;
  marketId: string;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
  /** Highest price seen since entry — used by the trailing stop. */
  highWaterMark: number;
  strategy: string;
}

export type TradeExitReason =
  'manual' | 'signal' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'risk_halt';

export interface Trade {
  id: string;
  marketId: string;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: TradeExitReason;
  /** Net of entry fee, exit fee and slippage. Quote currency. */
  pnl: number;
  pnlPct: number;
  barsHeld: number;
}

export interface Portfolio {
  cash: number;
  positions: Record<string, Position>;
  trades: Trade[];
  createdAt: number;
  equityHighWaterMark: number;
}

export function emptyPortfolio(cash: number, now = Date.now()): Portfolio {
  return {
    cash,
    positions: {},
    trades: [],
    createdAt: now,
    equityHighWaterMark: cash,
  };
}

/* ------------------------------------------------------------------ */
/* Orders & agent log                                                  */
/* ------------------------------------------------------------------ */

export interface Order {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  slippage: number;
  time: number;
  status: 'filled' | 'rejected';
  reason?: string;
}

export interface AgentEvent {
  id: string;
  at: number;
  kind: 'tick' | 'order' | 'halt' | 'resume' | 'reset' | 'error';
  marketId?: string;
  message: string;
  action?: AgentAction;
  score?: number;
  checks?: RuleCheck[];
}

export interface BacktestResult {
  equityCurve: { t: number; equity: number }[];
  trades: Trade[];
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  sharpe: number;
  tradeCount: number;
  avgBarsHeld: number;
  buyHoldReturnPct: number;
  bars: number;
}
