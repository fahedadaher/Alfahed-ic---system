// =====================================================================
// Permissions matrix.
//
// Mirrors the server-side RLS policies. Used purely for UI gating —
// the server is the source of truth. Keeping the same names lets us
// audit "what can a driver do?" by scanning two files.
// =====================================================================

import type { UserRole } from '../../types/domain';

export type Permission =
  // Inventory
  | 'inventory.view' | 'inventory.adjust' | 'inventory.transfer'
  // Vehicle
  | 'vehicle.view' | 'vehicle.load' | 'vehicle.unload' | 'vehicle.assign'
  // Trip
  | 'trip.view'    | 'trip.start'  | 'trip.close'      | 'trip.review'
  // Sale
  | 'sale.view'    | 'sale.create' | 'sale.void'
  // Return
  | 'return.view'  | 'return.create' | 'return.approve'
  // Approval
  | 'approval.view' | 'approval.cashier' | 'approval.production'
  // Pricing & customers
  | 'price.view'   | 'price.manage'
  | 'customer.view'| 'customer.manage'
  // Amp subscriptions & smart meters
  | 'amp.view' | 'amp.manage' | 'amp.command' | 'amp.report'
  // Reports
  | 'report.financial' | 'report.operations'
  // Admin
  | 'admin.users'  | 'admin.settings';

const all = (...p: Permission[]): ReadonlySet<Permission> => new Set(p);

const MATRIX: Record<UserRole, ReadonlySet<Permission>> = {
  owner: all(
    'inventory.view','inventory.adjust','inventory.transfer',
    'vehicle.view','vehicle.load','vehicle.unload','vehicle.assign',
    'trip.view','trip.start','trip.close','trip.review',
    'sale.view','sale.create','sale.void',
    'return.view','return.create','return.approve',
    'approval.view','approval.cashier','approval.production',
    'price.view','price.manage','customer.view','customer.manage',
    'report.financial','report.operations',
    'amp.view','amp.manage','amp.command','amp.report',
    'admin.users','admin.settings',
  ),
  factory_manager: all(
    'inventory.view','inventory.adjust','inventory.transfer',
    'vehicle.view','vehicle.load','vehicle.unload','vehicle.assign',
    'trip.view','trip.review',
    'sale.view','return.view','return.approve',
    'approval.view','approval.production',
    'price.view','customer.view',
    'report.operations',
    'amp.view','amp.manage','amp.command','amp.report',
  ),
  cashier: all(
    'trip.view','trip.review',
    'sale.view','return.view',
    'approval.view','approval.cashier',
    'customer.view',
    'report.financial',
    'amp.view',
  ),
  accountant: all(
    'inventory.view','vehicle.view',
    'trip.view','sale.view','return.view',
    'approval.view',
    'price.view','customer.view',
    'report.financial','report.operations',
    'amp.view','amp.report',
  ),
  driver: all(
    'vehicle.view',
    'trip.view','trip.start','trip.close',
    'sale.view','sale.create',
    'return.view','return.create',
    'price.view','customer.view',
  ),
};

export function can(role: UserRole | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return MATRIX[role].has(perm);
}

export function canAny(role: UserRole | null | undefined, perms: Permission[]): boolean {
  return perms.some(p => can(role, p));
}

export function canAll(role: UserRole | null | undefined, perms: Permission[]): boolean {
  return perms.every(p => can(role, p));
}
