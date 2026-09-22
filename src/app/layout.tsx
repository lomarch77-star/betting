import type { Metadata } from 'next';
import './globals.css';
import { Sidebar, TopBar } from '@/components/shell';
import { ensureBootstrapped } from '@/lib/bootstrap';

export const metadata: Metadata = {
  title: 'Match Markets Terminal — Quantitative Football Research',
  description:
    'Quantitative football match-market research: probability models, calibration, fair odds, market comparison, backtesting and audit. Demo dataset.',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // idempotent: seeds demo universe, runs DQ, kicks off default backtest
  ensureBootstrapped();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar />
          <div className="main">
            <TopBar />
            <div className="content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
