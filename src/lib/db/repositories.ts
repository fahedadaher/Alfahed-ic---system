// =====================================================================
// Repositories. Thin domain-aware wrappers around Dexie. Keeps feature
// code storage-agnostic and easy to test.
// =====================================================================

import { db } from './indexeddb';
import type {
  Sale, SaleItem, SaleWithItems,
  Return, ReturnItem,
  Trip, VehicleBalance, Product, Customer,
} from '../../types/domain';

export const productsRepo = {
  list:       () => db.products.toArray(),
  get:        (id: string) => db.products.get(id),
  bulkUpsert: (rows: Product[]) => db.products.bulkPut(rows),
};

export const customersRepo = {
  list: () => db.customers.toArray(),
  get:  (id: string) => db.customers.get(id),
  search: async (q: string) => {
    const lower = q.trim().toLowerCase();
    if (!lower) return db.customers.limit(50).toArray();
    return db.customers
      .filter(c =>
        c.name.toLowerCase().includes(lower) ||
        c.code.toLowerCase().includes(lower) ||
        (c.phone ?? '').includes(lower))
      .limit(50).toArray();
  },
  bulkUpsert: (rows: Customer[]) => db.customers.bulkPut(rows),
};

export const pricesRepo = {
  /** Resolve unit price for a product for a given customer (offline-capable). */
  async resolve(customerId: string | null, productId: string): Promise<number | null> {
    if (customerId) {
      const link = await db.customer_price_lists.get(customerId);
      if (link) {
        const item = await db.price_list_items
          .where('[price_list_id+product_id]').equals([link.price_list_id, productId]).first();
        if (item) return item.unit_price;
      }
    }
    const fallback = await db.price_list_items.where('product_id').equals(productId).first();
    return fallback?.unit_price ?? null;
  },
};

export const vehicleStockRepo = {
  forVehicle: (vehicleId: string): Promise<VehicleBalance[]> =>
    db.vehicle_balances.where('vehicle_id').equals(vehicleId).toArray(),
  available: async (vehicleId: string, productId: string): Promise<number> => {
    const row = await db.vehicle_balances.get([vehicleId, productId]);
    return row?.quantity ?? 0;
  },
};

export const tripsRepo = {
  active: async (driverId: string): Promise<Trip | undefined> =>
    db.trips.where({ driver_id: driverId })
      .filter(t => t.status === 'in_progress' || t.status === 'loaded')
      .first(),
  get:    (id: string) => db.trips.get(id),
  upsert: (t: Trip) => db.trips.put(t),
};

export const salesRepo = {
  forTrip: async (tripId: string): Promise<SaleWithItems[]> => {
    const sales = await db.sales.where('trip_id').equals(tripId)
      .reverse().sortBy('client_created_at');
    const ids = sales.map(s => s.id);
    const items = await db.sale_items.where('sale_id').anyOf(ids).toArray();
    const byId: Record<string, SaleItem[]> = {};
    items.forEach(i => { (byId[i.sale_id] ??= []).push(i); });
    return sales.map(s => ({ ...s, items: byId[s.id] ?? [] }));
  },
  put: async (sale: Sale, items: SaleItem[]) => {
    await db.transaction('rw', db.sales, db.sale_items, async () => {
      await db.sales.put(sale);
      await db.sale_items.bulkPut(items);
    });
  },
};

export const returnsRepo = {
  forTrip: async (tripId: string) => {
    const rs = await db.returns.where('trip_id').equals(tripId)
      .reverse().sortBy('client_created_at');
    const ids = rs.map(r => r.id);
    const items = await db.return_items.where('return_id').anyOf(ids).toArray();
    const byId: Record<string, ReturnItem[]> = {};
    items.forEach(i => { (byId[i.return_id] ??= []).push(i); });
    return rs.map(r => ({ ...r, items: byId[r.id] ?? [] }));
  },
  put: async (ret: Return, items: ReturnItem[]) => {
    await db.transaction('rw', db.returns, db.return_items, async () => {
      await db.returns.put(ret);
      await db.return_items.bulkPut(items);
    });
  },
};
