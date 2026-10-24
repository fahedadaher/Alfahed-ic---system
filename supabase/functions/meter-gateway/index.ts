// =====================================================================
// meter-gateway edge function (Deno). Bridges smart meters ⇄ database.
//
//   POST /meter-gateway/push   head-end change notification
//        header  x-meter-signature: hex(HMAC-SHA256(body, METER_WEBHOOK_SECRET))
//        body    { "serial_no": "SM-001", "event_id": "evt-123" }
//   POST /meter-gateway/tick   scheduler (pg_cron, every minute)
//        header  Authorization: Bearer METER_CRON_SECRET
//
// Deploy with `supabase functions deploy meter-gateway --no-verify-jwt`
// (both routes authenticate with their own secret).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, METER_WEBHOOK_SECRET,
//      METER_CRON_SECRET, METER_HEADEND_URL, METER_HEADEND_TOKEN
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handlePush, tick } from '../_shared/meter/gateway.ts';
import { createHttpHeadendDriver } from '../_shared/meter/drivers.ts';
import type { GatewayDeps, GatewayStore, MeterDriver } from '../_shared/meter/types.ts';

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const store: GatewayStore = {
  async getMeter(serialNo) {
    const { data, error } = await supabase.from('smart_meters')
      .select('serial_no, driver').eq('serial_no', serialNo).eq('active', true).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  ingestReading: a => rpc('meter_ingest_reading', {
    p_reading_id: a.readingId, p_serial_no: a.serialNo, p_amps: a.amps,
    p_meter_time: a.meterTime, p_source: a.source, p_external_event_id: a.externalEventId ?? null,
  }),
  recordFailure: async (serialNo, error) => { await rpc('meter_record_failure', { p_serial_no: serialNo, p_error: error }); },
  claimPollBatch: limit => rpc('meter_claim_poll_batch', { p_limit: limit }),
  claimCommands: limit => rpc('meter_claim_commands', { p_limit: limit }),
  commandSent: async id => { await rpc('meter_command_sent', { p_command_id: id }); },
  commandUnconfirmed: async (id, error, permanent) => {
    await rpc('meter_command_unconfirmed', { p_command_id: id, p_error: error, p_permanent: permanent });
  },
  healthCheck: () => rpc('run_meter_health_check', {}),
};

const drivers: Record<string, MeterDriver> = {
  http_headend: createHttpHeadendDriver({
    baseUrl: env('METER_HEADEND_URL'),
    token: env('METER_HEADEND_TOKEN'),
  }),
};

const deps: GatewayDeps = {
  store,
  driverFor(key) {
    const d = drivers[key];
    if (!d) throw new Error(`UNKNOWN_DRIVER:${key}`);
    return d;
  },
  newId: () => crypto.randomUUID(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  now: () => Date.now(),
};

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    if (path.endsWith('/push')) {
      const raw = await req.text();
      const expected = await hmacHex(env('METER_WEBHOOK_SECRET'), raw);
      if (!safeEqual(req.headers.get('x-meter-signature') ?? '', expected)) {
        return json(401, { error: 'BAD_SIGNATURE' });
      }
      const body = JSON.parse(raw) as { serial_no?: string; event_id?: string };
      if (!body.serial_no) return json(400, { error: 'SERIAL_REQUIRED' });
      const out = await handlePush(deps, { serialNo: body.serial_no, eventId: body.event_id ?? null });
      return json(out.outcome === 'unknown_meter' ? 404 : 200, out);
    }

    if (path.endsWith('/tick')) {
      const auth = req.headers.get('authorization') ?? '';
      if (!safeEqual(auth, `Bearer ${env('METER_CRON_SECRET')}`)) return json(401, { error: 'UNAUTHORIZED' });
      return json(200, await tick(deps));
    }

    return json(404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('[meter-gateway]', err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
