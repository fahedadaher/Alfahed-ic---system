// =====================================================================
// Factory manager home. Three sections:
//   - Factory inventory (read-only summary, sourced from balances).
//   - Active trips (status overview).
//   - Production approvals queue.
// =====================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useOnline } from '../../lib/network/network-monitor';
import { db } from '../../lib/db/indexeddb';
import { productsRepo } from '../../lib/db/repositories';
import { approvalsService } from '../../features/approvals/approvals.service';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';
import type { Product } from '../../types/domain';

export function ManagerHome() {
  const { userId, profile } = useAuth();
  const online = useOnline();
  const t = useT();

  const products = useLiveQuery(() => productsRepo.list(), []) ?? [];
  const productById = new Map<string, Product>(products.map(p => [p.id, p]));

  const inventory = useLiveQuery(
    async () => profile?.factory_id
      ? db.inventory_balances.where('factory_id').equals(profile.factory_id).toArray()
      : [],
    [profile?.factory_id],
  ) ?? [];

  const trips = useLiveQuery(
    () => db.trips.filter(t => t.status === 'in_progress' || t.status === 'loaded').toArray(),
    [],
  ) ?? [];

  const pendingProduction = useLiveQuery(
    () => db.approvals.where('kind').equals('production').filter(a => a.status === 'pending').toArray(),
    [],
  ) ?? [];

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    if (!userId) return;
    setErr(null); setBusy(approvalId);
    try {
      await approvalsService.decide({
        approvalId, kind: 'production', decision, notes: null, userId,
      });
    } catch (e) {
      if (e instanceof OfflineForbiddenError) setErr(t('offline.approve_unavailable'));
      else setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <div className="col">
      <div className="row">
        <Link to="/manager/load" className="grow">
          <button style={{ width: '100%' }}>{t('nav.inventory')}</button>
        </Link>
        <Link to="/sync" className="grow">
          <button className="ghost" style={{ width: '100%' }}>{t('nav.sync')}</button>
        </Link>
      </div>

      <div className="card col">
        <strong>{t('manager.factory_inventory')}</strong>
        {inventory.length === 0
          ? <div className="list-empty small">{t('manager.no_stock')}</div>
          : inventory.map(b => (
              <div key={`${b.factory_id}-${b.product_id}`} className="kvp">
                <span className="k">{productById.get(b.product_id)?.name ?? b.product_id}</span>
                <span className="v">{b.quantity}</span>
              </div>
            ))}
      </div>

      <div className="card col">
        <strong>{t('manager.active_trips')}</strong>
        {trips.length === 0
          ? <div className="list-empty small">{t('manager.no_trips')}</div>
          : trips.map(tr => (
              <div key={tr.id} className="kvp">
                <span className="k">{t('driver.trip')} {tr.id.slice(0,8)} · {tr.status}</span>
                <span className="v small muted">{tr.started_at ? new Date(tr.started_at).toLocaleTimeString() : '—'}</span>
              </div>
            ))}
      </div>

      <div className="card col">
        <strong>{t('approval.production.title')}</strong>
        {!online && <div className="badge warn">{t('offline.approve_unavailable')}</div>}
        {pendingProduction.length === 0
          ? <div className="list-empty small">{t('approval.none_pending')}</div>
          : pendingProduction.map(a => (
              <div key={a.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="kvp"><span className="k">{t('approval.reference')}</span><span className="v">{a.reference_id.slice(0,8)}</span></div>
                {a.amount != null && <div className="kvp"><span className="k">{t('approval.qty')}</span><span className="v">{a.amount}</span></div>}
                {a.notes && <div className="muted small">{a.notes}</div>}
                <div className="row">
                  <button className="grow danger" disabled={!online || busy === a.id}
                    onClick={() => void decide(a.id, 'rejected')}>{t('approval.reject')}</button>
                  <button className="grow" disabled={!online || busy === a.id}
                    onClick={() => void decide(a.id, 'approved')}>{t('approval.approve')}</button>
                </div>
              </div>
            ))}
        {err && <div className="badge danger">{err}</div>}
      </div>
    </div>
  );
}
