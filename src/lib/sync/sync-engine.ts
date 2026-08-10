// =====================================================================
// Sync engine. The single component responsible for moving the device's
// intents (outbox) into the server's truth.
//
// Design rules:
//   - Every write is enqueued with a client-generated UUID. The server
//     RPCs are idempotent on that UUID — re-sending is a no-op.
//   - We process operations in FIFO; one in-flight at a time per device
//     to keep ordering simple and avoid thundering herds.
//   - Failures use exponential backoff. Conflicts (server says no) move
//     to a separate `conflicts` store for human review.
//   - Operations marked ONLINE_ONLY refuse to enqueue while offline so
//     the user gets immediate, honest feedback.
// =====================================================================

import { db, getOrCreateClientId } from '../db/indexeddb';
import type { OutboxOperation } from '../../types/sync';
import { ONLINE_ONLY_OPERATIONS } from '../../types/sync';
import { networkMonitor } from '../network/network-monitor';
import { supabase } from '../supabase/client';

export interface SyncState {
  online: boolean;
  pending: number;
  in_flight: number;
  failed: number;
}

export type SyncHandler = (op: OutboxOperation) => Promise<unknown>;

export class OfflineForbiddenError extends Error {
  constructor(public operation: string) {
    super(`Operation "${operation}" requires an online connection.`);
    this.name = 'OfflineForbiddenError';
  }
}

export class SyncConflictError extends Error {
  constructor(public reason: string, public serverPayload: unknown) {
    super(`Sync conflict: ${reason}`);
    this.name = 'SyncConflictError';
  }
}

const BACKOFF_MS = [1_000, 2_500, 5_000, 10_000, 30_000, 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;
const DRAIN_INTERVAL = 5_000;

/**
 * Readable message for anything thrown at us. Supabase's PostgrestError
 * is a plain object, not an Error — `String(err)` on it yields
 * "[object Object]", which silently defeated conflict detection and made
 * every `last_error` in the sync queue unreadable.
 */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as { message?: unknown; details?: unknown; code?: unknown };
    const parts = [o.message, o.details].filter(p => typeof p === 'string' && p) as string[];
    if (parts.length > 0) {
      return typeof o.code === 'string' && o.code
        ? `${parts.join(' — ')} (${o.code})`
        : parts.join(' — ');
    }
  }
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * True when the error means "the server rejected this on the merits" —
 * replaying it will never succeed, so it belongs in conflict review.
 *
 * Deliberately narrow: matching the bare substring "409" would classify
 * a perfectly retryable network error whose message happens to contain
 * an amount or id like 1409 as an unresolvable conflict.
 */
export function isConflictSignal(err: unknown): boolean {
  if (err instanceof SyncConflictError) return true;
  if (/\bCONFLICT_[A-Z0-9_]+/.test(errorMessage(err, ''))) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return status === 409 || status === '409';
}

class SyncEngine {
  private handlers = new Map<string, SyncHandler>();
  private listeners = new Set<(s: SyncState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight drain pass, so concurrent callers await the same work. */
  private drainPromise: Promise<void> | null = null;
  /** Set when a drain is requested while one is already running. */
  private drainAgain = false;
  private state: SyncState = { online: true, pending: 0, in_flight: 0, failed: 0 };

  registerHandler(operation: string, handler: SyncHandler) {
    this.handlers.set(operation, handler);
  }

  async start() {
    await getOrCreateClientId();
    await this.recoverOrphanedOps();
    networkMonitor.start();
    networkMonitor.subscribe(online => {
      this.state = { ...this.state, online };
      this.emit();
      if (online) void this.drain();
    });
    this.state = { ...this.state, online: networkMonitor.online };

    this.timer = setInterval(() => { void this.drain(); }, DRAIN_INTERVAL);
    await this.refreshCounts();
    void this.drain();
  }

  /**
   * Ops left `in_flight` when the tab was closed mid-request are orphans:
   * `pickNext` only ever looks at `pending`, so without this they sit in
   * the outbox forever — invisible to the retry loop and to the counters.
   * Handlers are idempotent on the op id, so requeueing is safe.
   */
  private async recoverOrphanedOps() {
    const stale = await db.outbox.where('status').equals('in_flight').toArray();
    if (stale.length === 0) return;
    await db.outbox.bulkPut(stale.map(op => ({
      ...op,
      status: 'pending' as const,
      next_attempt_at: null,
    })));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    networkMonitor.stop();
  }

  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  /** Public API — called by feature services. Returns the op id. */
  async enqueue<TPayload>(args: {
    id?: string;
    operation: string;
    entity_type: string;
    entity_id: string;
    payload: TPayload;
    user_id: string;
  }): Promise<string> {
    if (ONLINE_ONLY_OPERATIONS.has(args.operation) && !networkMonitor.online) {
      throw new OfflineForbiddenError(args.operation);
    }
    const id        = args.id ?? crypto.randomUUID();
    const client_id = await getOrCreateClientId();
    const op: OutboxOperation = {
      id,
      client_id,
      user_id: args.user_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      operation: args.operation,
      payload: args.payload,
      client_timestamp: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      last_error: null,
      synced_at: null,
      server_response: null,
      next_attempt_at: null,
    };
    await db.outbox.put(op);
    await this.refreshCounts();
    void this.drain();
    return id;
  }

  /** Manual retry for a failed op (UI control). */
  async retry(id: string) {
    const op = await db.outbox.get(id);
    if (!op) return;
    await db.outbox.update(id, {
      status: 'pending', attempts: 0, last_error: null, next_attempt_at: null,
    });
    await this.refreshCounts();
    await this.drain();
  }

  /** Manual discard (UI control — shows up in conflict review). */
  async discard(id: string) {
    await db.outbox.delete(id);
    await this.refreshCounts();
  }

  /**
   * Drain pending ops, one at a time. Concurrent callers share the
   * running pass rather than being dropped — a caller that awaits this
   * (the "sync now" button, tests) must not resolve before the work is
   * actually done.
   */
  drain(): Promise<void> {
    if (this.drainPromise) {
      // A pass is already running; make sure it takes another lap so ops
      // enqueued just now aren't stranded until the next interval tick.
      this.drainAgain = true;
      return this.drainPromise;
    }
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    do {
      this.drainAgain = false;
      if (!networkMonitor.online) break;
      try {
        // Loop until no more pending ops are due right now. Ops in
        // backoff are skipped here and picked up by a later pass.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const op = await this.pickNext();
          if (!op) break;
          await this.process(op);
          if (!networkMonitor.online) break;
        }
      } finally {
        await this.refreshCounts();
      }
    } while (this.drainAgain);
  }

  private async pickNext(): Promise<OutboxOperation | null> {
    // Pending ops, oldest first, skipping any still inside their backoff
    // window. Without the due-time gate the oldest failing op is picked
    // again immediately on every lap and nothing behind it ever syncs.
    const now = Date.now();
    const pending = await db.outbox.where('status').equals('pending')
      .sortBy('client_timestamp');
    return pending.find(op => {
      if (!op.next_attempt_at) return true;
      const due = Date.parse(op.next_attempt_at);
      return Number.isNaN(due) || due <= now;
    }) ?? null;
  }

  private async process(op: OutboxOperation) {
    const handler = this.handlers.get(op.operation);
    if (!handler) {
      // Not retryable — replaying will not conjure a handler. Mark failed
      // so it leaves the pending queue instead of blocking everything.
      await db.outbox.update(op.id, {
        status: 'failed',
        last_error: `No handler registered for "${op.operation}"`,
        attempts: op.attempts + 1,
        next_attempt_at: null,
      });
      await this.refreshCounts();
      return;
    }

    await db.outbox.update(op.id, { status: 'in_flight' });
    await this.refreshCounts();

    try {
      const response = await handler(op);

      // Success — mark synced and write a small audit row server-side
      // (best-effort; never blocks the local update).
      const synced_at = new Date().toISOString();
      await db.outbox.update(op.id, {
        status: 'synced',
        synced_at,
        server_response: response ?? null,
        last_error: null,
      });
      void this.recordServerAudit(op, synced_at).catch(() => undefined);
    } catch (err) {
      const message = errorMessage(err);

      if (isConflictSignal(err)) {
        await db.conflicts.put({
          id: crypto.randomUUID(),
          operation_id: op.id,
          entity_type: op.entity_type,
          entity_id: op.entity_id,
          local_payload: op.payload,
          server_payload: err instanceof SyncConflictError ? err.serverPayload : null,
          reason: message,
          resolved: false,
          resolution: null,
          created_at: new Date().toISOString(),
        });
        await db.outbox.update(op.id, {
          status: 'conflict', last_error: message,
          attempts: op.attempts + 1, next_attempt_at: null,
        });
        return;
      }

      const attempts = op.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.outbox.update(op.id, {
          status: 'failed', attempts, last_error: message, next_attempt_at: null,
        });
      } else {
        // Backoff is recorded on the row, not slept on here: sleeping
        // inside the drain loop holds up every other queued op.
        // `attempts` is already incremented, so index from attempts - 1
        // or the first (shortest) delay is never used.
        const wait = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 60_000;
        await db.outbox.update(op.id, {
          status: 'pending', attempts, last_error: message,
          next_attempt_at: new Date(Date.now() + wait).toISOString(),
        });
      }
    } finally {
      await this.refreshCounts();
    }
  }

  private async recordServerAudit(op: OutboxOperation, synced_at: string) {
    try {
      await supabase.from('sync_operations').upsert({
        id: op.id,
        client_id: op.client_id,
        user_id: op.user_id,
        entity_type: op.entity_type,
        entity_id: op.entity_id,
        operation: op.operation,
        client_timestamp: op.client_timestamp,
        synced_at,
      }, { onConflict: 'id' });
    } catch {
      /* audit is best-effort */
    }
  }

  private async refreshCounts() {
    // in_flight is read from the store rather than tracked as a counter:
    // an interrupted pass used to leave the counter permanently skewed.
    const [pending, in_flight, failed] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.outbox.where('status').equals('in_flight').count(),
      db.outbox.where('status').equals('failed').count(),
    ]);
    this.state = { ...this.state, pending, in_flight, failed };
    this.emit();
  }

  private emit() {
    const snap = { ...this.state };
    this.listeners.forEach(l => { try { l(snap); } catch { /* ignore */ } });
  }
}

export const syncEngine = new SyncEngine();
