// =====================================================================
// Trips service.
//
// Trips are mostly server-driven (manager creates and loads them), but
// the driver flips status locally when they start the trip and triggers
// an online-only RPC to close.
// =====================================================================

import { db } from '../../lib/db/indexeddb';
import { syncEngine } from '../../lib/sync/sync-engine';
import { tripsRepo } from '../../lib/db/repositories';
import type { Trip } from '../../types/domain';

export const tripsService = {
  active: tripsRepo.active,
  get:    tripsRepo.get,

  /** Optimistic local flip to `in_progress`. Server is reconciled later. */
  async markInProgress(tripId: string, userId: string): Promise<void> {
    const trip = await db.trips.get(tripId);
    if (!trip) throw new Error('Trip not found');
    if (trip.status !== 'loaded') return;

    const now = new Date().toISOString();
    await db.trips.update(tripId, { status: 'in_progress', started_at: now, updated_at: now });

    await syncEngine.enqueue({
      operation: 'rpc:start_trip',
      entity_type: 'trip',
      entity_id: tripId,
      user_id: userId,
      payload: { trip_id: tripId, started_at: now },
    });
  },

  /** Online-only. Sync engine throws OfflineForbiddenError if not. */
  async close(args: {
    tripId: string;
    closingCash: number;
    notes: string | null;
    userId: string;
  }): Promise<string> {
    return syncEngine.enqueue({
      operation: 'rpc:close_trip',
      entity_type: 'trip',
      entity_id: args.tripId,
      user_id: args.userId,
      payload: { trip_id: args.tripId, closing_cash: args.closingCash, notes: args.notes },
    });
  },

  upsert(trip: Trip) { return db.trips.put(trip); },
};
