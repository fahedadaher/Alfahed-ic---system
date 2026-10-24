// =====================================================================
// Amp service — client-side pre-checks mirror request_amp_change, and
// the displayed sync state never claims more than the meter confirmed.
// =====================================================================

import { describe, it, expect } from 'vitest';
import { validateRequestedAmps, ampSyncState, allowedMaxAmps, changeReportCsv } from './amps.service';
import type { AmpSubscription, SmartMeter, MeterCommand, AmpChange } from '../../types/domain';

const sub = (over: Partial<AmpSubscription> = {}): AmpSubscription => ({
  id: 's1', subscription_no: 'SUB-1', customer_id: null, subscriber_name: 'أحمد', phone: null, address: null,
  factory_id: null, status: 'active', max_connection_amps: 20, registered_amps: 10,
  meter_id: 'm1', meter_linked_at: '2026-10-01T00:00:00Z',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});

const meter = (over: Partial<SmartMeter> = {}): SmartMeter => ({
  id: 'm1', serial_no: 'SM-1', model: null, driver: 'http_headend', supports_push: true,
  supports_remote_control: true, min_amps: 1, max_amps: 32, step_amps: 1, poll_interval_seconds: null,
  factory_id: null, active: true, confirmed_amps: 10, confirmed_at: '2026-10-20T00:00:00Z',
  last_seen_at: '2026-10-20T00:00:00Z', last_sync_at: '2026-10-20T00:00:00Z', connection_status: 'online',
  consecutive_failures: 0, last_error: null, next_poll_at: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', ...over,
});

describe('validateRequestedAmps', () => {
  it('accepts a valid change', () => {
    expect(validateRequestedAmps(sub(), meter(), undefined, 16)).toBeNull();
  });

  it('caps at the lower of meter hardware and connection limit', () => {
    expect(allowedMaxAmps(sub(), meter())).toBe(20);
    expect(allowedMaxAmps(sub({ max_connection_amps: null }), meter())).toBe(32);
    expect(validateRequestedAmps(sub(), meter(), undefined, 21)).toBe('amps.err.out_of_range');
    expect(validateRequestedAmps(sub(), meter(), undefined, 20)).toBeNull();
    expect(validateRequestedAmps(sub(), meter(), undefined, 0)).toBe('amps.err.out_of_range');
    expect(validateRequestedAmps(sub(), meter(), undefined, Number.NaN)).toBe('amps.err.out_of_range');
  });

  it('enforces the meter step', () => {
    expect(validateRequestedAmps(sub(), meter(), undefined, 12.5)).toBe('amps.err.bad_step');
    expect(validateRequestedAmps(sub(), meter({ step_amps: 0.5 }), undefined, 12.5)).toBeNull();
  });

  it('refuses when the meter cannot be commanded or its value is unknown', () => {
    expect(validateRequestedAmps(sub({ meter_id: null }), undefined, undefined, 16)).toBe('amps.err.no_meter');
    expect(validateRequestedAmps(sub(), meter({ supports_remote_control: false }), undefined, 16)).toBe('amps.err.no_remote');
    expect(validateRequestedAmps(sub(), meter({ confirmed_amps: null }), undefined, 16)).toBe('amps.err.no_reading');
    expect(validateRequestedAmps(sub({ status: 'suspended' }), meter(), undefined, 16)).toBe('amps.err.not_active');
  });

  it('refuses a no-op and a second in-flight command', () => {
    expect(validateRequestedAmps(sub(), meter(), undefined, 10)).toBe('amps.err.no_change');
    const active = { id: 'c1', status: 'sent' } as MeterCommand;
    expect(validateRequestedAmps(sub(), meter(), active, 16)).toBe('amps.err.in_progress');
  });
});

describe('ampSyncState', () => {
  it('reports in_sync only when the confirmed meter value equals the system value', () => {
    expect(ampSyncState(sub(), meter())).toBe('in_sync');
    expect(ampSyncState(sub({ registered_amps: 16 }), meter())).toBe('mismatch');
  });

  it('distinguishes unlinked, never read and offline', () => {
    expect(ampSyncState(sub({ meter_id: null }), undefined)).toBe('unlinked');
    expect(ampSyncState(sub(), meter({ confirmed_amps: null }))).toBe('never_read');
    expect(ampSyncState(sub(), meter({ connection_status: 'offline' }))).toBe('offline');
  });
});

describe('changeReportCsv', () => {
  it('exports every change in time order with a BOM and escaping', () => {
    const changes: AmpChange[] = [
      { id: '2', subscription_id: 's1', meter_id: 'm1', previous_amps: 12, new_amps: 16,
        changed_at: '2026-10-20T10:00:00Z', recorded_at: '', source: 'system_command',
        actor_id: 'u1', command_id: 'c1', reading_id: 'r2' },
      { id: '1', subscription_id: 's1', meter_id: 'm1', previous_amps: 10, new_amps: 12,
        changed_at: '2026-10-16T06:00:00Z', recorded_at: '', source: 'meter_push',
        actor_id: null, command_id: null, reading_id: 'r1' },
    ];
    const csv = changeReportCsv(
      changes,
      new Map([['s1', sub({ subscriber_name: 'Ali, "Jr"' })]]),
      new Map([['m1', meter()]]),
      id => (id ? 'Manager' : ''),
    );
    const lines = csv.split('\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('2026-10-16T06:00:00Z,SUB-1,"Ali, ""Jr""",SM-1,10,12,2,meter_push,,');
    expect(lines[2]).toContain(',12,16,4,system_command,Manager,c1');
  });
});
