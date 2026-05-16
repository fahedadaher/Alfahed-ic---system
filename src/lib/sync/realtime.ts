// =====================================================================
// Realtime subscriptions.
//
// We listen for postgres_changes on the tables that drive the UI and
// upsert into Dexie. The UI uses dexie liveQuery on those tables, so
// updates flow: Postgres → realtime → Dexie → React.
// =====================================================================

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../supabase/client';
import { db } from '../db/indexeddb';

let channel: RealtimeChannel | null = null;

const SIMPLE_TABLES: { name: string; tbl: () => any }[] = [
  { name: 'trips',        tbl: () => db.trips },
  { name: 'sales',        tbl: () => db.sales },
  { name: 'sale_items',   tbl: () => db.sale_items },
  { name: 'returns',      tbl: () => db.returns },
  { name: 'return_items', tbl: () => db.return_items },
  { name: 'approvals',    tbl: () => db.approvals },
  { name: 'vehicle_loads',tbl: () => db.vehicle_loads },
  { name: 'profiles',     tbl: () => db.profiles },
];

export function startRealtime() {
  if (channel) return;

  channel = supabase.channel('alfahad-realtime', {
    config: { broadcast: { ack: false }, presence: { key: '' } },
  });

  for (const t of SIMPLE_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: t.name },
      payload => {
        const row = (payload.new ?? payload.old) as Record<string, unknown>;
        if (!row || !row.id) return;
        if (payload.eventType === 'DELETE') void t.tbl().delete(row.id);
        else void t.tbl().put(row);
      },
    );
  }

  // Composite-key tables need explicit handling.
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'inventory_balances' },
    payload => {
      const row = (payload.new ?? payload.old) as Record<string, unknown>;
      if (!row?.factory_id || !row?.product_id) return;
      if (payload.eventType === 'DELETE') {
        void db.inventory_balances.delete([row.factory_id as string, row.product_id as string]);
      } else {
        void db.inventory_balances.put(row as any);
      }
    },
  );

  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'vehicle_balances' },
    payload => {
      const row = (payload.new ?? payload.old) as Record<string, unknown>;
      if (!row?.vehicle_id || !row?.product_id) return;
      if (payload.eventType === 'DELETE') {
        void db.vehicle_balances.delete([row.vehicle_id as string, row.product_id as string]);
      } else {
        void db.vehicle_balances.put(row as any);
      }
    },
  );

  channel.subscribe(status => {
    // eslint-disable-next-line no-console
    if (status === 'SUBSCRIBED') console.log('[realtime] connected');
    else if (status === 'CHANNEL_ERROR') console.warn('[realtime] error');
  });
}

export function stopRealtime() {
  if (!channel) return;
  void supabase.removeChannel(channel);
  channel = null;
}
