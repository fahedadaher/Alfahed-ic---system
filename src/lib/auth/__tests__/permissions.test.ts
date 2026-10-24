// =====================================================================
// Permissions matrix — guards critical role boundaries.
// =====================================================================

import { describe, it, expect } from 'vitest';
import { can, canAny } from '../permissions';

describe('permissions matrix', () => {
  it('drivers cannot adjust inventory', () => {
    expect(can('driver', 'inventory.adjust')).toBe(false);
    expect(can('driver', 'inventory.transfer')).toBe(false);
  });

  it('drivers can create sales and returns', () => {
    expect(can('driver', 'sale.create')).toBe(true);
    expect(can('driver', 'return.create')).toBe(true);
  });

  it('cashiers can decide cashier approvals but not production', () => {
    expect(can('cashier', 'approval.cashier')).toBe(true);
    expect(can('cashier', 'approval.production')).toBe(false);
  });

  it('factory managers can decide production approvals', () => {
    expect(can('factory_manager', 'approval.production')).toBe(true);
    expect(can('factory_manager', 'inventory.adjust')).toBe(true);
  });

  it('owners can do everything', () => {
    expect(can('owner', 'admin.users')).toBe(true);
    expect(can('owner', 'sale.void')).toBe(true);
  });

  it('only owner and factory manager can command meters (mirrors amp_require_manager)', () => {
    expect(can('owner', 'amp.command')).toBe(true);
    expect(can('factory_manager', 'amp.command')).toBe(true);
    expect(can('accountant', 'amp.command')).toBe(false);
    expect(can('cashier', 'amp.command')).toBe(false);
    expect(can('driver', 'amp.view')).toBe(false);
    expect(can('accountant', 'amp.report')).toBe(true);
  });

  it('null role is denied everything', () => {
    expect(can(null, 'sale.view')).toBe(false);
    expect(canAny(null, ['sale.view', 'sale.create'])).toBe(false);
  });

  it('canAny returns true if any permission matches', () => {
    expect(canAny('cashier', ['admin.users', 'approval.cashier'])).toBe(true);
    expect(canAny('cashier', ['admin.users', 'admin.settings'])).toBe(false);
  });
});
