// =====================================================================
// Smart-meter gateway types. Pure TypeScript — shared by the Deno edge
// function and the Vitest suite (no runtime-specific imports here).
// =====================================================================

/** What a meter reports when asked for its current amp limit. */
export interface MeterRead {
  amps: number;
  /** Device clock at the time of the read, ISO-8601, if the meter reports it. */
  meterTime: string | null;
}

/**
 * One adapter per meter vendor / head-end. Both calls talk to the
 * meter (or its head-end) — never to a cache.
 */
export interface MeterDriver {
  readLimit(serialNo: string): Promise<MeterRead>;
  /**
   * Ask the meter to set an ABSOLUTE limit. `requestId` is the command
   * id; adapters pass it on as the head-end's idempotency key. Resolving
   * means "accepted for delivery", not "applied" — only a read confirms.
   */
  setLimit(serialNo: string, amps: number, requestId: string): Promise<void>;
}

/** The meter / head-end refused the value — retrying will not help. */
export class MeterRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterRejectedError';
  }
}

export type ReadingSource = 'push' | 'poll' | 'command_verify';

/** Shape returned by the `meter_ingest_reading` RPC. */
export interface IngestResult {
  status: 'accepted' | 'rejected';
  reason?: string;
  changed?: boolean;
  linked?: boolean;
  change_id?: string;
  previous_amps?: number;
  new_amps?: number;
  source?: string;
  command?: 'confirmed' | 'superseded' | null;
  replay?: boolean;
}

export interface MeterRef {
  serial_no: string;
  driver: string;
}

/** Row returned by `meter_claim_commands`. */
export interface ClaimedCommand {
  command_id: string;
  meter_id: string;
  serial_no: string;
  driver: string;
  requested_amps: number;
  status: 'pending' | 'sent';
  attempts: number;
  last_sent_at: string | null;
  confirm_timeout_seconds: number;
  max_attempts: number;
}

/** Server-side state the gateway works against (Supabase RPCs in prod). */
export interface GatewayStore {
  getMeter(serialNo: string): Promise<MeterRef | null>;
  ingestReading(args: {
    readingId: string;
    serialNo: string;
    amps: number;
    meterTime: string | null;
    source: ReadingSource;
    externalEventId?: string | null;
  }): Promise<IngestResult>;
  recordFailure(serialNo: string, error: string): Promise<void>;
  claimPollBatch(limit: number): Promise<MeterRef[]>;
  claimCommands(limit: number): Promise<ClaimedCommand[]>;
  commandSent(commandId: string): Promise<void>;
  commandUnconfirmed(commandId: string, error: string, permanent: boolean): Promise<void>;
  healthCheck(): Promise<unknown>;
}

export interface GatewayDeps {
  store: GatewayStore;
  driverFor(key: string): MeterDriver;
  newId(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Read-backs right after a send (default 3) and the delay between them. */
  verifyReads?: number;
  verifyDelayMs?: number;
}
