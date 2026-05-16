// =====================================================================
// Owner home. KPIs at a glance + everything the other roles see.
// In a real deployment this is the place to add user management and
// system settings (linked out from here).
// =====================================================================

import { useLiveQuery } from '../../hooks/useLiveQuery';
import { db } from '../../lib/db/indexeddb';
import { useT } from '../../lib/i18n';

export function OwnerHome() {
  const t = useT();
  const stats = useLiveQuery(async () => {
    const [
      driverCount, vehicleCount, customerCount,
      pendingApprovals, failedOps,
    ] = await Promise.all([
      db.profiles.where('role').equals('driver').count(),
      db.vehicles.count(),
      db.customers.count(),
      db.approvals.where('status').equals('pending').count(),
      db.outbox.where('status').equals('failed').count(),
    ]);
    const sales = await db.sales.toArray();
    const totalRevenue = sales.reduce((s, x) => s + x.total_amount, 0);
    return { driverCount, vehicleCount, customerCount, pendingApprovals, failedOps, totalRevenue };
  }, []) ?? null;

  if (!stats) return <div className="card">{t('common.loading')}</div>;

  return (
    <div className="col">
      <div className="card col">
        <strong>{t('owner.snapshot')}</strong>
        <div className="kvp"><span className="k">{t('owner.drivers')}</span><span className="v">{stats.driverCount}</span></div>
        <div className="kvp"><span className="k">{t('owner.vehicles')}</span><span className="v">{stats.vehicleCount}</span></div>
        <div className="kvp"><span className="k">{t('owner.customers')}</span><span className="v">{stats.customerCount}</span></div>
      </div>

      <div className="card col">
        <strong>{t('owner.financials')}</strong>
        <div className="kvp"><span className="k">{t('owner.total_revenue')}</span><span className="v">{stats.totalRevenue.toFixed(2)}</span></div>
      </div>

      <div className="card col">
        <strong>{t('owner.attention')}</strong>
        <div className="kvp">
          <span className="k">{t('owner.pending_approvals')}</span>
          <span className={`v badge ${stats.pendingApprovals > 0 ? 'warn' : 'ok'}`}>{stats.pendingApprovals}</span>
        </div>
        <div className="kvp">
          <span className="k">{t('owner.failed_ops')}</span>
          <span className={`v badge ${stats.failedOps > 0 ? 'danger' : 'ok'}`}>{stats.failedOps}</span>
        </div>
      </div>
    </div>
  );
}
