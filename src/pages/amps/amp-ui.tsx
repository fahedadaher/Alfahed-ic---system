// =====================================================================
// Small shared components for the amp / smart-meter screens.
//
// Status wording is deliberately literal: 'sent' says "waiting for the
// meter", and only 'confirmed' (set server-side from a meter reading)
// reads as success.
// =====================================================================

import type { MeterCommandStatus, MeterConnectionStatus } from '../../types/domain';
import type { AmpSyncState } from '../../features/amps/amps.service';
import type { T } from './amp-format';

const CMD_TONE: Record<MeterCommandStatus, string> = {
  pending: 'warn', sent: 'warn', confirmed: 'ok', failed: 'danger', expired: 'danger', cancelled: '',
};

export function CommandBadge({ status, t }: { status: MeterCommandStatus; t: T }) {
  return <span className={`badge ${CMD_TONE[status]}`}>{t(`amps.cmd.${status}`)}</span>;
}

const STATE_TONE: Record<AmpSyncState, string> = {
  in_sync: 'ok', mismatch: 'danger', offline: 'warn', never_read: 'warn', unlinked: 'danger',
};

export function SyncStateBadge({ state, t }: { state: AmpSyncState; t: T }) {
  return <span className={`badge ${STATE_TONE[state]}`}>{t(`amps.state.${state}`)}</span>;
}

const CONN_TONE: Record<MeterConnectionStatus, string> = { online: 'ok', offline: 'danger', unknown: 'warn' };

export function ConnectionBadge({ status, t }: { status: MeterConnectionStatus; t: T }) {
  return <span className={`badge ${CONN_TONE[status]}`}>{t(`amps.conn.${status}`)}</span>;
}
