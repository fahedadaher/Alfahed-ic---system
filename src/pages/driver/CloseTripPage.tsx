// =====================================================================
// Close trip page (driver).
//
// Online-only: collects closing cash + notes, fires `rpc:close_trip`.
// The sync engine refuses to enqueue this op while offline so the
// driver gets immediate, honest feedback.
// =====================================================================

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useOnline } from '../../lib/network/network-monitor';
import { tripsRepo, salesRepo, returnsRepo } from '../../lib/db/repositories';
import { tripsService } from '../../features/trips/trips.service';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';

export function CloseTripPage() {
  const nav = useNavigate();
  const online = useOnline();
  const { userId } = useAuth();
  const t = useT();

  const trip = useLiveQuery(
    async () => userId ? tripsRepo.active(userId) : undefined,
    [userId],
  );

  const sales = useLiveQuery(
    async () => trip ? salesRepo.forTrip(trip.id) : [],
    [trip?.id],
  ) ?? [];

  const returns = useLiveQuery(
    async () => trip ? returnsRepo.forTrip(trip.id) : [],
    [trip?.id],
  ) ?? [];

  const [closingCash, setClosingCash] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!trip) return <div className="card">{t('close.no_active_trip')}</div>;

  const cashSales        = sales.filter(s => s.payment_method === 'cash');
  const cashCollected    = cashSales.reduce((a, s) => a + s.paid_amount, 0);
  const expectedClosing  = trip.opening_cash + cashCollected;
  const unsyncedCount    = sales.filter(s => !s.synced_at).length + returns.filter(r => !r.synced_at).length;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trip || !userId) return;
    setErr(null); setBusy(true);
    try {
      await tripsService.close({
        tripId: trip.id,
        closingCash,
        notes: notes.trim() || null,
        userId,
      });
      nav('/');
    } catch (e) {
      if (e instanceof OfflineForbiddenError) {
        setErr(t('close.offline_blocked'));
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally { setBusy(false); }
  }

  return (
    <form className="col" onSubmit={onSubmit}>
      <div className="card col">
        <strong>{t('close.summary')}</strong>
        <div className="kvp"><span className="k">{t('driver.trip')}</span><span className="v">{trip.id.slice(0,8)}</span></div>
        <div className="kvp"><span className="k">{t('driver.opening_cash')}</span><span className="v">{trip.opening_cash.toFixed(2)}</span></div>
        <div className="kvp"><span className="k">{t('close.cash_sales')}</span><span className="v">{cashSales.length} · {cashCollected.toFixed(2)}</span></div>
        <div className="kvp"><span className="k">{t('close.total_sales')}</span><span className="v">{sales.length}</span></div>
        <div className="kvp"><span className="k">{t('close.returns')}</span><span className="v">{returns.length}</span></div>
        <div className="kvp">
          <span className="k">{t('close.expected_closing')}</span>
          <span className="v">{expectedClosing.toFixed(2)}</span>
        </div>
      </div>

      {unsyncedCount > 0 && (
        <div className="badge warn">
          {t('sync.queued', { n: unsyncedCount })}
        </div>
      )}

      <div className="card col">
        <label className="col" style={{ gap: 4 }}>
          <span className="small muted">{t('close.cash_counted')}</span>
          <input type="number" min={0} step="0.01" required
            value={closingCash} onChange={e => setClosingCash(Number(e.target.value))} />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="small muted">{t('common.notes')}</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </label>
        <div className="kvp">
          <span className="k">{t('close.variance')}</span>
          <span className={`v badge ${closingCash === expectedClosing ? 'ok' : 'warn'}`}>
            {(closingCash - expectedClosing).toFixed(2)}
          </span>
        </div>
      </div>

      {!online && <div className="badge danger">{t('close.offline_blocked')}</div>}
      {err && <div className="badge danger">{err}</div>}

      <div className="row">
        <button type="button" className="ghost grow" onClick={() => nav(-1)}>{t('common.cancel')}</button>
        <button type="submit" className="grow" disabled={busy || !online}>
          {busy ? t('common.saving') : t('close.confirm')}
        </button>
      </div>
    </form>
  );
}
