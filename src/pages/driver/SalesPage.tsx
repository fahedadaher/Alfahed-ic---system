// =====================================================================
// Sales page. POS-like form for the driver:
//   - Customer search (offline, from local cache).
//   - Product picker, quantity, auto-resolved unit price.
//   - Payment method, paid amount.
//   - Submits via salesService.create — works offline.
// =====================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  customersRepo, productsRepo, pricesRepo, vehicleStockRepo, tripsRepo,
} from '../../lib/db/repositories';
import { salesService, InsufficientStockError } from '../../features/sales/sales.service';
import { useT } from '../../lib/i18n';
import type { Customer, Product, PaymentMethod } from '../../types/domain';

interface Line {
  product_id: string;
  quantity: number;
  unit_price: number;
}

export function SalesPage() {
  const nav = useNavigate();
  const { userId } = useAuth();
  const t = useT();
  const trip = useLiveQuery(
    async () => userId ? tripsRepo.active(userId) : undefined,
    [userId],
  );

  const products = useLiveQuery(() => productsRepo.list(), []) ?? [];

  const [customerQuery, setCustomerQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const customerResults = useLiveQuery(
    () => customersRepo.search(customerQuery),
    [customerQuery],
  ) ?? [];

  const [lines, setLines] = useState<Line[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  useEffect(() => { setPaidAmount(total); }, [total]);

  function addLine() {
    setLines([...lines, { product_id: '', quantity: 1, unit_price: 0 }]);
  }

  async function updateLine(idx: number, patch: Partial<Line>) {
    const next = [...lines];
    next[idx] = { ...next[idx]!, ...patch };
    // Auto-resolve price when product changes.
    if (patch.product_id !== undefined && patch.product_id) {
      const price = await pricesRepo.resolve(customer?.id ?? null, patch.product_id);
      if (price !== null) next[idx]!.unit_price = price;
    }
    setLines(next);
  }

  function removeLine(idx: number) {
    setLines(lines.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trip || !userId) return;
    setErr(null);
    setBusy(true);
    try {
      await salesService.create({
        trip_id: trip.id,
        vehicle_id: trip.vehicle_id,
        driver_id: userId,
        customer_id: customer?.id ?? null,
        payment_method: paymentMethod,
        paid_amount: paidAmount,
        lines: lines.filter(l => l.product_id && l.quantity > 0),
      });
      nav('/');
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        const p = products.find(x => x.id === e.productId);
        setErr(t('sale.insufficient_stock', {
          name: p?.name ?? e.productId,
          req: e.requested,
          avail: e.available,
        }));
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!trip) return <div className="card">{t('sale.no_active_trip')}</div>;

  return (
    <form className="col" onSubmit={onSubmit}>
      <div className="card col">
        <strong>{t('sale.customer')}</strong>
        {customer
          ? (
            <div className="row">
              <span className="grow"><strong>{customer.name}</strong> <span className="muted small">({customer.code})</span></span>
              <button type="button" className="ghost small" onClick={() => setCustomer(null)}>{t('sale.change')}</button>
            </div>
          )
          : (
            <>
              <input
                placeholder={t('sale.search_customer')}
                value={customerQuery}
                onChange={e => setCustomerQuery(e.target.value)}
              />
              <div className="col" style={{ maxHeight: 220, overflow: 'auto' }}>
                {customerResults.slice(0, 20).map(c => (
                  <button
                    key={c.id} type="button" className="ghost"
                    onClick={() => { setCustomer(c); setCustomerQuery(''); }}
                  >
                    {c.name} <span className="muted small">— {c.code}</span>
                  </button>
                ))}
                <button type="button" className="ghost small" onClick={() => setCustomer(null)}>
                  {t('sale.walkin')}
                </button>
              </div>
            </>
          )}
      </div>

      <div className="card col">
        <div className="row"><strong className="grow">{t('sale.items')}</strong>
          <button type="button" className="secondary small" onClick={addLine}>{t('sale.add_line')}</button>
        </div>

        {lines.length === 0 && <div className="list-empty small">{t('sale.no_lines')}</div>}

        {lines.map((ln, idx) => (
          <LineEditor
            key={idx}
            line={ln}
            products={products}
            vehicleId={trip.vehicle_id}
            t={t}
            onChange={patch => void updateLine(idx, patch)}
            onRemove={() => removeLine(idx)}
          />
        ))}

        <div className="kvp"><span className="k">{t('common.total')}</span><span className="v">{total.toFixed(2)}</span></div>
      </div>

      <div className="card col">
        <strong>{t('sale.payment')}</strong>
        <label className="col" style={{ gap: 4 }}>
          <span className="small muted">{t('sale.method')}</span>
          <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as PaymentMethod)}>
            <option value="cash">{t('sale.method.cash')}</option>
            <option value="credit">{t('sale.method.credit')}</option>
            <option value="transfer">{t('sale.method.transfer')}</option>
          </select>
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="small muted">{t('sale.paid_amount')}</span>
          <input type="number" step="0.01" min={0}
            value={paidAmount} onChange={e => setPaidAmount(Number(e.target.value))} />
        </label>
      </div>

      {err && <div className="badge danger">{err}</div>}

      <div className="row">
        <button type="button" className="ghost grow" onClick={() => nav(-1)}>{t('common.cancel')}</button>
        <button type="submit" className="grow" disabled={busy || lines.length === 0}>
          {busy ? t('common.saving') : t('sale.save')}
        </button>
      </div>
    </form>
  );
}

function LineEditor({ line, products, vehicleId, t, onChange, onRemove }: {
  line: Line;
  products: Product[];
  vehicleId: string;
  t: (k: string, p?: Record<string, string | number>) => string;
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const available = useLiveQuery(
    async () => line.product_id ? vehicleStockRepo.available(vehicleId, line.product_id) : 0,
    [vehicleId, line.product_id],
  ) ?? 0;

  return (
    <div className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <select value={line.product_id} onChange={e => onChange({ product_id: e.target.value })}>
        <option value="">{t('sale.select_product')}</option>
        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="row">
        <label className="grow col" style={{ gap: 4 }}>
          <span className="small muted">{t('sale.qty')} ({t('sale.qty_available', { qty: available })})</span>
          <input type="number" min={1} step="1" value={line.quantity}
            onChange={e => onChange({ quantity: Number(e.target.value) })} />
        </label>
        <label className="grow col" style={{ gap: 4 }}>
          <span className="small muted">{t('sale.unit_price')}</span>
          <input type="number" min={0} step="0.01" value={line.unit_price}
            onChange={e => onChange({ unit_price: Number(e.target.value) })} />
        </label>
      </div>
      <button type="button" className="ghost small" onClick={onRemove}>{t('common.remove')}</button>
    </div>
  );
}
