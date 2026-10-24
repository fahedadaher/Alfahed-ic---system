// =====================================================================
// Domain types. Mirror the Supabase schema. Single source of truth
// for entity shapes used across the app and IndexedDB.
// =====================================================================

export type UserRole = 'owner' | 'factory_manager' | 'cashier' | 'accountant' | 'driver';

export type TripStatus     = 'planned' | 'loaded' | 'in_progress' | 'closed' | 'cancelled';
export type SaleStatus     = 'pending' | 'approved' | 'rejected' | 'void';
export type ReturnStatus   = 'pending' | 'approved' | 'rejected';
export type ApprovalKind   = 'cashier' | 'production';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type MovementKind =
  | 'production_in' | 'vehicle_load' | 'vehicle_unload'
  | 'sale_out'      | 'return_in'    | 'adjustment' | 'transfer';

export type PaymentMethod = 'cash' | 'credit' | 'transfer';

export interface Profile {
  id: string;
  full_name: string;
  role: UserRole;
  factory_id: string | null;
  phone: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Factory {
  id: string;
  name: string;
  code: string;
  active: boolean;
  created_at: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  unit: string;
  weight_kg: number | null;
  active: boolean;
  created_at: string;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  region: string | null;
  credit_limit: number;
  balance: number;
  active: boolean;
  created_at: string;
}

export interface PriceListItem {
  id: string;
  price_list_id: string;
  product_id: string;
  unit_price: number;
}

export interface Vehicle {
  id: string;
  plate_number: string;
  label: string | null;
  capacity_kg: number | null;
  factory_id: string | null;
  active: boolean;
  created_at: string;
}

export interface InventoryBalance {
  factory_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
}

export interface VehicleBalance {
  vehicle_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
}

export interface Trip {
  id: string;
  driver_id: string;
  vehicle_id: string;
  factory_id: string;
  status: TripStatus;
  started_at: string | null;
  closed_at: string | null;
  opening_cash: number;
  closing_cash: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleLoad {
  id: string;
  trip_id: string;
  product_id: string;
  quantity: number;
  loaded_by: string;
  loaded_at: string;
}

export interface Sale {
  id: string;
  trip_id: string;
  customer_id: string | null;
  driver_id: string;
  status: SaleStatus;
  total_amount: number;
  paid_amount: number;
  payment_method: PaymentMethod | null;
  client_created_at: string;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface SaleWithItems extends Sale {
  items: SaleItem[];
}

export interface Return {
  id: string;
  trip_id: string;
  sale_id: string | null;
  customer_id: string | null;
  driver_id: string;
  status: ReturnStatus;
  total_amount: number;
  reason: string | null;
  client_created_at: string;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReturnItem {
  id: string;
  return_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  reference_id: string;
  reference_type: string;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  amount: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionRun {
  id: string;
  factory_id: string;
  product_id: string;
  quantity: number;
  produced_at: string;
  approval_id: string | null;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------
// Amp subscriptions ⇄ smart meters (migration 0004). The meter's value
// is the confirmed truth; `registered_amps` only follows meter readings.
// ---------------------------------------------------------------------

export type MeterConnectionStatus = 'unknown' | 'online' | 'offline';
export type AmpSubscriptionStatus = 'active' | 'suspended' | 'closed';
export type AmpChangeSource       = 'meter_push' | 'meter_poll' | 'reconnect_sync' | 'system_command';
export type MeterCommandStatus    = 'pending' | 'sent' | 'confirmed' | 'failed' | 'expired' | 'cancelled';
export type MeterAlertKind =
  | 'discrepancy' | 'limit_violation' | 'meter_offline'
  | 'unlinked_subscription' | 'sync_failed' | 'command_failed';
export type AmpAdjustmentStatus   = 'pending' | 'needs_pricing' | 'applied' | 'void';

export interface SmartMeter {
  id: string;
  serial_no: string;
  model: string | null;
  driver: string;
  supports_push: boolean;
  supports_remote_control: boolean;
  min_amps: number;
  max_amps: number;
  step_amps: number;
  poll_interval_seconds: number | null;
  factory_id: string | null;
  active: boolean;
  confirmed_amps: number | null;
  confirmed_at: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  connection_status: MeterConnectionStatus;
  consecutive_failures: number;
  last_error: string | null;
  next_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AmpSubscription {
  id: string;
  subscription_no: string;
  customer_id: string | null;
  subscriber_name: string;
  phone: string | null;
  address: string | null;
  factory_id: string | null;
  status: AmpSubscriptionStatus;
  max_connection_amps: number | null;
  registered_amps: number;
  meter_id: string | null;
  meter_linked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeterCommand {
  id: string;
  subscription_id: string;
  meter_id: string;
  previous_amps: number | null;
  requested_amps: number;
  status: MeterCommandStatus;
  attempts: number;
  last_error: string | null;
  note: string | null;
  requested_by: string;
  requested_at: string;
  sent_at: string | null;
  last_sent_at: string | null;
  expires_at: string;
  confirmed_at: string | null;
  confirmed_reading_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AmpChange {
  id: string;
  subscription_id: string;
  meter_id: string;
  previous_amps: number;
  new_amps: number;
  changed_at: string;
  recorded_at: string;
  source: AmpChangeSource;
  actor_id: string | null;
  command_id: string | null;
  reading_id: string;
}

export interface AmpBillingAdjustment {
  id: string;
  change_id: string;
  subscription_id: string;
  price_policy_id: string | null;
  previous_amps: number;
  new_amps: number;
  effective_from: string;
  period_start: string | null;
  period_end: string | null;
  days_charged: number | null;
  days_in_period: number | null;
  amount: number | null;
  status: AmpAdjustmentStatus;
  applied_invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeterAlert {
  id: string;
  kind: MeterAlertKind;
  status: 'open' | 'resolved';
  subscription_id: string | null;
  meter_id: string | null;
  message: string;
  details: Record<string, unknown>;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  updated_at: string;
}
