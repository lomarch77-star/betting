'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const NAV: Array<{ section: string; items: Array<{ href: string; label: string; pip: string }> }> = [
  {
    section: 'Terminal',
    items: [
      { href: '/', label: 'Dashboard', pip: '▤' },
      { href: '/matches', label: 'Matches', pip: '⚽' },
      { href: '/scanner', label: 'Market Scanner', pip: '◎' },
    ],
  },
  {
    section: 'Research',
    items: [
      { href: '/research', label: 'Research Lab', pip: '⚗' },
      { href: '/models', label: 'Models', pip: '∑' },
      { href: '/backtests', label: 'Backtests', pip: '⚒' },
      { href: '/edges', label: 'Edge Registry', pip: '▣' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { href: '/portfolio', label: 'Paper Portfolio', pip: '▦' },
      { href: '/data-quality', label: 'Data Quality', pip: '✓' },
      { href: '/settings', label: 'Settings', pip: '⚙' },
    ],
  },
];

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const seg = pathname.split('/')[1];
  const map: Record<string, string> = {
    matches: 'Matches',
    scanner: 'Market Scanner',
    research: 'Research Lab',
    models: 'Models',
    backtests: 'Backtests',
    edges: 'Edge Registry',
    portfolio: 'Paper Portfolio',
    'data-quality': 'Data Quality',
    settings: 'Settings',
  };
  return map[seg] ?? 'Terminal';
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-title">MM·TERMINAL</div>
        <div className="brand-sub">Match-Market Research</div>
      </div>
      <nav className="nav">
        {NAV.map((s) => (
          <div key={s.section}>
            <div className="nav-section">{s.section}</div>
            {s.items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className={`nav-item ${pathname === i.href || (i.href !== '/' && pathname.startsWith(i.href)) ? 'active' : ''}`}
              >
                <span className="pip">{i.pip}</span>
                {i.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        Quantitative research terminal.
        <br />
        prediction ≠ probability ≠ price ≠ value
      </div>
    </aside>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="topbar">
      <span className="topbar-path">
        RESEARCH / <b>{titleFor(pathname)}</b>
      </span>
      <div className="topbar-right">
        <span className="badge demo">
          <span className="dot" />
          DEMO DATASET
        </span>
        <span className="badge">
          <span className="dot" />
          OFFLINE-CAPABLE
        </span>
        <span className="num dim small" style={{ minWidth: 62, textAlign: 'right' }}>
          {clock} UTC
        </span>
      </div>
    </div>
  );
}
