// =====================================================================
// Sales service tests. Verify offline path: stock validation, atomic
// optimistic write, outbox enqueue with the same UUID.
// =====================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../lib/db/indexeddb';
import { networkMonitor } from '../../lib/network/network-monitor';
import { salesService, InsufficientStockError } from './sales.service';

const VEHICLE = '30000000-0000-0000-0000-000000000001';
const PRODUCT = '10000000-0000-0000-0000-000000000001';
const TRIP    = '50000000-0000-0000-0000-000000000001';
const DRIVER  = '60000000-0000-0000-0000-000000000001';

describe('salesService.create', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    Object.defineProperty(networkMonitor, 'online', { get: () => false, configurable: true });

    await db.vehicle_balances.put({
      vehicle_id: VEHICLE,
      product_id: PRODUCT,
      quantity: 10,
      updated_at: new Date().toISOString(),
    });
  });

  it('throws InsufficientStockError when qty > available', async () => {
    await expect(salesService.create({
      trip_id: TRIP, vehicle_id: VEHICLE, driver_id: DRIVER,
      customer_id: null, payment_method: 'cash', paid_amount: 100,
      lines: [{ product_id: PRODUCT, quantity: 99, unit_price: 5 }],
    })).rejects.toBeInstanceOf(InsufficientStockError);

    expect(await db.sales.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('creates a sale, decrements vehicle stock, and queues an op', async () => {
    const sale = await salesService.create({
      trip_id: TRIP, vehicle_id: VEHICLE, driver_id: DRIVER,
      customer_id: null, payment_method: 'cash', paid_amount: 25,
      lines: [{ product_id: PRODUCT, quantity: 5, unit_price: 5 }],
    });

    expect(sale.total_amount).toBe(25);
    expect(sale.status).toBe('pending');

    const items = await db.sale_items.where('sale_id').equals(sale.id).toArray();
    expect(items).toHaveLength(1);
    expect(items[0]!.line_total).toBe(25);

    const stock = await db.vehicle_balances.get([VEHICLE, PRODUCT]);
    expect(stock?.quantity).toBe(5);

    const op = await db.outbox.get(sale.id);
    expect(op?.operation).toBe('rpc:process_sale');
    expect(op?.entity_id).toBe(sale.id);
    expect(op?.id).toBe(sale.id); // same UUID end-to-end
  });

  it('rejects empty sales', async () => {
    await expect(salesService.create({
      trip_id: TRIP, vehicle_id: VEHICLE, driver_id: DRIVER,
      customer_id: null, payment_method: 'cash', paid_amount: 0, lines: [],
    })).rejects.toThrow();
  });
});
