// =====================================================================
// Smart-meter gateway logic.
//
//   push   → the head-end says "something changed". The pushed value is
//            NOT trusted: we read the meter and ingest that reading.
//   poll   → meters due for a read (interval per meter / settings).
//   command→ read first (an earlier send may already have applied, so
//            retries never repeat work), send an ABSOLUTE limit, read
//            back. Only a reading equal to the requested value confirms
//            — that decision is made server-side in meter_ingest_reading.
//
// Everything here is safe to run twice: readings carry fresh ids,
// pushes carry the head-end event id, commands are leased and their id
// is the head-end idempotency key.
// =====================================================================

import type { ClaimedCommand, GatewayDeps, IngestResult, MeterRef, ReadingSource } from './types.ts';
import { MeterRejectedError } from './types.ts';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read the meter and hand the value to the server. null = meter unreachable. */
export async function readAndIngest(
  deps: GatewayDeps,
  meter: MeterRef,
  source: ReadingSource,
  externalEventId: string | null = null,
): Promise<IngestResult | null> {
  let read;
  try {
    read = await deps.driverFor(meter.driver).readLimit(meter.serial_no);
  } catch (err) {
    await deps.store.recordFailure(meter.serial_no, errText(err));
    return null;
  }
  return deps.store.ingestReading({
    readingId: deps.newId(),
    serialNo: meter.serial_no,
    amps: read.amps,
    meterTime: read.meterTime,
    source,
    externalEventId,
  });
}

export type PushOutcome = 'ingested' | 'unknown_meter' | 'unreachable';

/** Change notification from the head-end. */
export async function handlePush(
  deps: GatewayDeps,
  push: { serialNo: string; eventId: string | null },
): Promise<{ outcome: PushOutcome; result?: IngestResult }> {
  const meter = await deps.store.getMeter(push.serialNo);
  if (!meter) return { outcome: 'unknown_meter' };
  const result = await readAndIngest(deps, meter, 'push', push.eventId);
  return result ? { outcome: 'ingested', result } : { outcome: 'unreachable' };
}

export async function pollDue(deps: GatewayDeps, limit = 50) {
  const meters = await deps.store.claimPollBatch(limit);
  let ok = 0, failed = 0, changed = 0;
  for (const m of meters) {
    const r = await readAndIngest(deps, m, 'poll');
    if (!r) failed++;
    else { ok++; if (r.changed) changed++; }
  }
  return { polled: meters.length, ok, failed, changed };
}

export type CommandOutcome =
  | 'confirmed' | 'superseded' | 'unreachable' | 'waiting' | 'sent_unconfirmed'
  | 'rejected' | 'gave_up' | 'send_failed';

export async function processCommand(deps: GatewayDeps, cmd: ClaimedCommand): Promise<CommandOutcome> {
  const meter: MeterRef = { serial_no: cmd.serial_no, driver: cmd.driver };
  const { store } = deps;

  // 1. Read before acting.
  const before = await readAndIngest(deps, meter, 'command_verify');
  if (!before) {
    await store.commandUnconfirmed(cmd.command_id, 'METER_UNREACHABLE', false);
    return 'unreachable';
  }
  if (before.command === 'confirmed')  return 'confirmed';
  if (before.command === 'superseded') return 'superseded';

  // 2. A previous send may still be applying — don't send again yet.
  if (cmd.status === 'sent') {
    const sentAt = cmd.last_sent_at ? Date.parse(cmd.last_sent_at) : 0;
    if (deps.now() - sentAt < cmd.confirm_timeout_seconds * 1000) return 'waiting';
    if (cmd.attempts >= cmd.max_attempts) {
      await store.commandUnconfirmed(cmd.command_id, 'NOT_CONFIRMED_BY_METER', false);
      return 'gave_up';
    }
  }

  // 3. Send. Marked 'sent' first, so the command can no longer be
  //    cancelled once the meter might act on it.
  await store.commandSent(cmd.command_id);
  try {
    await deps.driverFor(cmd.driver).setLimit(cmd.serial_no, cmd.requested_amps, cmd.command_id);
  } catch (err) {
    if (err instanceof MeterRejectedError) {
      await store.commandUnconfirmed(cmd.command_id, `REJECTED: ${err.message}`, true);
      return 'rejected';
    }
    await store.commandUnconfirmed(cmd.command_id, `SEND_FAILED: ${errText(err)}`, false);
    return 'send_failed';
  }

  // 4. Read back. Confirmation happens in the ingest RPC.
  const reads = deps.verifyReads ?? 3;
  for (let i = 0; i < reads; i++) {
    await deps.sleep(deps.verifyDelayMs ?? 3_000);
    const after = await readAndIngest(deps, meter, 'command_verify');
    if (after?.command === 'confirmed')  return 'confirmed';
    if (after?.command === 'superseded') return 'superseded';
  }
  // Still 'sent': the lease runs out after the confirmation timeout and
  // the next tick re-reads, then re-sends or gives up.
  return 'sent_unconfirmed';
}

export async function processCommands(deps: GatewayDeps, limit = 20) {
  const cmds = await deps.store.claimCommands(limit);
  const outcomes: Record<string, CommandOutcome> = {};
  for (const c of cmds) outcomes[c.command_id] = await processCommand(deps, c);
  return outcomes;
}

/** One scheduler tick: commands first (users wait on them), then polls, then health. */
export async function tick(deps: GatewayDeps) {
  const commands = await processCommands(deps);
  const polls = await pollDue(deps);
  const health = await deps.store.healthCheck();
  return { commands, polls, health };
}
