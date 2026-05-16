// =====================================================================
// Accountant home. Read-only financial snapshots from the local cache.
// Aggregations on the server (RPCs) would be heavier; we keep the
// device fast-by-default and refresh from realtime.
// =====================================================================

import { useLiveQuery } from '../../hooks/useLiveQuery';
import { db } from '../../lib/db/indexeddb';
import { useT } from '../../lib/i18n';

interface Bucket { total: number; count: number }

export function AccountantHome() {
  const t = useT();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const summary = useLiveQuery(async () => {
    const sales   = await db.sales.toArray();
    const returns = await db.returns.toArray();

    const todaySales: Bucket = { total: 0, count: 0 };
    const totalSales: Bucket = { total: 0, count: 0 };

    for (const s of sales) {
      totalSales.total += s.total_amount;
      totalSales.count += 1;
      if (s.client_created_at >= todayIso) {
        todaySales.total += s.total_amount;
        todaySales.count += 1;
      }
    }

    const totalReturns = returns.reduce((acc, r) => ({
      total: acc.total + r.total_amount,
      count: acc.count + 1,
    }), { total: 0, count: 0 } as Bucket);

    const customers = await db.customers.toArray();
    const totalCreditExposure = customers.reduce((s, c) => s + c.balance, 0);

    return { todaySales, totalSales, totalReturns, totalCreditExposure };
  }, []) ?? null;

  if (!summary) return <div className="card">{t('common.loading')}</div>;

  return (
    <div className="col">
      <div className="card col">
        <strong>{t('acc.today')}</strong>
        <div className="kvp"><span className="k">{t('acc.sales_count')}</span><span className="v">{summary.todaySales.count}</span></div>
        <div className="kvp"><span className="k">{t('acc.sales_total')}</span><span className="v">{summary.todaySales.total.toFixed(2)}</span></div>
      </div>

      <div className="card col">
        <strong>{t('acc.all_time')}</strong>
        <div className="kvp"><span className="k">{t('acc.sales')}</span><span className="v">{summary.totalSales.count} · {summary.totalSales.total.toFixed(2)}</span></div>
        <div className="kvp"><span className="k">{t('acc.returns')}</span><span className="v">{summary.totalReturns.count} · {summary.totalReturns.total.toFixed(2)}</span></div>
      </div>

      <div className="card col">
        <strong>{t('acc.credit_exposure')}</strong>
        <div className="kvp"><span className="k">{t('acc.outstanding')}</span><span className="v">{summary.totalCreditExposure.toFixed(2)}</span></div>
      </div>
    </div>
  );
}
