// =====================================================================
// Sales service.
//
// Creates a sale offline-safely:
//   1. Validate against the local vehicle stock.
//   2. Generate a UUID and create the sale + items in Dexie atomically,
//      decrementing the vehicle balance optimistically.
//   3. Enqueue an idempotent RPC. The server is authoritative — once
//      it processes the op, server snapshots flow back via realtime
//      and overwrite the local optimistic state.
// =====================================================================

import { db } from '../../lib/db/indexeddb';
import { syncEngine } from '../../lib/sync/sync-engine';
import { vehicleStockRepo, salesRepo } from '../../lib/db/repositories';
import type { Sale, SaleItem, PaymentMethod } from '../../types/domain';

export class InsufficientStockError extends Error {
  constructor(public productId: string, public requested: number, public available: number) {
    super(`Insufficient stock for product ${productId}: requested ${requested}, available ${available}`);
    this.name = 'InsufficientStockError';
  }
}

export interface SaleDraftLine {
  product_id: string;
  quantity: number;
  unit_price: number;
}

export interface CreateSaleInput {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  customer_id: string | null;
  payment_method: PaymentMethod;
  paid_amount: number;
  lines: SaleDraftLine[];
}

export const salesService = {
  async create(input: CreateSaleInput): Promise<Sale> {
    if (input.lines.length === 0) throw new Error('Sale must have at least one line.');

    // 1. Validate stock against the local cache.
    for (const ln of input.lines) {
      const avail = await vehicleStockRepo.available(input.vehicle_id, ln.product_id);
      if (ln.quantity > avail) {
        throw new InsufficientStockError(ln.product_id, ln.quantity, avail);
      }
    }

    // 2. Build sale + items.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

    const sale: Sale = {
      id,
      trip_id: input.trip_id,
      customer_id: input.customer_id,
      driver_id: input.driver_id,
      status: 'pending',
      total_amount: total,
      paid_amount: input.paid_amount,
      payment_method: input.payment_method,
      client_created_at: now,
      synced_at: null,
      created_at: now,
      updated_at: now,
    };

    const items: SaleItem[] = input.lines.map(ln => ({
      id: crypto.randomUUID(),
      sale_id: id,
      product_id: ln.product_id,
      quantity: ln.quantity,
      unit_price: ln.unit_price,
      line_total: ln.quantity * ln.unit_price,
    }));

    // 3. Persist locally + decrement vehicle stock optimistically.
    await db.transaction(
      'rw', db.sales, db.sale_items, db.vehicle_balances,
      async () => {
        await salesRepo.put(sale, items);
        for (const ln of input.lines) {
          const cur = await db.vehicle_balances.get([input.vehicle_id, ln.product_id]);
          const nextQty = (cur?.quantity ?? 0) - ln.quantity;
          await db.vehicle_balances.put({
            vehicle_id: input.vehicle_id,
            product_id: ln.product_id,
            quantity: nextQty,
            updated_at: now,
          });
        }
      },
    );

    // 4. Enqueue RPC. Same id → idempotent on retry.
    await syncEngine.enqueue({
      id,
      operation: 'rpc:process_sale',
      entity_type: 'sale',
      entity_id: id,
      user_id: input.driver_id,
      payload: { sale, items },
    });

    return sale;
  },
};
