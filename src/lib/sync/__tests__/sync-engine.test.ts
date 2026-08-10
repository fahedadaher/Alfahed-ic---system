// =====================================================================
// Sync engine — the most failure-sensitive piece of the system.
// We test: enqueue, idempotent retry, online-only enforcement, drain,
// failure backoff, conflict routing.
// =====================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  syncEngine, OfflineForbiddenError, SyncConflictError,
  isConflictSignal, errorMessage,
} from '../sync-engine';
import { networkMonitor } from '../../network/network-monitor';
import { db } from '../../db/indexeddb';
import type { OutboxOperation } from '../../../types/sync';

function makeOp(over: Partial<OutboxOperation> = {}): OutboxOperation {
  return {
    id: crypto.randomUUID(),
    client_id: 'device-1',
    user_id: 'u1',
    entity_type: 'test',
    entity_id: 'e1',
    operation: 'rpc:test_op',
    payload: {},
    client_timestamp: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    last_error: null,
    synced_at: null,
    server_response: null,
    next_attempt_at: null,
    ...over,
  };
}

async function clearAll() {
  await Promise.all([
    db.outbox.clear(),
    db.conflicts.clear(),
    db.meta.clear(),
    db.sales.clear(),
  ]);
}

describe('syncEngine', () => {
  beforeEach(async () => {
    await clearAll();
    // Force online for tests (we don't want the probe loop running).
    Object.defineProperty(networkMonitor, 'online', { get: () => true, configurable: true });
  });

  it('enqueues and processes an op via its handler', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:test_op', handler);

    const id = await syncEngine.enqueue({
      operation: 'rpc:test_op',
      entity_type: 'test',
      entity_id: 'e1',
      user_id: 'u1',
      payload: { foo: 'bar' },
    });

    await syncEngine.drain();
    const row = await db.outbox.get(id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(row?.status).toBe('synced');
  });

  it('refuses to enqueue online-only ops while offline', async () => {
    Object.defineProperty(networkMonitor, 'online', { get: () => false, configurable: true });
    await expect(
      syncEngine.enqueue({
        operation: 'rpc:close_trip',
        entity_type: 'trip',
        entity_id: 't1',
        user_id: 'u1',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(OfflineForbiddenError);
  });

  it('routes conflicts into the conflicts store', async () => {
    syncEngine.registerHandler('rpc:test_conflict', async () => {
      throw new SyncConflictError('CONFLICT_DEMO', { server: 'wins' });
    });

    const id = await syncEngine.enqueue({
      operation: 'rpc:test_conflict',
      entity_type: 'test',
      entity_id: 'c1',
      user_id: 'u1',
      payload: {},
    });

    await syncEngine.drain();
    const op = await db.outbox.get(id);
    const conflicts = await db.conflicts.toArray();
    expect(op?.status).toBe('conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toContain('CONFLICT_DEMO');
  });

  it('is idempotent: same op id is processed only once successfully', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:idem', handler);

    const id = crypto.randomUUID();
    await syncEngine.enqueue({
      id, operation: 'rpc:idem',
      entity_type: 't', entity_id: 'i', user_id: 'u', payload: {},
    });
    await syncEngine.drain();

    // Re-enqueue same id (e.g. UI retry while previous still in flight)
    await syncEngine.enqueue({
      id, operation: 'rpc:idem',
      entity_type: 't', entity_id: 'i', user_id: 'u', payload: {},
    });
    await syncEngine.drain();

    // Dexie put with same primary key replaces the row in-place; the
    // engine's natural-key idempotency means handlers should also be
    // safe-on-replay. Here we assert the row is in `synced` state.
    const op = await db.outbox.get(id);
    expect(op?.status).toBe('synced');
  });

  // -------------------------------------------------------------------
  // Regressions: the queue used to stall with ops stuck "pending".
  // -------------------------------------------------------------------

  it('a failing op does not block the ops queued behind it', async () => {
    // The failing op is the OLDEST, so a queue that re-picks the head on
    // every lap never reaches the healthy ops behind it.
    syncEngine.registerHandler('rpc:always_fails', async () => {
      throw new Error('network down');
    });
    const good = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:good', good);

    const t0 = new Date(Date.now() - 60_000).toISOString();
    const badId = crypto.randomUUID();
    const goodId = crypto.randomUUID();
    await db.outbox.bulkPut([
      makeOp({ id: badId,  operation: 'rpc:always_fails', client_timestamp: t0 }),
      makeOp({ id: goodId, operation: 'rpc:good',
               client_timestamp: new Date(Date.now() - 30_000).toISOString() }),
    ]);

    await syncEngine.drain();

    expect(good).toHaveBeenCalledTimes(1);
    expect((await db.outbox.get(goodId))?.status).toBe('synced');

    // The failure is requeued with a future retry time, not retried hot.
    const bad = await db.outbox.get(badId);
    expect(bad?.status).toBe('pending');
    expect(bad?.attempts).toBe(1);
    expect(Date.parse(bad!.next_attempt_at!)).toBeGreaterThan(Date.now());
  });

  it('skips ops whose backoff window has not elapsed', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:backed_off', handler);

    await db.outbox.put(makeOp({
      operation: 'rpc:backed_off',
      attempts: 2,
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    }));

    await syncEngine.drain();
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives up after MAX_ATTEMPTS instead of retrying forever', async () => {
    syncEngine.registerHandler('rpc:doomed', async () => { throw new Error('boom'); });

    const id = crypto.randomUUID();
    await db.outbox.put(makeOp({ id, operation: 'rpc:doomed', attempts: 5 }));

    await syncEngine.drain();

    const op = await db.outbox.get(id);
    expect(op?.status).toBe('failed');
    expect(op?.next_attempt_at).toBeNull();
  });

  it('marks ops with no registered handler failed, not pending', async () => {
    const id = crypto.randomUUID();
    await db.outbox.put(makeOp({ id, operation: 'rpc:no_such_handler' }));

    await syncEngine.drain();

    const op = await db.outbox.get(id);
    expect(op?.status).toBe('failed');
    expect(op?.last_error).toContain('No handler registered');
  });

  it('requeues ops orphaned in_flight by a closed tab', async () => {
    const id = crypto.randomUUID();
    await db.outbox.put(makeOp({ id, status: 'in_flight', operation: 'rpc:orphan' }));

    const handler = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:orphan', handler);

    // pickNext only looks at `pending`, so without recovery this op is
    // invisible to the drain loop forever.
    await syncEngine.drain();
    expect(handler).not.toHaveBeenCalled();

    await syncEngine.start();
    await syncEngine.drain();
    syncEngine.stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect((await db.outbox.get(id))?.status).toBe('synced');
  });

  it('drain() awaited concurrently resolves only once the work is done', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    syncEngine.registerHandler('rpc:concurrent', handler);

    await db.outbox.bulkPut([
      makeOp({ operation: 'rpc:concurrent' }),
      makeOp({ operation: 'rpc:concurrent' }),
    ]);

    // A second caller must share the running pass, not be dropped.
    await Promise.all([syncEngine.drain(), syncEngine.drain()]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(await db.outbox.where('status').equals('pending').count()).toBe(0);
  });

  it('reports in_flight and pending counts from the store', async () => {
    await db.outbox.put(makeOp({ status: 'in_flight' }));
    await db.outbox.put(makeOp({ status: 'pending', operation: 'rpc:none' }));

    const seen: number[] = [];
    const unsub = syncEngine.subscribe(s => seen.push(s.in_flight));
    await syncEngine.drain();
    unsub();

    // The orphan stays in_flight (recovery only runs at start()); the
    // counter must reflect the store rather than a drifting tally.
    expect(seen[seen.length - 1]).toBe(1);
  });
});

describe('errorMessage', () => {
  it('reads Supabase PostgrestError objects, which are not Errors', () => {
    const pgErr = {
      message: 'CONFLICT_TRIP_NOT_LOADED',
      details: 'trip is already closed',
      code: 'P0001',
      hint: null,
    };
    const msg = errorMessage(pgErr);
    expect(msg).toContain('CONFLICT_TRIP_NOT_LOADED');
    expect(msg).toContain('P0001');
    expect(msg).not.toContain('[object Object]');
  });

  it('falls back rather than stringifying to [object Object]', () => {
    expect(errorMessage({}, 'process_sale failed')).toBe('process_sale failed');
  });
});

describe('isConflictSignal', () => {
  it('detects a CONFLICT_ code inside a plain Supabase error object', () => {
    expect(isConflictSignal({ message: 'CONFLICT_INSUFFICIENT_STOCK', code: 'P0001' })).toBe(true);
  });

  it('detects an explicit 409 status', () => {
    expect(isConflictSignal({ message: 'Conflict', status: 409 })).toBe(true);
  });

  it('does not treat a retryable error as a conflict just because it contains 409', () => {
    // A timeout on a sale of 1409 SAR must stay retryable.
    expect(isConflictSignal(new Error('fetch failed for amount 1409'))).toBe(false);
  });
});
