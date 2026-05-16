// =====================================================================
// Vehicle loading service. Manager-only, online-only.
//
// Loading transfers stock from the factory to a vehicle in the context
// of a trip. The server validates factory stock and writes movements;
// realtime then refreshes both balances on every device.
// =====================================================================

import { syncEngine } from '../../lib/sync/sync-engine';

export interface LoadLine { product_id: string; quantity: number }

export const vehicleLoadsService = {
  async load(args: {
    tripId: string;
    vehicleId: string;
    factoryId: string;
    userId: string;
    lines: LoadLine[];
  }): Promise<string> {
    if (args.lines.length === 0) throw new Error('Add at least one product line.');

    return syncEngine.enqueue({
      operation: 'rpc:vehicle_load',
      entity_type: 'vehicle_load',
      entity_id: args.tripId,
      user_id: args.userId,
      payload: {
        trip_id:    args.tripId,
        vehicle_id: args.vehicleId,
        factory_id: args.factoryId,
        lines:      args.lines,
      },
    });
  },
};
