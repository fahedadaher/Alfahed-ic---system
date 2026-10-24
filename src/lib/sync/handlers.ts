// =====================================================================
// Sync handlers. Map outbox operations → Supabase RPC calls.
//
// IMPORTANT: signatures must match `supabase/migrations/0002_rpc_*.sql`
// and `0003_rpc_alignment.sql`. The natural primary key (sale.id,
// return.id, trip.id, approval.id) is the idempotency key — re-sending
// the same op is a no-op on the server.
// =====================================================================

import { supabase } from '../supabase/client';
import { db, setMeta } from '../db/indexeddb';
import { syncEngine, SyncConflictError, SyncRejectedError } from './sync-engine';
import type {
  Sale, SaleItem, Return, ReturnItem,
  AmpSubscription, MeterCommand, MeterAlert,
} from '../../types/domain';

interface ProcessSalePayload    { sale: Sale; items: SaleItem[] }
interface ProcessReturnPayload  { ret: Return; items: ReturnItem[] }
interface CloseTripPayload      { trip_id: string; closing_cash: number; notes: string | null }
interface StartTripPayload      { trip_id: string; started_at: string }
interface ApprovePayload        { approval_id: string; decision: 'approved' | 'rejected'; notes: string | null }

interface RequestAmpChangePayload { command_id: string; subscription_id: string; requested_amps: number; note: string | null }

/**
 * Postgres codes that mean "the server said no" — invalid value,
 * forbidden, not found. Not retried (see SyncRejectedError).
 */
const REJECT_CODES = new Set(['22023', '42501', 'P0002', '22P02']);

/** Like classifyAndThrow, plus permanent rejections. */
function classifyAmpError(err: { code?: string; message?: string } | null, fallback: string): never {
  const msg = err?.message ?? fallback;
  if (err?.code && REJECT_CODES.has(err.code) && !msg.includes('CONFLICT_')) {
    throw new SyncRejectedError(err.code, msg);
  }
  classifyAndThrow(err, fallback);
}

/** Detect server-side conflict signals. */
function classifyAndThrow(err: unknown, fallback: string): never {
  const msg = err instanceof Error ? err.message : String(err ?? fallback);
  if (msg.includes('CONFLICT_') || msg.includes('409') || msg.toLowerCase().includes('conflict')) {
    throw new SyncConflictError(msg, null);
  }
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
  // START TRIP.
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

  // -----------------------------------------------------------------
  // START TRIP — driver flips trip from 'loaded' to 'in_progress'.
  // Offline-safe: the local optimistic update is what the driver sees;
  // the server is reconciled when online via this idempotent RPC.
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:start_trip', async (op) => {
    const p = op.payload as { trip_id: string; started_at: string };
    const { data, error } = await supabase.rpc('start_trip', {
      p_op_id: op.id,
      p_trip_id: p.trip_id,
      p_started_at: p.started_at,
    });
    if (error) unwrapError(error, 'start_trip failed');
    return data;
  });

  // -----------------------------------------------------------------
  // AMP SUBSCRIPTIONS / SMART METERS — online-only. The server row is
  // written back to Dexie so the UI shows the server's status
  // ('pending' → 'sent' → 'confirmed' arrives via realtime).
  // -----------------------------------------------------------------
  syncEngine.registerHandler('rpc:request_amp_change', async (op) => {
    const p = op.payload as RequestAmpChangePayload;
    const { data, error } = await supabase.rpc('request_amp_change', {
      p_command_id:      p.command_id,
      p_subscription_id: p.subscription_id,
      p_requested_amps:  p.requested_amps,
      p_note:            p.note,
    });
    if (error) classifyAmpError(error, 'request_amp_change failed');
    if (data) await db.meter_commands.put(data as MeterCommand);
    return data;
  });

  syncEngine.registerHandler('rpc:cancel_amp_command', async (op) => {
    const p = op.payload as { command_id: string };
    const { data, error } = await supabase.rpc('cancel_amp_command', { p_command_id: p.command_id });
    if (error) classifyAmpError(error, 'cancel_amp_command failed');
    if (data) await db.meter_commands.put(data as MeterCommand);
    return data;
  });

  syncEngine.registerHandler('rpc:link_meter', async (op) => {
    const p = op.payload as { subscription_id: string; meter_id: string };
    const { data, error } = await supabase.rpc('link_meter', {
      p_subscription_id: p.subscription_id, p_meter_id: p.meter_id,
    });
    if (error) classifyAmpError(error, 'link_meter failed');
    if (data) await db.amp_subscriptions.put(data as AmpSubscription);
    return data;
  });

  syncEngine.registerHandler('rpc:unlink_meter', async (op) => {
    const p = op.payload as { subscription_id: string };
    const { data, error } = await supabase.rpc('unlink_meter', { p_subscription_id: p.subscription_id });
    if (error) classifyAmpError(error, 'unlink_meter failed');
    if (data) await db.amp_subscriptions.put(data as AmpSubscription);
    return data;
  });

  syncEngine.registerHandler('rpc:resolve_meter_alert', async (op) => {
    const p = op.payload as { alert_id: string; note: string | null };
    const { data, error } = await supabase.rpc('resolve_meter_alert', {
      p_alert_id: p.alert_id, p_note: p.note,
    });
    if (error) classifyAmpError(error, 'resolve_meter_alert failed');
    if (data) await db.meter_alerts.put(data as MeterAlert);
    return data;
  });

  syncEngine.registerHandler('rpc:run_meter_health_check', async () => {
    const { data, error } = await supabase.rpc('run_meter_health_check');
    if (error) classifyAmpError(error, 'run_meter_health_check failed');
    await setMeta('meter_health_last', data);
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
