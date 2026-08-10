// =====================================================================
// Sync handlers. Map outbox operations → Supabase RPC calls.
//
// IMPORTANT: signatures must match `supabase/migrations/0002_rpc_*.sql`
// and `0003_rpc_alignment.sql`. The natural primary key (sale.id,
// return.id, trip.id, approval.id) is the idempotency key — re-sending
// the same op is a no-op on the server.
// =====================================================================

import { supabase } from '../supabase/client';
import { db } from '../db/indexeddb';
import { syncEngine, SyncConflictError, isConflictSignal, errorMessage } from './sync-engine';
import type { Sale, SaleItem, Return, ReturnItem } from '../../types/domain';

interface ProcessSalePayload    { sale: Sale; items: SaleItem[] }
interface ProcessReturnPayload  { ret: Return; items: ReturnItem[] }
interface CloseTripPayload      { trip_id: string; closing_cash: number; notes: string | null }
interface StartTripPayload      { trip_id: string; started_at: string }
interface ApprovePayload        { approval_id: string; decision: 'approved' | 'rejected'; notes: string | null }
interface VehicleLoadPayload    {
  trip_id: string; vehicle_id: string; factory_id: string;
  lines: { product_id: string; quantity: number }[];
}

/** Detect server-side conflict signals. */
function classifyAndThrow(err: unknown, fallback: string): never {
  const msg = errorMessage(err, fallback);
  if (isConflictSignal(err)) throw new SyncConflictError(msg, null);
  throw err instanceof Error ? err : new Error(msg);
}

export function registerSyncHandlers() {
  // -----------------------------------------------------------------
  // SALE — idempotent on sale.id.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:process_sale', async (op) => {
    const { sale, items } = op.payload as ProcessSalePayload;
    const { data, error } = await supabase.rpc('process_sale', {
      p_sale_id:           sale.id,
      p_trip_id:           sale.trip_id,
      p_customer_id:       sale.customer_id,
      p_payment_method:    sale.payment_method,
      p_paid_amount:       sale.paid_amount,
      p_client_created_at: sale.client_created_at,
      p_items: items.map(i => ({
        product_id: i.product_id,
        quantity:   i.quantity,
        unit_price: i.unit_price,
      })),
    });
    if (error) classifyAndThrow(error, 'process_sale failed');

    if (data && typeof data === 'object') {
      const server = data as Partial<Sale>;
      await db.sales.update(sale.id, {
        ...server,
        synced_at: new Date().toISOString(),
      });
    }
    return data;
  });

  // -----------------------------------------------------------------
  // RETURN — idempotent on return.id.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:process_return', async (op) => {
    const { ret, items } = op.payload as ProcessReturnPayload;
    const { data, error } = await supabase.rpc('process_return', {
      p_return_id:         ret.id,
      p_trip_id:           ret.trip_id,
      p_sale_id:           ret.sale_id,
      p_customer_id:       ret.customer_id,
      p_reason:            ret.reason,
      p_client_created_at: ret.client_created_at,
      p_items: items.map(i => ({
        product_id: i.product_id,
        quantity:   i.quantity,
        unit_price: i.unit_price,
      })),
    });
    if (error) classifyAndThrow(error, 'process_return failed');

    if (data && typeof data === 'object') {
      const server = data as Partial<Return>;
      await db.returns.update(ret.id, {
        ...server,
        synced_at: new Date().toISOString(),
      });
    }
    return data;
  });

  // -----------------------------------------------------------------
  // CLOSE TRIP — online-only.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:close_trip', async (op) => {
    const p = op.payload as CloseTripPayload;
    const { data, error } = await supabase.rpc('close_trip', {
      p_trip_id:      p.trip_id,
      p_closing_cash: p.closing_cash,
    });
    if (error) classifyAndThrow(error, 'close_trip failed');
    return data;
  });

  // -----------------------------------------------------------------
  // START TRIP — driver flips trip from 'loaded' to 'in_progress'.
  // Offline-safe: the local optimistic update is what the driver sees;
  // the server is reconciled when online via this idempotent RPC.
  //
  // Argument names must match start_trip(p_trip_id, p_started_at) in
  // 0003_rpc_alignment.sql — PostgREST resolves overloads by argument
  // name, so an extra key makes the call 404 with PGRST202.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:start_trip', async (op) => {
    const p = op.payload as StartTripPayload;
    const { data, error } = await supabase.rpc('start_trip', {
      p_trip_id:    p.trip_id,
      p_started_at: p.started_at,
    });
    if (error) classifyAndThrow(error, 'start_trip failed');
    return data;
  });

  // -----------------------------------------------------------------
  // VEHICLE LOAD — online-only. Idempotent on (trip_id, product_id).
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:vehicle_load', async (op) => {
    const p = op.payload as VehicleLoadPayload;
    const { data, error } = await supabase.rpc('vehicle_load', {
      p_trip_id:    p.trip_id,
      p_vehicle_id: p.vehicle_id,
      p_factory_id: p.factory_id,
      p_lines: p.lines.map(l => ({
        product_id: l.product_id,
        quantity:   l.quantity,
      })),
    });
    if (error) classifyAndThrow(error, 'vehicle_load failed');

    if (Array.isArray(data)) await db.vehicle_loads.bulkPut(data);
    return data;
  });

  // -----------------------------------------------------------------
  // APPROVALS — online-only.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:approve_cashier', async (op) => {
    const p = op.payload as ApprovePayload;
    const { data, error } = await supabase.rpc('decide_cashier_approval', {
      p_approval_id: p.approval_id,
      p_decision:    p.decision,
      p_notes:       p.notes,
    });
    if (error) classifyAndThrow(error, 'decide_cashier_approval failed');
    return data;
  });

  syncEngine.registerHandler('rpc:approve_production', async (op) => {
    const p = op.payload as ApprovePayload;
    const { data, error } = await supabase.rpc('decide_production_approval', {
      p_approval_id: p.approval_id,
      p_decision:    p.decision,
      p_notes:       p.notes,
    });
    if (error) classifyAndThrow(error, 'decide_production_approval failed');
    return data;
  });
}
