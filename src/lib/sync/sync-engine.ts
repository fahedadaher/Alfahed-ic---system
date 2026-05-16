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

class SyncEngine {
  private handlers = new Map<string, SyncHandler>();
  private listeners = new Set<(s: SyncState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private state: SyncState = { online: true, pending: 0, in_flight: 0, failed: 0 };

  registerHandler(operation: string, handler: SyncHandler) {
    this.handlers.set(operation, handler);
  }

  async start() {
    await getOrCreateClientId();
    networkMonitor.start();
    networkMonitor.subscribe(online => {
      this.state = { ...this.state, online };
      this.emit();
      if (online) void this.drain();
    });
    this.state.online = networkMonitor.online;

    this.timer = setInterval(() => { void this.drain(); }, DRAIN_INTERVAL);
    await this.refreshCounts();
    void this.drain();
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
    await db.outbox.update(id, { status: 'pending', attempts: 0, last_error: null });
    await this.refreshCounts();
    void this.drain();
  }

  /** Manual discard (UI control — shows up in conflict review). */
  async discard(id: string) {
    await db.outbox.delete(id);
    await this.refreshCounts();
  }

  /** Drain pending ops, one at a time. */
  async drain() {
    if (this.draining) return;
    if (!networkMonitor.online) return;
    this.draining = true;
    try {
      // Loop until no more pending ops we can process now.
      // (Failed-with-backoff ops are skipped if not yet due.)
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const op = await this.pickNext();
        if (!op) break;
        await this.process(op);
      }
    } finally {
      this.draining = false;
      await this.refreshCounts();
    }
  }

  private async pickNext(): Promise<OutboxOperation | null> {
    // Pending ops, ordered by client_timestamp.
    const pending = await db.outbox.where('status').equals('pending')
      .sortBy('client_timestamp');
    return pending[0] ?? null;
  }

  private async process(op: OutboxOperation) {
    const handler = this.handlers.get(op.operation);
    if (!handler) {
      await db.outbox.update(op.id, {
        status: 'failed',
        last_error: `No handler registered for "${op.operation}"`,
        attempts: op.attempts + 1,
      });
      return;
    }

    await db.outbox.update(op.id, { status: 'in_flight' });
    this.state = { ...this.state, in_flight: this.state.in_flight + 1 };
    this.emit();

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
      const message = err instanceof Error ? err.message : String(err);
      const isConflict =
        err instanceof SyncConflictError ||
        message.toLowerCase().includes('conflict') ||
        message.includes('CONFLICT') ||
        message.includes('409');

      if (isConflict) {
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
          status: 'conflict', last_error: message, attempts: op.attempts + 1,
        });
        return;
      }

      const attempts = op.attempts + 1;
      const status: OutboxOperation['status'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await db.outbox.update(op.id, { status, attempts, last_error: message });

      if (status === 'pending') {
        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 60_000;
        await new Promise(r => setTimeout(r, wait));
      }
    } finally {
      this.state = { ...this.state, in_flight: Math.max(0, this.state.in_flight - 1) };
      this.emit();
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
    const [pending, failed] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.outbox.where('status').equals('failed').count(),
    ]);
    this.state = { ...this.state, pending, failed };
    this.emit();
  }

  private emit() {
    const snap = { ...this.state };
    this.listeners.forEach(l => { try { l(snap); } catch { /* ignore */ } });
  }
}

export const syncEngine = new SyncEngine();
