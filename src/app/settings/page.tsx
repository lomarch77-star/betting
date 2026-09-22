import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { listAudit, getSetting } from '@/lib/db/repos-research';
import { resolveAuth } from '@/lib/auth';
import { Panel, Notice } from '@/components/ui';
import { ReseedButton } from '@/components/reseed-button';
import { fmtDateTime } from '@/lib/format';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

const API_ENDPOINTS = [
  ['GET', '/api/health', 'liveness + dataset counts'],
  ['GET', '/api/matches?status=&competitionId=&from=&to=', 'fixture list'],
  ['GET', '/api/matches/:id', 'full match research assembly'],
  ['GET', '/api/matches/:id/prediction', 'model probabilities + uncertainty'],
  ['GET', '/api/matches/:id/markets', 'derived-market probabilities + fair odds'],
  ['GET', '/api/matches/:id/odds', 'timestamped bookmaker snapshots'],
  ['GET', '/api/matches/:id/analyst', 'rules-based analyst summary'],
  ['GET', '/api/models', 'immutable version registry + live validation'],
  ['GET', '/api/models/:id/performance', 'OOS metrics for a version'],
  ['GET', '/api/scanner?market=&minEv=&agreement=', 'market scanner rows'],
  ['GET', '/api/backtests', 'run list'],
  ['POST', '/api/backtests', 'launch walk-forward run (researcher)'],
  ['GET', '/api/backtests/:id', 'run detail + progress + ledger'],
  ['GET', '/api/experiments', 'experiment list'],
  ['POST', '/api/experiments', 'create experiment (researcher)'],
  ['POST', '/api/experiments/:id/run', 'execute experiment (researcher)'],
  ['GET', '/api/edges', 'edge registry'],
  ['PATCH', '/api/edges/:id', 'status transition (researcher, restricted)'],
  ['GET', '/api/paper-portfolio', 'ledger + metrics'],
  ['POST', '/api/paper-portfolio', 'add pre-kickoff entry (researcher)'],
  ['GET', '/api/data-quality', 'latest DQ report'],
  ['POST', '/api/data-quality', 're-run checks (researcher)'],
  ['GET', '/api/catalog', 'competitions/seasons/bookmakers/markets'],
  ['GET', '/api/audit', 'audit log (admin)'],
  ['POST', '/api/admin/reseed', 'regenerate demo universe (admin)'],
];

export default async function SettingsPage() {
  ensureBootstrapped();
  const db = getDb();
  const hdrs = await headers();
  const auth = resolveAuth(new Request('http://internal', { headers: hdrs }));
  const auditRows = auth.role === 'admin' ? listAudit(db, 25) : [];
  const anchor = getSetting(db, 'demo_anchor');
  const fp = getSetting(db, 'demo_seed_fingerprint');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Settings &amp; Operations</div>
          <div className="page-sub">Environment configuration, auth mode, dataset state, API reference.</div>
        </div>
        <ReseedButton />
      </div>

      {!auth.demoAuthMode ? (
        <Notice kind="info">
          API keys are configured: read endpoints are open; mutations require x-api-key with the
          researcher role; admin endpoints require the admin key. Keys live ONLY in environment
          variables — nothing is committed to source.
        </Notice>
      ) : (
        <Notice kind="warn">
          DEMO_AUTH_MODE active: no API keys configured, so mutations are permitted and audit-logged
          under actor "demo-operator". Set RESEARCH_API_KEY / ADMIN_API_KEY to lock down.
        </Notice>
      )}

      <div style={{ height: 14 }} />
      <div className="grid cols-2">
        <Panel title="Environment">
          <table className="data">
            <tbody>
              <tr><td>Database</td><td className="num">{process.env.DATABASE_PATH ?? './data/terminal.sqlite'} (SQLite; PG-adapter-ready repository layer)</td></tr>
              <tr><td>Demo seed</td><td className="num">{process.env.DEMO_SEED ?? '42'}</td></tr>
              <tr><td>Demo anchor date</td><td className="num">{anchor ?? '—'}</td></tr>
              <tr><td>Seed fingerprint</td><td className="num">{fp ?? '—'}</td></tr>
              <tr><td>Auth mode</td><td className="num">{auth.demoAuthMode ? 'DEMO_AUTH_MODE' : `role: ${auth.role}`}</td></tr>
              <tr><td>Rate limit</td><td className="num">{process.env.API_RATE_LIMIT_PER_MIN ?? '240'} req/min/IP</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Security Model">
          <div className="mono-block">{`Roles: reader < researcher < admin
Header: x-api-key (research / admin keys from env)
Rate limiting: per-IP token bucket on /api/*
Audit: every mutation written to audit_log
Validation: zod schemas on all API inputs
Immutability: model_versions & predictions insert-only
Secrets: environment-only; none committed
PII: none — synthetic demo universe`}</div>
        </Panel>
      </div>

      <div style={{ height: 14 }} />
      <Panel title="API Reference (Read vs Research/Admin)" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Method</th>
                <th>Endpoint</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {API_ENDPOINTS.map(([m, p, d]) => (
                <tr key={`${m}${p}`}>
                  <td><span className={`badge ${m === 'GET' ? '' : 'info'}`}>{m}</span></td>
                  <td className="num small">{p}</td>
                  <td className="small dim">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div style={{ height: 14 }} />
      <Panel title={`Recent Audit Events (${auditRows.length})`}>
        {auth.role !== 'admin' && auth.demoAuthMode === false ? (
          <div className="muted-box">Admin role required to view the audit log.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>At</th>
                <th>Actor</th>
                <th>Role</th>
                <th>Action</th>
                <th>Entity</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((r) => (
                <tr key={r.id}>
                  <td className="small faint">{fmtDateTime(r.at)}</td>
                  <td className="small">{r.actor}</td>
                  <td className="small dim">{r.role}</td>
                  <td className="small strong">{r.action}</td>
                  <td className="small dim">
                    {r.entity}
                    {r.entity_id ? ` #${r.entity_id}` : ''}
                  </td>
                </tr>
              ))}
              {auditRows.length === 0 && (
                <tr><td colSpan={5} className="muted-box">No audit events yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
