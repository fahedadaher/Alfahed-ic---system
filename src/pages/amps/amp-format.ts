// =====================================================================
// Formatting helpers for the amp / smart-meter screens.
// =====================================================================

import type { AmpSubscription, MeterAlert, SmartMeter } from '../../types/domain';
import { allowedMaxAmps } from '../../features/amps/amps.service';

export type T = (k: string, p?: Record<string, string | number>) => string;

export function fmtTime(iso: string | null | undefined, t: T): string {
  return iso ? new Date(iso).toLocaleString() : t('amps.never');
}

/** Translate an i18n error key, filling the limits it mentions. */
export function ampErrorText(
  key: string, t: T, sub: AmpSubscription | undefined, meter: SmartMeter | undefined,
): string {
  return t(key, {
    min:  meter?.min_amps ?? '—',
    max:  sub && meter ? allowedMaxAmps(sub, meter) : '—',
    step: meter?.step_amps ?? '—',
  });
}

const SERVER_ERRORS: [string, string][] = [
  ['AMPS_OUT_OF_RANGE',            'amps.err.out_of_range'],
  ['AMPS_BAD_STEP',                'amps.err.bad_step'],
  ['NO_CHANGE',                    'amps.err.no_change'],
  ['METER_NO_REMOTE_CONTROL',      'amps.err.no_remote'],
  ['NO_CONFIRMED_READING',         'amps.err.no_reading'],
  ['NO_METER_LINKED',              'amps.err.no_meter'],
  ['SUBSCRIPTION_NOT_ACTIVE',      'amps.err.not_active'],
  ['CONFLICT_COMMAND_IN_PROGRESS', 'amps.err.in_progress'],
];

/** Map a server error message (e.g. "AMPS_OUT_OF_RANGE:1-20") to readable text. */
export function serverErrorText(
  message: string, t: T, sub: AmpSubscription | undefined, meter: SmartMeter | undefined,
): string {
  const hit = SERVER_ERRORS.find(([code]) => message.includes(code));
  return hit ? ampErrorText(hit[1], t, sub, meter) : message;
}

/** Localized one-line summary of an alert (server `message` stays the detailed English record). */
export function alertText(
  a: MeterAlert, t: T, sub: AmpSubscription | undefined, meter: SmartMeter | undefined,
): string {
  const d = a.details ?? {};
  const v = (k: string) => (d[k] == null ? '—' : String(d[k]));
  return t(`health.msg.${a.kind}`, {
    sub:    sub?.subscription_no ?? '—',
    serial: meter?.serial_no ?? '—',
    reg:    v('registered_amps'),
    meter:  v('meter_amps'),
    limit:  v('limit'),
    amps:   v('confirmed_amps'),
  });
}
