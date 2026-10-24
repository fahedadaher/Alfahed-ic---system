// =====================================================================
// Amp subscriptions list. For each subscription: amps in the system vs
// the value confirmed on the meter, connection status, last sync and
// any in-flight meter command. Read-only, works offline from Dexie.
// =====================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { db } from '../../lib/db/indexeddb';
import { useT } from '../../lib/i18n';
import { ampSyncState, ampsRepo, ACTIVE_COMMAND_STATUSES } from '../../features/amps/amps.service';
import type { MeterCommand, SmartMeter } from '../../types/domain';
import { CommandBadge, ConnectionBadge, SyncStateBadge } from './amp-ui';
import { fmtTime } from './amp-format';

export function AmpSubscriptionsPage() {
  const t = useT();
  const [q, setQ] = useState('');

  const data = useLiveQuery(async () => {
    const [subs, meters, active] = await Promise.all([
      ampsRepo.subscriptions(),
      ampsRepo.meters(),
      db.meter_commands.filter(c => ACTIVE_COMMAND_STATUSES.has(c.status)).toArray(),
    ]);
    return {
      subs,
      meterById:  new Map<string, SmartMeter>(meters.map(m => [m.id, m])),
      cmdByMeter: new Map<string, MeterCommand>(active.map(c => [c.meter_id, c])),
    };
  }, []);

  if (!data) return <div className="card">{t('common.loading')}</div>;

  const needle = q.trim().toLowerCase();
  const rows = data.subs.filter(s => {
    if (!needle) return true;
    const serial = s.meter_id ? data.meterById.get(s.meter_id)?.serial_no ?? '' : '';
    return [s.subscription_no, s.subscriber_name, serial].some(v => v.toLowerCase().includes(needle));
  });

  return (
    <div className="col">
      <div className="row">
        <input className="grow" placeholder={t('amps.search')} value={q} onChange={e => setQ(e.target.value)} />
        <Link to="/amps/health"><button className="ghost">{t('amps.health')}</button></Link>
      </div>

      {rows.length === 0 && <div className="card list-empty">{t('amps.none')}</div>}

      {rows.map(s => {
        const meter = s.meter_id ? data.meterById.get(s.meter_id) : undefined;
        const cmd = meter ? data.cmdByMeter.get(meter.id) : undefined;
        return (
          <Link key={s.id} to={`/amps/${s.id}`} className="card col" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="kvp">
              <strong>{s.subscription_no} · {s.subscriber_name}</strong>
              <SyncStateBadge state={ampSyncState(s, meter)} t={t} />
            </div>
            <div className="kvp">
              <span className="k">{t('amps.registered')}</span>
              <span className="v">{t('amps.unit', { n: s.registered_amps })}</span>
            </div>
            <div className="kvp">
              <span className="k">{t('amps.on_meter')}</span>
              <span className="v">{meter?.confirmed_amps != null ? t('amps.unit', { n: meter.confirmed_amps }) : '—'}</span>
            </div>
            {meter && (
              <>
                <div className="kvp">
                  <span className="k">{t('amps.meter_serial')}</span>
                  <span className="v">{meter.serial_no}</span>
                </div>
                <div className="kvp">
                  <span className="k">{t('amps.connection')}</span>
                  <ConnectionBadge status={meter.connection_status} t={t} />
                </div>
                <div className="kvp">
                  <span className="k">{t('amps.last_sync')}</span>
                  <span className="v small">{fmtTime(meter.last_sync_at, t)}</span>
                </div>
              </>
            )}
            {cmd && (
              <div className="kvp">
                <span className="k">{t('amps.unit', { n: cmd.requested_amps })}</span>
                <CommandBadge status={cmd.status} t={t} />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
