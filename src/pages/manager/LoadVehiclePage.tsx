// =====================================================================
// Vehicle loading page (manager).
//
// Online-only. Manager picks an active trip, then fills in product
// quantities to load. Available factory stock is shown per line.
// =====================================================================

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useOnline } from '../../lib/network/network-monitor';
import { db } from '../../lib/db/indexeddb';
import { productsRepo } from '../../lib/db/repositories';
import { vehicleLoadsService, type LoadLine } from '../../features/vehicles/vehicle-loads.service';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';
import type { Product } from '../../types/domain';

export function LoadVehiclePage() {
  const nav = useNavigate();
  const online = useOnline();
  const { userId, profile } = useAuth();
  const t = useT();

  const products = useLiveQuery(() => productsRepo.list(), []) ?? [];
  const productById = new Map<string, Product>(products.map(p => [p.id, p]));

  const trips = useLiveQuery(
    () => db.trips.filter(t => t.status === 'planned' || t.status === 'loaded').toArray(),
    [],
  ) ?? [];

  const inventory = useLiveQuery(
    async () => profile?.factory_id
      ? db.inventory_balances.where('factory_id').equals(profile.factory_id).toArray()
      : [],
    [profile?.factory_id],
  ) ?? [];

  const stockMap = new Map(inventory.map(b => [b.product_id, b.quantity]));

  const [tripId, setTripId] = useState('');
  const [lines,  setLines]  = useState<LoadLine[]>([]);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);

  function addLine()                       { setLines([...lines, { product_id: '', quantity: 0 }]); }
  function rmLine(idx: number)             { setLines(lines.filter((_, i) => i !== idx)); }
  function setLine(idx: number, patch: Partial<LoadLine>) {
    const next = [...lines]; next[idx] = { ...next[idx]!, ...patch }; setLines(next);
  }

  const selectedTrip = trips.find(t => t.id === tripId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!userId || !profile?.factory_id || !selectedTrip) return;
    setErr(null); setBusy(true);
    try {
      await vehicleLoadsService.load({
        tripId: selectedTrip.id,
        vehicleId: selectedTrip.vehicle_id,
        factoryId: profile.factory_id,
        userId,
        lines: lines.filter(l => l.product_id && l.quantity > 0),
      });
      nav('/');
    } catch (e) {
      if (e instanceof OfflineForbiddenError) setErr(t('load.offline_blocked'));
      else setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <form className="col" onSubmit={onSubmit}>
      <div className="card col">
        <strong>{t('load.select_trip')}</strong>
        {trips.length === 0
          ? <div className="list-empty small">{t('load.no_trip')}</div>
          : (
            <select value={tripId} onChange={e => setTripId(e.target.value)} required>
              <option value="">{t('load.select_trip')}</option>
              {trips.map(tr => (
                <option key={tr.id} value={tr.id}>
                  {t('driver.trip')} {tr.id.slice(0,8)} · {tr.status} · {tr.vehicle_id.slice(0,8)}
                </option>
              ))}
            </select>
          )}
      </div>

      <div className="card col">
        <div className="row"><strong className="grow">{t('sale.items')}</strong>
          <button type="button" className="secondary small" onClick={addLine}>{t('sale.add_line')}</button>
        </div>

        {lines.length === 0 && <div className="list-empty small">{t('sale.no_lines')}</div>}

        {lines.map((ln, idx) => {
          const avail = ln.product_id ? (stockMap.get(ln.product_id) ?? 0) : 0;
          const over  = ln.quantity > avail;
          return (
            <div key={idx} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <select value={ln.product_id} onChange={e => setLine(idx, { product_id: e.target.value })}>
                <option value="">{t('sale.select_product')}</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <label className="col" style={{ gap: 4 }}>
                <span className="small muted">
                  {t('load.qty_to_load')} {ln.product_id ? `· ${t('load.factory_available', { qty: `${avail} ${productById.get(ln.product_id)?.unit ?? ''}` })}` : ''}
                </span>
                <input type="number" min={0} step="1" value={ln.quantity}
                  onChange={e => setLine(idx, { quantity: Number(e.target.value) })} />
              </label>
              {over && <div className="badge danger">{t('sale.insufficient_stock', { name: productById.get(ln.product_id)?.name ?? '', req: ln.quantity, avail })}</div>}
              <button type="button" className="ghost small" onClick={() => rmLine(idx)}>{t('common.remove')}</button>
            </div>
          );
        })}
      </div>

      {!online && <div className="badge danger">{t('load.offline_blocked')}</div>}
      {err && <div className="badge danger">{err}</div>}

      <div className="row">
        <button type="button" className="ghost grow" onClick={() => nav(-1)}>{t('common.cancel')}</button>
        <button type="submit" className="grow"
          disabled={busy || !online || !tripId || lines.length === 0
                    || lines.some(l => !l.product_id || l.quantity <= 0
                      || l.quantity > (stockMap.get(l.product_id) ?? 0))}>
          {busy ? t('common.saving') : t('load.confirm')}
        </button>
      </div>
    </form>
  );
}
