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
