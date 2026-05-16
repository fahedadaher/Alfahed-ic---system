// =====================================================================
// Driver home. Active trip + vehicle stock + recent sales. Quick links
// to record a sale or a return.
// =====================================================================

import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { tripsRepo, vehicleStockRepo, salesRepo, productsRepo } from '../../lib/db/repositories';
import { tripsService } from '../../features/trips/trips.service';
import { useT } from '../../lib/i18n';
import type { Product } from '../../types/domain';

export function DriverHome() {
  const { userId } = useAuth();
  const t = useT();

  const trip = useLiveQuery(
    async () => userId ? tripsRepo.active(userId) : undefined,
    [userId],
  );

  const stock = useLiveQuery(
    async () => trip ? vehicleStockRepo.forVehicle(trip.vehicle_id) : [],
    [trip?.vehicle_id],
  ) ?? [];

  const products = useLiveQuery(() => productsRepo.list(), []) ?? [];
  const productById = new Map<string, Product>(products.map(p => [p.id, p]));

  const sales = useLiveQuery(
    async () => trip ? salesRepo.forTrip(trip.id) : [],
    [trip?.id],
  ) ?? [];

  if (!trip) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t('driver.no_active_trip')}</h2>
        <p className="muted">{t('driver.wait_for_load')}</p>
      </div>
    );
  }

  return (
    <div className="col">
      <div className="card col">
        <div className="row">
          <strong>{t('driver.trip')} {trip.id.slice(0, 8)}</strong>
          <span className={`badge ${trip.status === 'in_progress' ? 'ok' : ''}`}>{trip.status}</span>
        </div>
        <div className="kvp"><span className="k">{t('driver.opening_cash')}</span><span className="v">{trip.opening_cash}</span></div>
        {trip.status === 'loaded' && (
          <button onClick={() => userId && void tripsService.markInProgress(trip.id, userId)}>
            {t('driver.start_trip')}
          </button>
        )}
      </div>

      <div className="card col">
        <strong>{t('driver.vehicle_stock')}</strong>
        {stock.length === 0
          ? <div className="list-empty small">{t('driver.vehicle_empty')}</div>
          : stock.map(s => (
              <div key={s.product_id} className="kvp">
                <span className="k">{productById.get(s.product_id)?.name ?? s.product_id}</span>
                <span className="v">{s.quantity}</span>
              </div>
            ))}
      </div>

      <div className="row">
        <Link to="/sales/new"   className="grow"><button style={{ width: '100%' }}>{t('driver.new_sale')}</button></Link>
        <Link to="/returns/new" className="grow"><button className="secondary" style={{ width: '100%' }}>{t('driver.new_return')}</button></Link>
      </div>

      <div className="row">
        <Link to="/sync" className="grow">
          <button className="ghost" style={{ width: '100%' }}>{t('nav.sync')}</button>
        </Link>
        {trip.status === 'in_progress' && (
          <Link to="/trip/close" className="grow">
            <button className="secondary" style={{ width: '100%' }}>{t('driver.close_trip')}</button>
          </Link>
        )}
      </div>

      <div className="card col">
        <strong>{t('driver.recent_sales')}</strong>
        {sales.length === 0
          ? <div className="list-empty small">{t('driver.no_sales_yet')}</div>
          : sales.slice(0, 20).map(s => (
              <div key={s.id} className="kvp">
                <span className="k">
                  {new Date(s.client_created_at).toLocaleTimeString()} · {s.payment_method ?? '—'}
                </span>
                <span className="v">
                  {s.total_amount.toFixed(2)}{' '}
                  <span className={`badge ${s.synced_at ? 'ok' : 'warn'}`}>
                    {s.synced_at ? t('sync.synced') : t('sync.queued', { n: 1 })}
                  </span>
                </span>
              </div>
            ))}
      </div>
    </div>
  );
}
