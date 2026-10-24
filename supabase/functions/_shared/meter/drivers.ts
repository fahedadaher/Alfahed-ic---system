// =====================================================================
// Meter adapters.
//
// `http_headend` speaks a small REST contract that a vendor head-end (or
// a thin bridge in front of a DLMS/Modbus head-end) must expose:
//
//   GET  {base}/meters/{serial}/current-limit
//        → 200 { "amps": 16, "timestamp": "2026-10-24T09:00:00Z" }
//   PUT  {base}/meters/{serial}/current-limit
//        { "amps": 16, "request_id": "<command uuid>" }
//        → 2xx accepted · 400/409/422 refused (not retried) · other → retry
//
// `simulator` is an in-memory meter for tests and demos.
// =====================================================================

import type { MeterDriver, MeterRead } from './types.ts';
import { MeterRejectedError } from './types.ts';

export function createHttpHeadendDriver(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): MeterDriver {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'PUT', serialNo: string, body?: unknown): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
    try {
      return await doFetch(`${base}/meters/${encodeURIComponent(serialNo)}/current-limit`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async readLimit(serialNo): Promise<MeterRead> {
      const res = await call('GET', serialNo);
      if (!res.ok) throw new Error(`HEADEND_READ_${res.status}`);
      const json = await res.json() as { amps?: unknown; timestamp?: unknown };
      const amps = Number(json.amps);
      if (json.amps === null || json.amps === undefined || !Number.isFinite(amps)) {
        throw new Error('HEADEND_BAD_READ_PAYLOAD');
      }
      return { amps, meterTime: typeof json.timestamp === 'string' ? json.timestamp : null };
    },

    async setLimit(serialNo, amps, requestId) {
      const res = await call('PUT', serialNo, { amps, request_id: requestId });
      if (res.ok) return;
      const detail = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 409 || res.status === 422) {
        throw new MeterRejectedError(`HEADEND_${res.status} ${detail}`.trim());
      }
      throw new Error(`HEADEND_SET_${res.status}`);
    },
  };
}

/** In-memory meter fleet. `applyDelayReads` = reads before a set takes effect. */
export function createSimulatorDriver(initial: Record<string, number> = {}) {
  const limits = new Map(Object.entries(initial));
  const pending = new Map<string, { amps: number; readsLeft: number }>();
  const offline = new Set<string>();
  const setCalls: { serialNo: string; amps: number; requestId: string }[] = [];
  let applyDelayReads = 0;

  const driver: MeterDriver = {
    async readLimit(serialNo) {
      if (offline.has(serialNo)) throw new Error('SIM_OFFLINE');
      const p = pending.get(serialNo);
      if (p) {
        if (p.readsLeft <= 0) { limits.set(serialNo, p.amps); pending.delete(serialNo); }
        else p.readsLeft--;
      }
      const amps = limits.get(serialNo);
      if (amps === undefined) throw new Error('SIM_UNKNOWN_METER');
      return { amps, meterTime: null };
    },
    async setLimit(serialNo, amps, requestId) {
      if (offline.has(serialNo)) throw new Error('SIM_OFFLINE');
      setCalls.push({ serialNo, amps, requestId });
      if (applyDelayReads === 0) limits.set(serialNo, amps);
      else pending.set(serialNo, { amps, readsLeft: applyDelayReads });
    },
  };

  return {
    driver,
    setCalls,
    /** Simulate someone changing the meter on site. */
    setLocal(serialNo: string, amps: number) { limits.set(serialNo, amps); pending.delete(serialNo); },
    setOffline(serialNo: string, isOffline: boolean) {
      if (isOffline) offline.add(serialNo); else offline.delete(serialNo);
    },
    setApplyDelayReads(n: number) { applyDelayReads = n; },
    /** Simulate a meter that accepts commands but never applies them. */
    dropPending(serialNo: string) { pending.delete(serialNo); },
    current(serialNo: string) { return limits.get(serialNo); },
  };
}
