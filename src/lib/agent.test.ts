import { describe, expect, it } from 'vitest';
import { createSnapshot, positionViews, stepAgent, type AgentSnapshot } from './agent';
import {
  DEFAULT_RISK,
  DEFAULT_STRATEGY,
  emptyPortfolio,
  type Candle,
  type Position,
  type RiskConfig,
  type StrategyConfig,
  type Ticker,
} from './types';
import { firstCrossAbove, noisyDipThenRally, seriesWithCrossAtLastClosedBar } from './fixtures';
import { flatCandles } from './data/simulator';

const strat = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...DEFAULT_STRATEGY,
  useTrendFilter: false,
  ...over,
});

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({ ...DEFAULT_RISK, ...over });

const ticker = (marketId: string, price: number): Ticker => ({
  marketId,
  price,
  change24hPct: 0,
  high24h: price,
  low24h: price,
  volume24h: 0,
  at: 1,
  source: 'simulator',
});

/** A series whose bullish cross sits exactly on the last closed bar. */
function crossSeries(): Candle[] {
  const series = noisyDipThenRally(220, 40);
  const k = firstCrossAbove(series);
  expect(k).toBeGreaterThan(0);
  return seriesWithCrossAtLastClosedBar(series, k);
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    marketId: 'ETH/USDT',
    side: 'long',
    qty: 1,
    entryPrice: 100,
    entryTime: 1,
    stopLoss: 90,
    takeProfit: 200,
    highWaterMark: 100,
    strategy: 'ema-atr',
    ...over,
  };
}

describe('createSnapshot', () => {
  it('starts flat, stopped, and funded at the configured amount', () => {
    const s = createSnapshot(risk({ startingCash: 5000 }), strat(), '1h');
    expect(s.running).toBe(false);
    expect(s.halted).toBe(false);
    expect(s.portfolio.cash).toBe(5000);
    expect(Object.keys(s.portfolio.positions)).toHaveLength(0);
    expect(s.portfolio.trades).toHaveLength(0);
    expect(s.portfolio.equityHighWaterMark).toBe(5000);
  });
});

describe('stepAgent — idle', () => {
  it('does nothing at all while stopped', () => {
    const snap: AgentSnapshot = {
      ...createSnapshot(risk(), strat(), '1h'),
      running: false,
    };
    const candles = crossSeries();
    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', candles[candles.length - 2].c) },
    });
    expect(orders).toHaveLength(0);
    expect(snapshot.portfolio.trades).toHaveLength(0);
    expect(snapshot.halted).toBe(false);
  });

  it('evaluates and publishes decisions while stopped, without trading', () => {
    // A stopped agent is a genuine dry run: it must show what it would do, and
    // must not place a single order while doing so.
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: false };
    const candles = crossSeries();
    const price = candles[candles.length - 2].c;

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', price) },
    });

    expect(orders).toHaveLength(0);
    expect(Object.keys(snapshot.portfolio.positions)).toHaveLength(0);
    expect(snapshot.portfolio.trades).toHaveLength(0);
    // But the decision is there, and it is an actionable one.
    expect(snapshot.decisions['BTC/USDT']).toBeDefined();
    expect(snapshot.decisions['BTC/USDT'].action).toBe('OPEN_LONG');
    expect(snapshot.decisions['BTC/USDT'].checks.length).toBeGreaterThan(0);
  });

  it('does not advance a trailing stop while stopped', () => {
    const candles = flatCandles(120, 100);
    candles[candles.length - 2] = { ...candles[candles.length - 2], o: 100, h: 500, l: 99, c: 490 };
    const held = position({ marketId: 'BTC/USDT', stopLoss: 90, highWaterMark: 100 });
    const snap: AgentSnapshot = {
      ...createSnapshot(risk(), strat({ useTrailingStop: true }), '1h'),
      running: false,
      portfolio: { ...emptyPortfolio(9000), positions: { 'BTC/USDT': held } },
    };

    const { snapshot } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', 490) },
    });

    // Frozen means frozen — no stop ratchet, no exit, no trade.
    expect(snapshot.portfolio.positions['BTC/USDT'].stopLoss).toBe(90);
    expect(snapshot.portfolio.positions['BTC/USDT'].highWaterMark).toBe(100);
    expect(snapshot.portfolio.trades).toHaveLength(0);
  });

  it('still records the equity curve while stopped', () => {
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: false };
    const { snapshot } = stepAgent(snap, {
      candlesByMarket: {},
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', 100) },
      now: 1_700_000_000_000,
    });
    expect(snapshot.equityCurve.length).toBeGreaterThan(0);
    expect(snapshot.lastTickAt).toBe(1_700_000_000_000);
  });
});

describe('stepAgent — running', () => {
  it('opens a long when the entry rules pass', () => {
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: true };
    const candles = crossSeries();
    const price = candles[candles.length - 2].c;

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', price) },
      now: 1_700_000_000_000,
    });

    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('buy');
    const opened = snapshot.portfolio.positions['BTC/USDT'];
    expect(opened).toBeDefined();
    expect(opened.stopLoss).toBeLessThan(opened.entryPrice);
    expect(opened.takeProfit).toBeGreaterThan(opened.entryPrice);
    expect(snapshot.portfolio.cash).toBeLessThan(risk().startingCash);
    // The decision trace is kept so the UI can explain the trade.
    expect(snapshot.decisions['BTC/USDT'].action).toBe('OPEN_LONG');
    expect(snapshot.events.some((e) => e.kind === 'order')).toBe(true);
  });

  it('does not deposit a duplicate entry on the next tick', () => {
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: true };
    const candles = crossSeries();
    const price = candles[candles.length - 2].c;
    const input = {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', price) },
    };

    const first = stepAgent(snap, input);
    expect(first.orders).toHaveLength(1);

    const second = stepAgent(first.snapshot, input);
    const buys = second.orders.filter((o) => o.side === 'buy');
    expect(buys).toHaveLength(0);
    expect(Object.keys(second.snapshot.portfolio.positions)).toHaveLength(1);
  });

  it('stops out when the bar range pierces the stop', () => {
    const candles = flatCandles(120, 100);
    // A bar that trades well below the stop.
    candles[candles.length - 2] = {
      ...candles[candles.length - 2],
      o: 100,
      h: 101,
      l: 50,
      c: 95,
    };
    const snap: AgentSnapshot = {
      ...createSnapshot(risk(), strat(), '1h'),
      running: true,
      portfolio: {
        ...emptyPortfolio(9000),
        positions: { 'BTC/USDT': position({ marketId: 'BTC/USDT', stopLoss: 90 }) },
      },
    };

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', 95) },
    });

    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('sell');
    expect(Object.keys(snapshot.portfolio.positions)).toHaveLength(0);
    expect(snapshot.portfolio.trades[0].exitReason).toBe('stop_loss');
  });

  it('takes profit when the bar range reaches the target', () => {
    const candles = flatCandles(120, 100);
    candles[candles.length - 2] = {
      ...candles[candles.length - 2],
      o: 100,
      h: 250,
      l: 99,
      c: 240,
    };
    const snap: AgentSnapshot = {
      ...createSnapshot(risk(), strat(), '1h'),
      running: true,
      portfolio: {
        ...emptyPortfolio(9000),
        positions: {
          'BTC/USDT': position({ marketId: 'BTC/USDT', stopLoss: 90, takeProfit: 200 }),
        },
      },
    };

    const { snapshot } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', 240) },
    });

    expect(snapshot.portfolio.trades[0].exitReason).toBe('take_profit');
    expect(snapshot.portfolio.trades[0].pnl).toBeGreaterThan(0);
  });

  it('blocks a new entry once the position limit is reached', () => {
    const candles = crossSeries();
    const price = candles[candles.length - 2].c;
    const snap: AgentSnapshot = {
      ...createSnapshot(risk({ maxOpenPositions: 2 }), strat(), '1h'),
      running: true,
      portfolio: {
        ...emptyPortfolio(5000),
        positions: {
          'ETH/USDT': position({ marketId: 'ETH/USDT' }),
          'SOL/USDT': position({ marketId: 'SOL/USDT', id: 'p2' }),
        },
      },
    };

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', price) },
    });

    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(0);
    expect(snapshot.portfolio.positions['BTC/USDT']).toBeUndefined();
    expect(snapshot.events.some((e) => /position slots/.test(e.message))).toBe(true);
  });
});

describe('stepAgent — risk gates', () => {
  it('halts and flattens when the drawdown limit is breached', () => {
    const candles = flatCandles(120, 100);
    const snap: AgentSnapshot = {
      ...createSnapshot(risk({ maxDrawdownPct: 20 }), strat(), '1h'),
      running: true,
      portfolio: {
        cash: 4000,
        positions: { 'BTC/USDT': position({ marketId: 'BTC/USDT' }) },
        trades: [],
        createdAt: 0,
        equityHighWaterMark: 10_000, // 50% down from the peak
      },
    };

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', 100) },
    });

    expect(snapshot.halted).toBe(true);
    expect(snapshot.haltReason).toMatch(/Drawdown/);
    expect(Object.keys(snapshot.portfolio.positions)).toHaveLength(0);
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('sell');
    expect(snapshot.events.some((e) => e.kind === 'halt')).toBe(true);
  });

  it('stays halted and takes no new entries on later ticks', () => {
    const candles = crossSeries();
    const price = candles[candles.length - 2].c;
    const snap: AgentSnapshot = {
      ...createSnapshot(risk(), strat(), '1h'),
      running: true,
      halted: true,
      haltReason: 'Drawdown limit hit.',
    };

    const { snapshot, orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', price) },
    });

    expect(orders).toHaveLength(0);
    expect(snapshot.portfolio.positions['BTC/USDT']).toBeUndefined();
    expect(snapshot.halted).toBe(true);
  });
});

describe('stepAgent — safety', () => {
  it('does not mutate the snapshot it was given', () => {
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: true };
    const before = JSON.stringify(snap);
    const candles = crossSeries();
    stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': candles },
      tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', candles[candles.length - 2].c) },
    });
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('caps the event log rather than growing without bound', () => {
    let snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: true };
    const candles = crossSeries();
    for (let i = 0; i < 260; i++) {
      snap = stepAgent(snap, {
        candlesByMarket: { 'BTC/USDT': candles },
        tickersByMarket: { 'BTC/USDT': ticker('BTC/USDT', candles[candles.length - 2].c) },
        now: 1_700_000_000_000 + i * 60_000,
      }).snapshot;
    }
    expect(snap.events.length).toBeLessThanOrEqual(200);
  });

  it('ignores a market whose price is missing entirely', () => {
    const snap: AgentSnapshot = { ...createSnapshot(risk(), strat(), '1h'), running: true };
    const { orders } = stepAgent(snap, {
      candlesByMarket: { 'BTC/USDT': flatCandles(2, 100) },
      tickersByMarket: {},
    });
    expect(orders).toHaveLength(0);
  });
});

describe('positionViews', () => {
  it('marks positions to market and reports P&L', () => {
    const portfolio = {
      ...emptyPortfolio(5000),
      positions: { 'BTC/USDT': position({ marketId: 'BTC/USDT', qty: 2, entryPrice: 100 }) },
    };
    const views = positionViews(
      portfolio,
      { 'BTC/USDT': 150 },
      risk({ feeBps: 0, slippageBps: 0 }),
    );
    expect(views).toHaveLength(1);
    expect(views[0].value).toBeCloseTo(300, 6);
    expect(views[0].pnl).toBeCloseTo(100, 6);
    expect(views[0].pnlPct).toBeCloseTo(50, 6);
  });

  it('falls back to entry price when there is no mark', () => {
    const portfolio = {
      ...emptyPortfolio(5000),
      positions: { 'BTC/USDT': position({ marketId: 'BTC/USDT', qty: 1, entryPrice: 100 }) },
    };
    const views = positionViews(portfolio, {}, risk({ feeBps: 0, slippageBps: 0 }));
    expect(views[0].price).toBe(100);
    expect(views[0].pnl).toBe(0);
  });
});
