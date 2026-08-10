// =====================================================================
// Pull sync.
//
// Realtime is the primary mechanism, but the device may be offline for
// hours. On reconnect we run a watermark-based pull per table to
// catch up before realtime resumes. Per-table `last_pull_at:{table}`
// is stored in `meta`.
// =====================================================================

import { supabase } from '../supabase/client';
import { db, getMeta, setMeta } from '../db/indexeddb';
import { errorMessage } from './sync-engine';

const PAGE_SIZE = 500;

interface PullSpec {
  table: string;
  /**
   * Column we page and (when incremental) filter on. Must be monotonic
   * over time for the watermark to be meaningful.
   */
  column: string;
  /**
   * When false, every pull re-reads the whole table. Required for tables
   * whose only sortable column is a random UUID: `gt(id, watermark)`
   * skips forever any row whose id happens to sort below the watermark,
   * so child rows silently never reach the device.
   */
  incremental: boolean;
  /** dexie table to upsert into */
  apply: (rows: any[]) => Promise<unknown>;
}

const SPECS: PullSpec[] = [
  { table: 'profiles',             column: 'updated_at',  incremental: true,  apply: rows => db.profiles.bulkPut(rows) },
  { table: 'products',             column: 'created_at',  incremental: true,  apply: rows => db.products.bulkPut(rows) },
  { table: 'customers',            column: 'created_at',  incremental: true,  apply: rows => db.customers.bulkPut(rows) },
  { table: 'price_list_items',     column: 'id',          incremental: false, apply: rows => db.price_list_items.bulkPut(rows) },
  { table: 'customer_price_lists', column: 'customer_id', incremental: false, apply: rows => db.customer_price_lists.bulkPut(rows) },
  { table: 'vehicles',             column: 'created_at',  incremental: true,  apply: rows => db.vehicles.bulkPut(rows) },
  { table: 'inventory_balances',   column: 'updated_at',  incremental: true,  apply: rows => db.inventory_balances.bulkPut(rows) },
  { table: 'vehicle_balances',     column: 'updated_at',  incremental: true,  apply: rows => db.vehicle_balances.bulkPut(rows) },
  { table: 'trips',                column: 'updated_at',  incremental: true,  apply: rows => db.trips.bulkPut(rows) },
  { table: 'vehicle_loads',        column: 'loaded_at',   incremental: true,  apply: rows => db.vehicle_loads.bulkPut(rows) },
  { table: 'sales',                column: 'updated_at',  incremental: true,  apply: rows => db.sales.bulkPut(rows) },
  { table: 'sale_items',           column: 'id',          incremental: false, apply: rows => db.sale_items.bulkPut(rows) },
  { table: 'returns',              column: 'updated_at',  incremental: true,  apply: rows => db.returns.bulkPut(rows) },
  { table: 'return_items',         column: 'id',          incremental: false, apply: rows => db.return_items.bulkPut(rows) },
  { table: 'approvals',            column: 'updated_at',  incremental: true,  apply: rows => db.approvals.bulkPut(rows) },
];

async function pullOne(spec: PullSpec): Promise<void> {
  const watermarkKey = `last_pull_at:${spec.table}`;
  const watermark = spec.incremental ? await getMeta<string>(watermarkKey) : undefined;

  let from = 0;
  let highest = watermark ?? null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase.from(spec.table).select('*').order(spec.column, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (watermark) q = q.gt(spec.column, watermark);

    const { data, error } = await q;
    if (error) throw new Error(`[pull:${spec.table}] ${errorMessage(error)}`);
    if (!data || data.length === 0) break;

    await spec.apply(data);

    const last = data[data.length - 1] as Record<string, unknown>;
    const lastVal = last?.[spec.column];
    if (typeof lastVal === 'string') highest = lastVal;

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (spec.incremental && highest) await setMeta(watermarkKey, highest);
}

export interface PullResult {
  ok: boolean;
  /** Tables that could not be pulled, with the reason. */
  failures: { table: string; error: string }[];
}

/**
 * Pull all tables once. Call after login and on reconnect.
 *
 * Per-table failures do not abort the run, but they are reported rather
 * than only logged — a caller showing "sync failed" needs to know.
 */
export async function pullAll(): Promise<PullResult> {
  const failures: PullResult['failures'] = [];
  for (const spec of SPECS) {
    try {
      await pullOne(spec);
    } catch (err) {
      const message = errorMessage(err);
      failures.push({ table: spec.table, error: message });
      // eslint-disable-next-line no-console
      console.warn(`[pullAll] ${spec.table} failed: ${message}`);
    }
  }
  return { ok: failures.length === 0, failures };
}
