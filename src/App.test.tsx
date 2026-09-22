/**
 * End-to-end smoke test for the UI.
 *
 * Typechecking proves nothing about render-time crashes, and the interesting
 * paths in this app are all runtime: the offline fallback, the agent loop, and
 * five screens that each read a different slice of state.
 *
 * The store is pushed into offline mode by pre-seeding localStorage, so every
 * test here runs against the deterministic simulator with no network. That
 * makes the whole app testable in CI and proves the offline story works.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { StoreProvider } from './state/StoreProvider';
import type { AgentSnapshot } from './lib/agent';
import { DEFAULT_RISK, DEFAULT_STRATEGY, emptyPortfolio, type Timeframe } from './lib/types';

/** Shape of the saved state this test seeds directly into localStorage. */
interface PersistedSeed {
  agent?: Partial<AgentSnapshot>;
  watchlist?: string[];
  timeframe?: Timeframe;
  offline?: boolean;
}

const STORAGE_KEY = 'paperdesk.state.v1';

/** Seeds saved state so the store boots offline with a known portfolio. */
function seedOfflineState(overrides: Partial<PersistedSeed> = {}) {
  const agent = {
    portfolio: emptyPortfolio(DEFAULT_RISK.startingCash),
    risk: DEFAULT_RISK,
    strategy: DEFAULT_STRATEGY,
    timeframe: '1h',
    running: false,
    halted: false,
    lastExitAt: {},
    equityCurve: [],
    events: [],
    decisions: {},
    ...overrides.agent,
  };
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      payload: {
        agent,
        watchlist: overrides.watchlist ?? ['BTC/USDT', 'ETH/USDT'],
        timeframe: overrides.timeframe ?? '1h',
        offline: overrides.offline ?? true,
        providerOrder: ['binance', 'coinbase', 'kraken', 'coingecko', 'simulator'],
      },
    }),
  );
}

/**
 * Waits for the store to boot. `$10,000.00` is deliberately matched with
 * `getAllByText`: it legitimately appears twice (the hero figure and the cash
 * stat), and asserting on the unique "Paper equity" label first keeps the
 * readiness check unambiguous.
 */
async function expectStartingEquity() {
  await waitFor(() => expect(screen.getByText('Paper equity')).toBeTruthy());
  await waitFor(() => expect(screen.getAllByText('$10,000.00').length).toBeGreaterThan(0));
}

function renderApp() {
  return render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('App shell', () => {
  it('renders the dashboard with the starting equity and five tabs', async () => {
    seedOfflineState();
    renderApp();

    expect(screen.getByText('PaperDesk')).toBeTruthy();
    // Every tab is present and reachable.
    for (const label of ['Desk', 'Agent', 'Book', 'Test', 'Setup']) {
      expect(screen.getByRole('tab', { name: new RegExp(label, 'i') })).toBeTruthy();
    }
    // Equity is rendered once the store initialises.
    await expectStartingEquity();
  });

  it('shows the offline banner rather than failing when there is no network', async () => {
    seedOfflineState({ offline: true });
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByText(/Offline mode is on — prices come from the deterministic/i),
      ).toBeTruthy(),
    );
  });

  it('discovers markets from the simulator and shows quotes', async () => {
    seedOfflineState({ watchlist: ['BTC/USDT'] });
    renderApp();
    // The watchlist row renders a price once candles/tickers arrive.
    await waitFor(() => expect(screen.getByText('Bitcoin')).toBeTruthy());
    await waitFor(() => {
      const prices = screen.getAllByText(/^[\d,]+\.\d+$/);
      expect(prices.length).toBeGreaterThan(0);
    });
  });

  it('navigates to every tab without crashing', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    for (const label of ['Agent', 'Book', 'Test', 'Setup', 'Desk']) {
      await user.click(screen.getByRole('tab', { name: new RegExp(label, 'i') }));
      // The top bar is present on every screen.
      expect(screen.getByText('PaperDesk')).toBeTruthy();
    }
  });
});

describe('agent lifecycle through the UI', () => {
  it('starts, evaluates, and produces a rule trace', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    await user.click(screen.getByRole('button', { name: /start agent/i }));

    // The header status flips to live.
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByRole('button', { name: /stop agent/i })).toBeTruthy();

    // The Agent screen must explain the decision with named rules.
    await user.click(screen.getByRole('tab', { name: /agent/i }));
    await waitFor(() => expect(screen.getByText('Current decision')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/EMA12\/26 crossover/)).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.getByText(/Trend filter \(price > EMA100\)/)).toBeTruthy();
    expect(screen.getByText(/Enough history|RSI14 not overbought/)).toBeTruthy();
  });

  it('stops on demand', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    await user.click(screen.getByRole('button', { name: /start agent/i }));
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy(), { timeout: 4000 });

    await user.click(screen.getByRole('button', { name: /stop agent/i }));
    await waitFor(() => expect(screen.getByText('stopped')).toBeTruthy());
  });

  it('persists a started agent across a remount', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    const first = renderApp();
    await expectStartingEquity();
    await user.click(screen.getByRole('button', { name: /start agent/i }));
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy(), { timeout: 4000 });

    // Give the debounced save a moment, then remount from scratch.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    first.unmount();

    renderApp();
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy(), { timeout: 4000 });
  });
});

describe('manual control', () => {
  it('closes a position from the dashboard', async () => {
    const user = userEvent.setup();
    // Seed a small position so the simulator prices it near its entry.
    seedOfflineState({
      agent: {
        portfolio: {
          ...emptyPortfolio(9_900),
          positions: {
            'BTC/USDT': {
              id: 'p1',
              marketId: 'BTC/USDT',
              side: 'long' as const,
              qty: 1,
              entryPrice: 100,
              entryTime: Date.now() - 60_000,
              stopLoss: 90,
              takeProfit: 200,
              highWaterMark: 100,
              strategy: 'ema-atr',
            },
          },
        },
      },
    });
    renderApp();

    // The position renders with its bracket.
    await waitFor(() => expect(screen.getByText('Stop 90.000')).toBeTruthy());
    expect(screen.getByText(/1 open/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /close now/i }));

    await waitFor(() => expect(screen.getByText(/No open positions/)).toBeTruthy());
    // The exit is booked as a trade with the manual reason.
    await user.click(screen.getByRole('tab', { name: /book/i }));
    await waitFor(() => expect(screen.getByText(/^manual$/i)).toBeTruthy());
  });
});

describe('risk halt', () => {
  it('flattens and shows the halt banner when the drawdown limit is breached', async () => {
    const agent = {
      portfolio: {
        cash: 4000,
        positions: {
          'BTC/USDT': {
            id: 'p1',
            marketId: 'BTC/USDT',
            side: 'long' as const,
            qty: 1,
            entryPrice: 100,
            entryTime: 1,
            stopLoss: 90,
            takeProfit: 200,
            highWaterMark: 100,
            strategy: 'ema-atr',
          },
        },
        trades: [],
        createdAt: 0,
        // A 10k peak against ~4k equity is a 60% drawdown.
        equityHighWaterMark: 10_000,
      },
      running: true,
    };
    seedOfflineState({ agent });
    renderApp();

    await waitFor(() => expect(screen.getByText('HALTED')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByText(/Risk halt:/)).toBeTruthy();
    // The halt button is disabled, and Resume is offered instead.
    const stop = screen.getByRole('button', {
      name: /start agent|stop agent/i,
    }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy();
  });
});

describe('backtest screen', () => {
  it('runs a backtest and reports performance metrics', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    await user.click(screen.getByRole('tab', { name: /test/i }));
    await waitFor(() => expect(screen.getByText('Run backtest')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: /run backtest/i }));

    await waitFor(() => expect(screen.getByText('Strategy return')).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByText('Buy & hold')).toBeTruthy();
    expect(screen.getByText('Max drawdown')).toBeTruthy();
    expect(screen.getByText(/Replays the last 600 bars/)).toBeTruthy();
  });
});

describe('settings', () => {
  it('edits a strategy parameter and reflects it back', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    await user.click(screen.getByRole('tab', { name: /setup/i }));
    const input = (await screen.findByLabelText(/^Fast EMA$/)) as HTMLInputElement;

    await user.clear(input);
    await user.type(input, '9');
    await waitFor(() => expect(input.value).toBe('9'));

    // The engine must now label the rule with the new period.
    await user.click(screen.getByRole('tab', { name: /agent/i }));
    await waitFor(() => expect(screen.getByText(/EMA9\/26 crossover/)).toBeTruthy(), {
      timeout: 4000,
    });
  });

  it('toggles offline mode from the settings switch', async () => {
    // Regression: the switch passes the store method straight through as a
    // callback, so an unbound `setOffline` used to throw on `this`.
    const user = userEvent.setup();
    seedOfflineState({ offline: false });
    renderApp();
    await waitFor(() => expect(screen.getByText('Paper equity')).toBeTruthy());

    await user.click(screen.getByRole('tab', { name: /setup/i }));
    const toggle = (await screen.findByLabelText(/Offline mode/i)) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await user.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));

    // The dashboard must explain that prices are now simulated by choice.
    await user.click(screen.getByRole('tab', { name: /desk/i }));
    await waitFor(() => expect(screen.getByText(/Offline mode is on/)).toBeTruthy());
  });

  it('reports the provider order and lets it be reordered', async () => {
    const user = userEvent.setup();
    seedOfflineState();
    renderApp();
    await expectStartingEquity();

    await user.click(screen.getByRole('tab', { name: /setup/i }));
    await waitFor(() => expect(screen.getByText('Binance (public REST)')).toBeTruthy());
    expect(screen.getByText('Built-in simulator')).toBeTruthy();

    // Binance starts first, so its "move up" control is disabled.
    const upButtons = screen.getAllByRole('button', { name: /move .* earlier/i });
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);

    // Providers render in their effective order; Binance leads by default.
    const rendered = () =>
      screen
        .getAllByText(/(Binance|Coinbase|Kraken|CoinGecko) \(public REST\)|Built-in simulator/)
        .map((el) => el.textContent ?? '');
    expect(rendered()[0]).toMatch(/Binance/);

    // Move Coinbase up one place and confirm the list reflects it.
    await user.click(screen.getByRole('button', { name: /move coinbase earlier/i }));
    await waitFor(() => expect(rendered()[0]).toMatch(/Coinbase/));
    expect(rendered()[1]).toMatch(/Binance/);

    // The simulator is never reorderable, so it always sits last.
    expect(rendered()[rendered().length - 1]).toMatch(/Built-in simulator/);
  });
});
