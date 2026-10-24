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

const PAGE_SIZE = 500;

interface PullSpec {
  table: string;
  /** column we filter on for incremental pull */
  column: string;
  /** dexie table to upsert into */
  apply: (rows: any[]) => Promise<void>;
}

const SPECS: PullSpec[] = [
  { table: 'profiles',           column: 'updated_at', apply: rows => db.profiles.bulkPut(rows) },
  { table: 'products',           column: 'created_at', apply: rows => db.products.bulkPut(rows) },
  { table: 'customers',          column: 'created_at', apply: rows => db.customers.bulkPut(rows) },
  { table: 'price_list_items',   column: 'id',         apply: rows => db.price_list_items.bulkPut(rows) },
  { table: 'customer_price_lists', column: 'customer_id', apply: rows => db.customer_price_lists.bulkPut(rows) },
  { table: 'vehicles',           column: 'created_at', apply: rows => db.vehicles.bulkPut(rows) },
  { table: 'inventory_balances', column: 'updated_at', apply: rows => db.inventory_balances.bulkPut(rows) },
  { table: 'vehicle_balances',   column: 'updated_at', apply: rows => db.vehicle_balances.bulkPut(rows) },
  { table: 'trips',              column: 'updated_at', apply: rows => db.trips.bulkPut(rows) },
  { table: 'vehicle_loads',      column: 'loaded_at',  apply: rows => db.vehicle_loads.bulkPut(rows) },
  { table: 'sales',              column: 'updated_at', apply: rows => db.sales.bulkPut(rows) },
  { table: 'sale_items',         column: 'id',         apply: rows => db.sale_items.bulkPut(rows) },
  { table: 'returns',            column: 'updated_at', apply: rows => db.returns.bulkPut(rows) },
  { table: 'return_items',       column: 'id',         apply: rows => db.return_items.bulkPut(rows) },
  { table: 'approvals',          column: 'updated_at', apply: rows => db.approvals.bulkPut(rows) },
  // amp subscriptions & smart meters (staff only — RLS returns nothing to drivers)
  { table: 'smart_meters',            column: 'updated_at',  apply: async rows => { await db.smart_meters.bulkPut(rows); } },
  { table: 'amp_subscriptions',       column: 'updated_at',  apply: async rows => { await db.amp_subscriptions.bulkPut(rows); } },
  { table: 'meter_commands',          column: 'updated_at',  apply: async rows => { await db.meter_commands.bulkPut(rows); } },
  { table: 'amp_change_log',          column: 'recorded_at', apply: async rows => { await db.amp_change_log.bulkPut(rows); } },
  { table: 'amp_billing_adjustments', column: 'updated_at',  apply: async rows => { await db.amp_billing_adjustments.bulkPut(rows); } },
  { table: 'meter_alerts',            column: 'updated_at',  apply: async rows => { await db.meter_alerts.bulkPut(rows); } },
];

async function pullOne(spec: PullSpec): Promise<void> {
  const watermarkKey = `last_pull_at:${spec.table}`;
  const watermark = await getMeta<string>(watermarkKey);

  let from = 0;
  let highest = watermark ?? null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase.from(spec.table).select('*').order(spec.column, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (watermark) q = q.gt(spec.column, watermark);

    const { data, error } = await q;
    if (error) throw new Error(`[pull:${spec.table}] ${error.message}`);
    if (!data || data.length === 0) break;

    await spec.apply(data);

    const last = data[data.length - 1] as Record<string, unknown>;
    const lastVal = last?.[spec.column];
    if (typeof lastVal === 'string') highest = lastVal;

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (highest) await setMeta(watermarkKey, highest);
}

/** Pull all tables once. Call after login and on reconnect. */
export async function pullAll(): Promise<void> {
  for (const spec of SPECS) {
    try { await pullOne(spec); }
    // eslint-disable-next-line no-console
    catch (err) { console.warn(`[pullAll] ${spec.table} failed`, err); }
  }
}
