// =====================================================================
// Sync types. The outbox is the durable log of intents that the
// device generates while online or offline; the sync engine drains it.
// =====================================================================

export type SyncStatus = 'pending' | 'in_flight' | 'synced' | 'failed' | 'conflict';

/**
 * Operation envelope. Persisted in IndexedDB and replayed by the sync
 * engine. The `id` is generated client-side and is the idempotency key
 * — re-sending the same op MUST be a no-op on the server.
 */
export interface OutboxOperation<TPayload = unknown> {
  id: string;
  client_id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: TPayload;
  client_timestamp: string;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
  server_response: unknown | null;
  /**
   * Earliest time this op may be retried (ISO). `null` means "due now".
   * Set when a failed op is requeued so backoff is a property of the row
   * rather than a sleep inside the drain loop — otherwise one failing op
   * stalls every op behind it.
   */
  next_attempt_at: string | null;
}

export interface SyncMeta {
  key: string;
  value: unknown;
  updated_at: string;
}

export interface ConflictRecord {
  id: string;
  operation_id: string;
  entity_type: string;
  entity_id: string;
  local_payload: unknown;
  server_payload: unknown;
  reason: string;
  resolved: boolean;
  resolution: 'local_wins' | 'server_wins' | 'merged' | null;
  created_at: string;
}

/** Operations FORBIDDEN when offline. UI must check this list. */
export const ONLINE_ONLY_OPERATIONS = new Set<string>([
  'rpc:close_trip',
  'rpc:approve_cashier',
  'rpc:approve_production',
  'rpc:transfer_vehicle',
  'rpc:adjust_inventory',
  'rpc:vehicle_load',
]);

/** Operations SAFE offline. */
export const OFFLINE_SAFE_OPERATIONS = new Set<string>([
  'rpc:process_sale',
  'rpc:process_return',
]);
