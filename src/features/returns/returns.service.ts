// =====================================================================
// Returns service.
//
// Mirrors the sales service but credits stock back to the vehicle on
// the optimistic write. The server is the source of truth for whether
// the return is `approved` or `pending`.
// =====================================================================

import { db } from '../../lib/db/indexeddb';
import { syncEngine } from '../../lib/sync/sync-engine';
import { returnsRepo } from '../../lib/db/repositories';
import type { Return, ReturnItem } from '../../types/domain';

export interface ReturnDraftLine {
  product_id: string;
  quantity: number;
  unit_price: number;
}

export interface CreateReturnInput {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  customer_id: string | null;
  sale_id: string | null;
  reason: string | null;
  lines: ReturnDraftLine[];
}

export const returnsService = {
  async create(input: CreateReturnInput): Promise<Return> {
    if (input.lines.length === 0) throw new Error('Return must have at least one line.');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

    const ret: Return = {
      id,
      trip_id: input.trip_id,
      sale_id: input.sale_id,
      customer_id: input.customer_id,
      driver_id: input.driver_id,
      status: 'pending',
      total_amount: total,
      reason: input.reason,
      client_created_at: now,
      synced_at: null,
      created_at: now,
      updated_at: now,
    };

    const items: ReturnItem[] = input.lines.map(ln => ({
      id: crypto.randomUUID(),
      return_id: id,
      product_id: ln.product_id,
      quantity: ln.quantity,
      unit_price: ln.unit_price,
      line_total: ln.quantity * ln.unit_price,
    }));

    // Optimistic: credit back to vehicle balance.
    await db.transaction(
      'rw', db.returns, db.return_items, db.vehicle_balances,
      async () => {
        await returnsRepo.put(ret, items);
        for (const ln of input.lines) {
          const cur = await db.vehicle_balances.get([input.vehicle_id, ln.product_id]);
          const nextQty = (cur?.quantity ?? 0) + ln.quantity;
          await db.vehicle_balances.put({
            vehicle_id: input.vehicle_id,
            product_id: ln.product_id,
            quantity: nextQty,
            updated_at: now,
          });
        }
      },
    );

    await syncEngine.enqueue({
      id,
      operation: 'rpc:process_return',
      entity_type: 'return',
      entity_id: id,
      user_id: input.driver_id,
      payload: { ret, items },
    });

    return ret;
  },
};
