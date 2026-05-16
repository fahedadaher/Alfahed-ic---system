// =====================================================================
// Sync queue inspector. Shows the outbox + recent conflicts so any
// user can see what's pending, retry failed ops, or discard ones that
// will never succeed.
//
// Available to all roles — visibility into "did my sale go through?"
// matters most to drivers, but everyone benefits.
// =====================================================================

import { useNavigate } from 'react-router-dom';
import { useLiveQuery, useSyncState } from '../hooks/useLiveQuery';
import { db } from '../lib/db/indexeddb';
import { syncEngine } from '../lib/sync/sync-engine';
import { useT } from '../lib/i18n';
import type { OutboxOperation, ConflictRecord } from '../types/sync';

export function SyncQueuePage() {
  const nav = useNavigate();
  const sync = useSyncState();
  const t = useT();

  const ops = useLiveQuery<OutboxOperation[]>(
    () => db.outbox.orderBy('client_timestamp').reverse().limit(50).toArray(),
    [],
  ) ?? [];

  const conflicts = useLiveQuery<ConflictRecord[]>(
    () => db.conflicts.filter(c => !c.resolved).reverse().sortBy('created_at'),
    [],
  ) ?? [];

  const grouped = {
    pending:   ops.filter(o => o.status === 'pending'),
    in_flight: ops.filter(o => o.status === 'in_flight'),
    failed:    ops.filter(o => o.status === 'failed'),
    conflict:  ops.filter(o => o.status === 'conflict'),
    synced:    ops.filter(o => o.status === 'synced'),
  };

  return (
    <div className="col">
      <div className="card col">
        <strong>{t('sync.state')}</strong>
        <div className="kvp"><span className="k">{t('sync.connection')}</span>
          <span className={`v badge ${sync.online ? 'ok' : 'danger'}`}>{sync.online ? t('sync.online') : t('sync.offline')}</span></div>
        <div className="kvp"><span className="k">{t('sync.pending')}</span><span className="v">{sync.pending}</span></div>
        <div className="kvp"><span className="k">{t('sync.in_flight')}</span><span className="v">{sync.in_flight}</span></div>
        <div className="kvp"><span className="k">{t('sync.failed_count')}</span>
          <span className={`v badge ${sync.failed > 0 ? 'danger' : 'ok'}`}>{sync.failed}</span></div>
        <button className="secondary" disabled={!sync.online} onClick={() => void syncEngine.drain()}>
          {t('sync.drain_now')}
        </button>
      </div>

      <Group title={t('sync.in_flight_section')} ops={grouped.in_flight} t={t} />
      <Group title={t('sync.pending_section')}   ops={grouped.pending}   t={t} />
      <Group title={t('sync.failed_section')}    ops={grouped.failed}    t={t} showActions />
      <Group title={t('sync.conflicts_section')} ops={grouped.conflict}  t={t} showActions />

      <div className="card col">
        <strong>{t('sync.unresolved')}</strong>
        {conflicts.length === 0
          ? <div className="list-empty small">{t('sync.none')}</div>
          : conflicts.map(c => (
              <div key={c.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="kvp"><span className="k">{c.entity_type}</span>
                  <span className="v small">{c.entity_id.slice(0,8)}</span></div>
                <div className="muted small">{c.reason}</div>
                <div className="row">
                  <button className="ghost small" onClick={() => void db.conflicts.update(c.id, {
                    resolved: true, resolution: 'server_wins',
                  })}>{t('sync.mark_resolved')}</button>
                </div>
              </div>
            ))}
      </div>

      <Group title={t('sync.recently_synced')} ops={grouped.synced.slice(0, 10)} t={t} />

      <button className="ghost" onClick={() => nav('/')}>{t('common.back')}</button>
    </div>
  );
}

function Group({ title, ops, t, showActions = false }: {
  title: string; ops: OutboxOperation[];
  t: (k: string, p?: Record<string, string | number>) => string;
  showActions?: boolean;
}) {
  if (ops.length === 0) return null;
  return (
    <div className="card col">
      <strong>{title} ({ops.length})</strong>
      {ops.map(op => (
        <div key={op.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div className="kvp">
            <span className="k">{op.operation}</span>
            <span className="v small muted">{new Date(op.client_timestamp).toLocaleTimeString()}</span>
          </div>
          <div className="kvp">
            <span className="k small">{op.entity_type}</span>
            <span className="v small">{op.entity_id.slice(0,8)}</span>
          </div>
          {op.attempts > 0 && (
            <div className="kvp"><span className="k small">{t('sync.attempts')}</span>
              <span className="v small">{op.attempts}</span></div>
          )}
          {op.last_error && <div className="badge danger small">{op.last_error}</div>}
          {showActions && (
            <div className="row">
              <button className="ghost small" onClick={() => void syncEngine.retry(op.id)}>{t('common.retry')}</button>
              <button className="danger small" onClick={() => void syncEngine.discard(op.id)}>{t('common.discard')}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
