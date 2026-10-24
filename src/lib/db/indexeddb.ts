// =====================================================================
// IndexedDB schema (via Dexie). Device-side cache and outbox.
//
// Lifecycle:
//   1. UI reads from Dexie first (fast, offline-capable).
//   2. Realtime / pull sync writes server snapshots into these tables.
//   3. UI writes go to Dexie + outbox; the sync engine drains the outbox.
// =====================================================================

import Dexie, { type Table } from 'dexie';
import type {
  Profile, Product, Customer, PriceListItem, Vehicle,
  Trip, VehicleLoad, VehicleBalance, InventoryBalance,
  Sale, SaleItem, Return, ReturnItem, Approval,
  SmartMeter, AmpSubscription, MeterCommand, AmpChange, AmpBillingAdjustment, MeterAlert,
} from '../../types/domain';
import type { OutboxOperation, SyncMeta, ConflictRecord } from '../../types/sync';

export class AppDatabase extends Dexie {
  profiles!:             Table<Profile, string>;
  products!:             Table<Product, string>;
  customers!:            Table<Customer, string>;
  price_list_items!:     Table<PriceListItem, string>;
  customer_price_lists!: Table<{ customer_id: string; price_list_id: string }, string>;
  vehicles!:             Table<Vehicle, string>;
  inventory_balances!:   Table<InventoryBalance, [string, string]>;
  vehicle_balances!:     Table<VehicleBalance,   [string, string]>;

  trips!:        Table<Trip, string>;
  vehicle_loads!: Table<VehicleLoad, string>;
  sales!:        Table<Sale, string>;
  sale_items!:   Table<SaleItem, string>;
  returns!:      Table<Return, string>;
  return_items!: Table<ReturnItem, string>;
  approvals!:    Table<Approval, string>;

  smart_meters!:            Table<SmartMeter, string>;
  amp_subscriptions!:       Table<AmpSubscription, string>;
  meter_commands!:          Table<MeterCommand, string>;
  amp_change_log!:          Table<AmpChange, string>;
  amp_billing_adjustments!: Table<AmpBillingAdjustment, string>;
  meter_alerts!:            Table<MeterAlert, string>;

  outbox!:    Table<OutboxOperation, string>;
  conflicts!: Table<ConflictRecord, string>;
  meta!:      Table<SyncMeta, string>;

  constructor() {
    super('alfahad_ice_v1');
    this.version(1).stores({
      profiles:             'id, role, factory_id',
      products:             'id, sku, active',
      customers:            'id, code, region, active',
      price_list_items:     'id, [price_list_id+product_id], product_id',
      customer_price_lists: 'customer_id',
      vehicles:             'id, plate_number, factory_id',
      inventory_balances:   '[factory_id+product_id], factory_id, product_id',
      vehicle_balances:     '[vehicle_id+product_id], vehicle_id, product_id',
      trips:                'id, driver_id, vehicle_id, status, created_at',
      vehicle_loads:        'id, trip_id, product_id',
      sales:                'id, trip_id, status, client_created_at, synced_at',
      sale_items:           'id, sale_id, product_id',
      returns:              'id, trip_id, status, client_created_at, synced_at',
      return_items:         'id, return_id, product_id',
      approvals:            'id, kind, status, requested_by',
      outbox:               'id, status, client_timestamp, entity_type, entity_id',
      conflicts:            'id, operation_id, resolved',
      meta:                 'key',
    });
    // v2 — amp subscriptions & smart meters (server snapshots, read-only)
    this.version(2).stores({
      smart_meters:            'id, &serial_no, connection_status',
      amp_subscriptions:       'id, &subscription_no, meter_id, status',
      meter_commands:          'id, subscription_id, meter_id, status, requested_at',
      amp_change_log:          'id, subscription_id, changed_at',
      amp_billing_adjustments: 'id, change_id, subscription_id, status',
      meter_alerts:            'id, kind, status, subscription_id, meter_id, last_seen_at',
    });
  }
}

export const db = new AppDatabase();

export const META_KEYS = {
  CLIENT_ID:      'client_id',
  LAST_PULL_AT:   'last_pull_at',
  AUTH_USER_ID:   'auth_user_id',
  AUTH_ROLE:      'auth_role',
  ACTIVE_TRIP_ID: 'active_trip_id',
} as const;

/** Get-or-create the persistent device id. */
export async function getOrCreateClientId(): Promise<string> {
  const existing = await db.meta.get(META_KEYS.CLIENT_ID);
  if (existing && typeof existing.value === 'string') return existing.value;
  const id = crypto.randomUUID();
  await db.meta.put({ key: META_KEYS.CLIENT_ID, value: id, updated_at: new Date().toISOString() });
  return id;
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value, updated_at: new Date().toISOString() });
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}
