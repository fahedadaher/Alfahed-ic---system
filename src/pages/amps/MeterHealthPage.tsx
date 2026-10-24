// =====================================================================
// Meter system health + amp change report.
//
// Counters are computed from the local snapshot (offline-capable);
// "Run check now" asks the server to re-scan (online-only) — the server
// also runs it on every gateway tick.
// =====================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useOnline } from '../../lib/network/network-monitor';
import { db, getMeta } from '../../lib/db/indexeddb';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';
import { ampsService, ampsRepo, changeReportCsv } from '../../features/amps/amps.service';
import type { AmpSubscription, SmartMeter } from '../../types/domain';
import { alertText, fmtTime } from './amp-format';

export function MeterHealthPage() {
  const { userId, can } = useAuth();
  const online = useOnline();
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const data = useLiveQuery(async () => {
    const [subs, meters, commands, alerts, changes, profiles, lastRun] = await Promise.all([
      db.amp_subscriptions.toArray(),
      db.smart_meters.toArray(),
      db.meter_commands.toArray(),
      ampsRepo.openAlerts(),
      db.amp_change_log.toArray(),
      db.profiles.toArray(),
      getMeta<{ checked_at?: string }>('meter_health_last'),
    ]);
    const meterById = new Map<string, SmartMeter>(meters.map(m => [m.id, m]));
    const dayAgo = Date.now() - 24 * 3600_000;
    return {
      subs, meters, alerts, changes, lastRun, meterById,
      subById: new Map<string, AmpSubscription>(subs.map(s => [s.id, s])),
      nameById: new Map(profiles.map(p => [p.id, p.full_name])),
      offline:      meters.filter(m => m.active && m.connection_status === 'offline'),
      unlinked:     subs.filter(s => s.status === 'active' && !s.meter_id),
      mismatches:   subs.filter(s => {
        const m = s.meter_id ? meterById.get(s.meter_id) : undefined;
        return s.status === 'active' && m?.confirmed_amps != null && m.confirmed_amps !== s.registered_amps;
      }),
      failedCmds:   commands.filter(c => (c.status === 'failed' || c.status === 'expired') && Date.parse(c.updated_at) > dayAgo),
      syncFailures: alerts.filter(a => a.kind === 'sync_failed'),
    };
  }, []);

  if (!data) return <div className="card">{t('common.loading')}</div>;

  const inRange = data.changes.filter(c =>
    (!from || c.changed_at >= from) && (!to || c.changed_at.slice(0, 10) <= to));
  const sortedRange = [...inRange].sort((a, b) => b.changed_at.localeCompare(a.changed_at));

  async function run(fn: () => Promise<unknown>) {
    if (!userId) return;
    setErr(null); setBusy(true);
    try { await fn(); }
    catch (e) { setErr(e instanceof OfflineForbiddenError ? t('amps.err.offline') : e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function exportCsv() {
    const csv = changeReportCsv(inRange, data!.subById, data!.meterById, id => (id ? data!.nameById.get(id) ?? id : ''));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `amp-changes-${from || 'all'}-${to || 'now'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const counter = (label: string, n: number) => (
    <div className="kvp">
      <span className="k">{label}</span>
      <span className={`v badge ${n > 0 ? 'danger' : 'ok'}`}>{n}</span>
    </div>
  );

  return (
    <div className="col">
      <div className="card col">
        <strong>{t('health.title')}</strong>
        {counter(t('health.offline_meters'),  data.offline.length)}
        {counter(t('health.unlinked'),        data.unlinked.length)}
        {counter(t('health.mismatches'),      data.mismatches.length)}
        {counter(t('health.failed_commands'), data.failedCmds.length)}
        {counter(t('health.sync_failures'),   data.syncFailures.length)}
        {data.lastRun?.checked_at && <div className="small muted">{t('health.last_run', { at: fmtTime(data.lastRun.checked_at, t) })}</div>}
        {can('amp.manage') && (
          <button disabled={!online || busy} onClick={() => void run(() => ampsService.runHealthCheck(userId!))}>
            {t('health.run')}
          </button>
        )}
      </div>

      <div className="card col">
        <strong>{t('health.alerts')} ({data.alerts.length})</strong>
        {data.alerts.length === 0 && <div className="list-empty small">{t('health.no_alerts')}</div>}
        {data.alerts.map(a => {
          const sub = a.subscription_id ? data.subById.get(a.subscription_id) : undefined;
          const meter = a.meter_id ? data.meterById.get(a.meter_id) : undefined;
          return (
            <div key={a.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div className="kvp">
                <span className={`badge ${a.kind === 'meter_offline' || a.kind === 'sync_failed' ? 'warn' : 'danger'}`}>
                  {t(`health.alert.${a.kind}`)}
                </span>
                <span className="small muted">{fmtTime(a.last_seen_at, t)}</span>
              </div>
              <div className="small">{alertText(a, t, sub, meter)}</div>
              {(a.kind === 'sync_failed' || a.kind === 'command_failed') && <div className="small muted">{a.message}</div>}
              {a.occurrences > 1 && <div className="small muted">{t('health.occurrences', { n: a.occurrences })}</div>}
              <div className="row">
                {sub && <Link to={`/amps/${sub.id}`} className="grow small">{sub.subscription_no}</Link>}
                {can('amp.manage') && (
                  <button className="ghost" disabled={!online || busy}
                    onClick={() => void run(() => ampsService.resolveAlert(a.id, null, userId!))}>
                    {t('health.resolve')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {err && <div className="badge danger">{err}</div>}

      {can('amp.report') && (
        <div className="card col">
          <strong>{t('report.amp_changes')}</strong>
          <div className="row">
            <label className="col grow"><span className="small muted">{t('report.from')}</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="col grow"><span className="small muted">{t('report.to')}</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          </div>
          <div className="kvp">
            <span className="small muted">{t('report.rows', { n: inRange.length })}</span>
            <button className="ghost" disabled={inRange.length === 0} onClick={exportCsv}>{t('report.export_csv')}</button>
          </div>
          {sortedRange.slice(0, 100).map(c => (
            <div key={c.id} className="kvp small">
              <span className="k">
                {fmtTime(c.changed_at, t)} · {data.subById.get(c.subscription_id)?.subscription_no ?? '—'} · {t(`amps.src.${c.source}`)}
                {c.actor_id ? ` · ${data.nameById.get(c.actor_id) ?? ''}` : ''}
              </span>
              <span className="v">{t('amps.log.line', { from: c.previous_amps, to: c.new_amps })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
