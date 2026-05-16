// =====================================================================
// Cashier home. Queue of pending cashier approvals (e.g. trip closures
// awaiting reconciliation). Approve / reject buttons fire online-only
// RPCs via the sync engine.
// =====================================================================

import { useState } from 'react';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { db } from '../../lib/db/indexeddb';
import { useOnline } from '../../lib/network/network-monitor';
import { approvalsService } from '../../features/approvals/approvals.service';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';

export function CashierHome() {
  const { userId } = useAuth();
  const online = useOnline();
  const t = useT();

  const pending = useLiveQuery(
    () => db.approvals.where('kind').equals('cashier').filter(a => a.status === 'pending').toArray(),
    [],
  ) ?? [];

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    if (!userId) return;
    setErr(null); setBusy(approvalId);
    try {
      await approvalsService.decide({
        approvalId, kind: 'cashier', decision, notes: null, userId,
      });
    } catch (e) {
      if (e instanceof OfflineForbiddenError) setErr(t('offline.approve_unavailable'));
      else setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <div className="col">
      <div className="card col">
        <strong>{t('approval.cashier.title')}</strong>
        {!online && <div className="badge warn">{t('offline.approve_unavailable')}</div>}
        {pending.length === 0 && <div className="list-empty small">{t('approval.all_done')}</div>}
        {pending.map(a => (
          <div key={a.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div className="kvp"><span className="k">{t('approval.reference')}</span><span className="v">{a.reference_type} · {a.reference_id.slice(0,8)}</span></div>
            {a.amount != null && <div className="kvp"><span className="k">{t('common.amount')}</span><span className="v">{a.amount}</span></div>}
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
