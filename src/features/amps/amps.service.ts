// =====================================================================
// Amp subscriptions ⇄ smart meters service.
//
// Every operation here is online-only and server-authoritative. A
// successful `requestChange` means "the server queued a command" — the
// change is DONE only when meter_commands.status becomes 'confirmed',
// which the server sets solely from a meter reading. The UI must derive
// success from that status, never from the outbox.
// =====================================================================

import { syncEngine } from '../../lib/sync/sync-engine';
import { db } from '../../lib/db/indexeddb';
import type {
  AmpSubscription, SmartMeter, MeterCommand, MeterCommandStatus, AmpChange,
} from '../../types/domain';

export const ACTIVE_COMMAND_STATUSES: ReadonlySet<MeterCommandStatus> = new Set(['pending', 'sent']);

/** i18n keys for client-side pre-checks (the server re-validates). */
export type AmpRequestError =
  | 'amps.err.not_active' | 'amps.err.no_meter' | 'amps.err.no_remote'
  | 'amps.err.no_reading' | 'amps.err.out_of_range' | 'amps.err.bad_step'
  | 'amps.err.no_change'  | 'amps.err.in_progress';

/** Highest value a command may set: hardware limit ∩ installation limit. */
export function allowedMaxAmps(sub: AmpSubscription, meter: SmartMeter): number {
  return Math.min(meter.max_amps, sub.max_connection_amps ?? meter.max_amps);
}

export function validateRequestedAmps(
  sub: AmpSubscription,
  meter: SmartMeter | undefined,
  activeCommand: MeterCommand | undefined,
  amps: number,
): AmpRequestError | null {
  if (sub.status !== 'active')            return 'amps.err.not_active';
  if (!meter || sub.meter_id !== meter.id) return 'amps.err.no_meter';
  if (!meter.supports_remote_control)     return 'amps.err.no_remote';
  if (meter.confirmed_amps == null)       return 'amps.err.no_reading';
  if (activeCommand)                      return 'amps.err.in_progress';
  if (!Number.isFinite(amps) || amps < meter.min_amps || amps > allowedMaxAmps(sub, meter)) {
    return 'amps.err.out_of_range';
  }
  // compare in hundredths to dodge float noise (numeric(7,2) server-side)
  if (Math.round(amps * 100) % Math.round(meter.step_amps * 100) !== 0) return 'amps.err.bad_step';
  if (amps === meter.confirmed_amps)      return 'amps.err.no_change';
  return null;
}

export type AmpSyncState =
  | 'unlinked'      // no meter
  | 'never_read'    // linked, no confirmed reading yet
  | 'offline'       // meter unreachable; showing last confirmed value
  | 'mismatch'      // system ≠ meter (e.g. above technical limit)
  | 'in_sync';

export function ampSyncState(sub: AmpSubscription, meter: SmartMeter | undefined): AmpSyncState {
  if (!sub.meter_id || !meter)                    return 'unlinked';
  if (meter.confirmed_amps == null)               return 'never_read';
  if (meter.connection_status === 'offline')      return 'offline';
  if (meter.confirmed_amps !== sub.registered_amps) return 'mismatch';
  return 'in_sync';
}

export const ampsRepo = {
  subscriptions: () => db.amp_subscriptions.orderBy('subscription_no').toArray(),
  meters:        () => db.smart_meters.toArray(),
  activeCommandFor: async (meterId: string) =>
    db.meter_commands.where('meter_id').equals(meterId)
      .filter(c => ACTIVE_COMMAND_STATUSES.has(c.status)).first(),
  commandsFor: (subscriptionId: string) =>
    db.meter_commands.where('subscription_id').equals(subscriptionId).reverse().sortBy('requested_at'),
  changesFor: (subscriptionId: string) =>
    db.amp_change_log.where('subscription_id').equals(subscriptionId).reverse().sortBy('changed_at'),
  openAlerts: () =>
    db.meter_alerts.where('status').equals('open').reverse().sortBy('last_seen_at'),
};

export const ampsService = {
  /**
   * Queue a set-limit command. Returns the command id; watch
   * `meter_commands[id].status` for the meter's confirmation.
   */
  async requestChange(args: {
    subscriptionId: string;
    requestedAmps: number;
    note: string | null;
    userId: string;
  }): Promise<string> {
    const commandId = crypto.randomUUID();
    await syncEngine.enqueue({
      id: commandId,
      operation: 'rpc:request_amp_change',
      entity_type: 'meter_command',
      entity_id: commandId,
      user_id: args.userId,
      payload: {
        command_id:      commandId,
        subscription_id: args.subscriptionId,
        requested_amps:  args.requestedAmps,
        note:            args.note,
      },
    });
    return commandId;
  },

  cancel: (commandId: string, userId: string) => syncEngine.enqueue({
    operation: 'rpc:cancel_amp_command', entity_type: 'meter_command', entity_id: commandId,
    user_id: userId, payload: { command_id: commandId },
  }),

  linkMeter: (subscriptionId: string, meterId: string, userId: string) => syncEngine.enqueue({
    operation: 'rpc:link_meter', entity_type: 'amp_subscription', entity_id: subscriptionId,
    user_id: userId, payload: { subscription_id: subscriptionId, meter_id: meterId },
  }),

  unlinkMeter: (subscriptionId: string, userId: string) => syncEngine.enqueue({
    operation: 'rpc:unlink_meter', entity_type: 'amp_subscription', entity_id: subscriptionId,
    user_id: userId, payload: { subscription_id: subscriptionId },
  }),

  resolveAlert: (alertId: string, note: string | null, userId: string) => syncEngine.enqueue({
    operation: 'rpc:resolve_meter_alert', entity_type: 'meter_alert', entity_id: alertId,
    user_id: userId, payload: { alert_id: alertId, note },
  }),

  runHealthCheck: (userId: string) => syncEngine.enqueue({
    operation: 'rpc:run_meter_health_check', entity_type: 'meter_health', entity_id: crypto.randomUUID(),
    user_id: userId, payload: {},
  }),
};

// ---------------------------------------------------------------------
// Report: every amp change, as CSV (UTF-8 BOM so Excel shows Arabic).
// ---------------------------------------------------------------------
export function changeReportCsv(
  changes: AmpChange[],
  subs: Map<string, AmpSubscription>,
  meters: Map<string, SmartMeter>,
  actorName: (id: string | null) => string,
): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['changed_at', 'subscription_no', 'subscriber', 'meter_serial',
                  'previous_amps', 'new_amps', 'delta', 'source', 'actor', 'command_id'];
  const rows = [...changes]
    .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    .map(c => [
      c.changed_at,
      subs.get(c.subscription_id)?.subscription_no,
      subs.get(c.subscription_id)?.subscriber_name,
      meters.get(c.meter_id)?.serial_no,
      c.previous_amps, c.new_amps, c.new_amps - c.previous_amps,
      c.source, actorName(c.actor_id), c.command_id,
    ].map(esc).join(','));
  return '﻿' + [header.join(','), ...rows].join('\n');
}
