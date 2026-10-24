// =====================================================================
// Gateway orchestration tests. The fake store mirrors the one rule of
// meter_ingest_reading that matters here: a command is confirmed only
// by a reading equal to its requested value (SQL behaviour itself is
// covered by supabase/tests/0004_smart_meter_amps.test.sql).
// =====================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { handlePush, processCommand, pollDue } from './gateway';
import { createHttpHeadendDriver, createSimulatorDriver } from './drivers';
import type { ClaimedCommand, GatewayDeps, GatewayStore, IngestResult, MeterRef } from './types';
import { MeterRejectedError } from './types';

interface FakeCommand { id: string; serial: string; requested: number; status: string; attempts: number; error: string | null }

function setup(initial: Record<string, number> = { 'SM-1': 10 }) {
  const sim = createSimulatorDriver(initial);
  const readings: { serialNo: string; amps: number; source: string; externalEventId?: string | null }[] = [];
  const failures: string[] = [];
  const commands = new Map<string, FakeCommand>();
  let clock = 1_000_000;

  const store: GatewayStore = {
    async getMeter(serialNo) {
      return sim.current(serialNo) === undefined ? null : { serial_no: serialNo, driver: 'sim' };
    },
    async ingestReading(a): Promise<IngestResult> {
      readings.push(a);
      const cmd = [...commands.values()].find(c => c.serial === a.serialNo && (c.status === 'pending' || c.status === 'sent'));
      if (cmd && cmd.requested === a.amps) {
        cmd.status = 'confirmed';
        return { status: 'accepted', command: 'confirmed' };
      }
      return { status: 'accepted', command: null };
    },
    async recordFailure(serialNo) { failures.push(serialNo); },
    async claimPollBatch(): Promise<MeterRef[]> { return [{ serial_no: 'SM-1', driver: 'sim' }]; },
    async claimCommands() { return []; },
    async commandSent(id) { const c = commands.get(id)!; c.status = 'sent'; c.attempts++; },
    async commandUnconfirmed(id, error, permanent) {
      const c = commands.get(id)!;
      c.error = error;
      if (permanent || c.attempts >= 3) c.status = 'failed';
    },
    async healthCheck() { return {}; },
  };

  const deps: GatewayDeps = {
    store,
    driverFor: () => sim.driver,
    newId: () => crypto.randomUUID(),
    sleep: async () => { clock += 1_000; },
    now: () => clock,
    verifyReads: 3,
    verifyDelayMs: 1,
  };

  function command(requested: number, over: Partial<ClaimedCommand> = {}): ClaimedCommand {
    const id = crypto.randomUUID();
    commands.set(id, { id, serial: 'SM-1', requested, status: over.status ?? 'pending', attempts: over.attempts ?? 0, error: null });
    return {
      command_id: id, meter_id: 'm1', serial_no: 'SM-1', driver: 'sim', requested_amps: requested,
      status: 'pending', attempts: 0, last_sent_at: null, confirm_timeout_seconds: 120, max_attempts: 3,
      ...over,
    };
  }

  return { sim, deps, readings, failures, commands, command, advance: (ms: number) => { clock += ms; } };
}

describe('meter gateway', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('push: reads the meter instead of trusting the notification', async () => {
    t.sim.setLocal('SM-1', 6);
    const out = await handlePush(t.deps, { serialNo: 'SM-1', eventId: 'evt-9' });
    expect(out.outcome).toBe('ingested');
    expect(t.readings).toEqual([expect.objectContaining({ amps: 6, source: 'push', externalEventId: 'evt-9' })]);
  });

  it('push: unknown meter is reported, nothing ingested', async () => {
    const out = await handlePush(t.deps, { serialNo: 'NOPE', eventId: null });
    expect(out.outcome).toBe('unknown_meter');
    expect(t.readings).toHaveLength(0);
  });

  it('poll: unreachable meter records a failure and no reading', async () => {
    t.sim.setOffline('SM-1', true);
    const r = await pollDue(t.deps);
    expect(r).toMatchObject({ polled: 1, failed: 1, ok: 0 });
    expect(t.failures).toEqual(['SM-1']);
    expect(t.readings).toHaveLength(0);
  });

  it('command: confirmed only after a read-back shows the new value', async () => {
    const cmd = t.command(16);
    const out = await processCommand(t.deps, cmd);
    expect(out).toBe('confirmed');
    expect(t.sim.setCalls).toEqual([{ serialNo: 'SM-1', amps: 16, requestId: cmd.command_id }]);
    expect(t.readings.map(r => r.amps)).toEqual([10, 16]);
    expect(t.commands.get(cmd.command_id)?.status).toBe('confirmed');
  });

  it('command: meter accepts but never applies → stays unconfirmed', async () => {
    t.sim.setApplyDelayReads(99);
    const cmd = t.command(16);
    const out = await processCommand(t.deps, cmd);
    expect(out).toBe('sent_unconfirmed');
    expect(t.commands.get(cmd.command_id)?.status).toBe('sent');
    expect(t.sim.current('SM-1')).toBe(10);
  });

  it('command: slow meter is confirmed on a later read-back', async () => {
    t.sim.setApplyDelayReads(2);
    const out = await processCommand(t.deps, t.command(16));
    expect(out).toBe('confirmed');
    expect(t.sim.setCalls).toHaveLength(1);
  });

  it('retry: meter already at requested value → confirmed WITHOUT sending again', async () => {
    t.sim.setLocal('SM-1', 16);   // earlier send applied, response was lost
    const cmd = t.command(16, { status: 'sent', attempts: 1, last_sent_at: new Date(0).toISOString() });
    const out = await processCommand(t.deps, cmd);
    expect(out).toBe('confirmed');
    expect(t.sim.setCalls).toHaveLength(0);
  });

  it('retry: within the confirmation window → waits, does not resend', async () => {
    const cmd = t.command(16, { status: 'sent', attempts: 1, last_sent_at: new Date(t.deps.now() - 5_000).toISOString() });
    expect(await processCommand(t.deps, cmd)).toBe('waiting');
    expect(t.sim.setCalls).toHaveLength(0);
  });

  it('retry: window elapsed → resends the same absolute value with the same request id', async () => {
    const cmd = t.command(16, { status: 'sent', attempts: 1, last_sent_at: new Date(t.deps.now() - 600_000).toISOString() });
    expect(await processCommand(t.deps, cmd)).toBe('confirmed');
    expect(t.sim.setCalls).toEqual([{ serialNo: 'SM-1', amps: 16, requestId: cmd.command_id }]);
  });

  it('retry: max attempts reached → gives up without sending', async () => {
    const cmd = t.command(16, { status: 'sent', attempts: 3, last_sent_at: new Date(0).toISOString() });
    expect(await processCommand(t.deps, cmd)).toBe('gave_up');
    expect(t.sim.setCalls).toHaveLength(0);
    expect(t.commands.get(cmd.command_id)?.status).toBe('failed');
  });

  it('command: unreachable meter → not sent, retried later', async () => {
    t.sim.setOffline('SM-1', true);
    const cmd = t.command(16);
    expect(await processCommand(t.deps, cmd)).toBe('unreachable');
    expect(t.sim.setCalls).toHaveLength(0);
    expect(t.commands.get(cmd.command_id)).toMatchObject({ status: 'pending', error: 'METER_UNREACHABLE' });
  });

  it('command: meter refuses the value → permanent failure', async () => {
    const deps: GatewayDeps = {
      ...t.deps,
      driverFor: () => ({
        readLimit: () => t.sim.driver.readLimit('SM-1'),
        setLimit: async () => { throw new MeterRejectedError('above breaker rating'); },
      }),
    };
    const cmd = t.command(16);
    expect(await processCommand(deps, cmd)).toBe('rejected');
    expect(t.commands.get(cmd.command_id)?.status).toBe('failed');
  });
});

describe('http head-end driver', () => {
  const res = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('reads amps and device time', async () => {
    const d = createHttpHeadendDriver({
      baseUrl: 'https://he.example/', token: 'tok',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://he.example/meters/SM%2F1/current-limit');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        return res(200, { amps: 16, timestamp: '2026-10-24T09:00:00Z' });
      },
    });
    await expect(d.readLimit('SM/1')).resolves.toEqual({ amps: 16, meterTime: '2026-10-24T09:00:00Z' });
  });

  it('rejects a malformed read', async () => {
    const d = createHttpHeadendDriver({ baseUrl: 'https://he', token: 't', fetchImpl: async () => res(200, { amps: null }) });
    await expect(d.readLimit('SM-1')).rejects.toThrow('HEADEND_BAD_READ_PAYLOAD');
  });

  it('maps 422 to a permanent rejection and 503 to a retryable error', async () => {
    const d422 = createHttpHeadendDriver({ baseUrl: 'https://he', token: 't', fetchImpl: async () => res(422, 'too high') });
    await expect(d422.setLimit('SM-1', 99, 'r1')).rejects.toBeInstanceOf(MeterRejectedError);
    const d503 = createHttpHeadendDriver({ baseUrl: 'https://he', token: 't', fetchImpl: async () => res(503, '') });
    const err = await d503.setLimit('SM-1', 16, 'r1').catch(e => e);
    expect(err).not.toBeInstanceOf(MeterRejectedError);
    expect(String(err.message)).toBe('HEADEND_SET_503');
  });

  it('sends the command id as request_id', async () => {
    let sent: unknown;
    const d = createHttpHeadendDriver({
      baseUrl: 'https://he', token: 't',
      fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return res(202, ''); },
    });
    await d.setLimit('SM-1', 16, 'cmd-1');
    expect(sent).toEqual({ amps: 16, request_id: 'cmd-1' });
  });
});
