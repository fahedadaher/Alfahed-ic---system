// =====================================================================
// One amp subscription: meter link, system vs meter value, change-limit
// command, command history, change log and billing differences.
//
// The change form never reports success on its own. After submitting it
// follows the server's meter_commands row: pending → sent → confirmed
// (set server-side only when a meter reading shows the new value).
// =====================================================================

import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useOnline } from '../../lib/network/network-monitor';
import { db } from '../../lib/db/indexeddb';
import { OfflineForbiddenError } from '../../lib/sync/sync-engine';
import { useT } from '../../lib/i18n';
import {
  ampsService, ampsRepo, ampSyncState, allowedMaxAmps, validateRequestedAmps,
} from '../../features/amps/amps.service';
import { CommandBadge, ConnectionBadge, SyncStateBadge } from './amp-ui';
import { ampErrorText, fmtTime, serverErrorText } from './amp-format';

export function AmpSubscriptionDetailPage() {
  const { id = '' } = useParams();
  const { userId, can } = useAuth();
  const online = useOnline();
  const t = useT();

  const sub   = useLiveQuery(() => db.amp_subscriptions.get(id), [id]);
  const meter = useLiveQuery(async () => (sub?.meter_id ? db.smart_meters.get(sub.meter_id) : undefined), [sub?.meter_id]);
  const activeCmd = useLiveQuery(async () => (meter ? ampsRepo.activeCommandFor(meter.id) : undefined), [meter?.id]);
  const commands  = useLiveQuery(() => ampsRepo.commandsFor(id), [id]) ?? [];
  const changes   = useLiveQuery(() => ampsRepo.changesFor(id), [id]) ?? [];
  const adjustments = useLiveQuery(
    () => db.amp_billing_adjustments.where('subscription_id').equals(id).reverse().sortBy('created_at'), [id],
  ) ?? [];
  const freeMeters = useLiveQuery(async () => {
    const linked = new Set((await db.amp_subscriptions.toArray()).map(s => s.meter_id).filter(Boolean));
    return (await db.smart_meters.toArray()).filter(m => m.active && !linked.has(m.id));
  }, []) ?? [];

  const [amps, setAmps] = useState('');
  const [note, setNote] = useState('');
  const [linkTo, setLinkTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);

  // Follow the request: outbox op (was it recorded?) then the server command (did the meter apply it?).
  const requestOp  = useLiveQuery(async () => (lastCommandId ? db.outbox.get(lastCommandId) : undefined), [lastCommandId]);
  const requestCmd = useLiveQuery(async () => (lastCommandId ? db.meter_commands.get(lastCommandId) : undefined), [lastCommandId]);

  if (!sub) return <div className="card">{t('common.loading')}</div>;

  const state = ampSyncState(sub, meter);
  const canManage  = can('amp.manage');
  const canCommand = can('amp.command');

  async function run(fn: () => Promise<unknown>) {
    if (!userId) return;
    setErr(null); setBusy(true);
    try { await fn(); }
    catch (e) {
      setErr(e instanceof OfflineForbiddenError ? t('amps.err.offline') : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  function onSubmitChange(e: FormEvent) {
    e.preventDefault();
    if (!sub || !userId) return;
    const value = Number(amps);
    const problem = validateRequestedAmps(sub, meter, activeCmd, value);
    if (problem) { setErr(ampErrorText(problem, t, sub, meter)); return; }
    void run(async () => {
      const commandId = await ampsService.requestChange({
        subscriptionId: sub.id, requestedAmps: value, note: note.trim() || null, userId,
      });
      setLastCommandId(commandId);
      setAmps(''); setNote('');
    });
  }

  return (
    <div className="col">
      <div className="card col">
        <div className="kvp">
          <strong>{sub.subscription_no} · {sub.subscriber_name}</strong>
          <SyncStateBadge state={state} t={t} />
        </div>
        <div className="kvp"><span className="k">{t('amps.registered')}</span><span className="v">{t('amps.unit', { n: sub.registered_amps })}</span></div>
        <div className="kvp">
          <span className="k">{t('amps.on_meter')}</span>
          <span className="v">{meter?.confirmed_amps != null ? t('amps.unit', { n: meter.confirmed_amps }) : '—'}</span>
        </div>
        {meter && (
          <>
            <div className="kvp"><span className="k">{t('amps.meter_serial')}</span><span className="v">{meter.serial_no}</span></div>
            <div className="kvp"><span className="k">{t('amps.connection')}</span><ConnectionBadge status={meter.connection_status} t={t} /></div>
            <div className="kvp"><span className="k">{t('amps.confirmed_at')}</span><span className="v small">{fmtTime(meter.confirmed_at, t)}</span></div>
            <div className="kvp"><span className="k">{t('amps.last_sync')}</span><span className="v small">{fmtTime(meter.last_sync_at, t)}</span></div>
            <div className="kvp"><span className="k">{t('amps.last_seen')}</span><span className="v small">{fmtTime(meter.last_seen_at, t)}</span></div>
            <div className="kvp">
              <span className="k">{t('amps.allowed_range')}</span>
              <span className="v">{t('amps.range', { min: meter.min_amps, max: allowedMaxAmps(sub, meter) })}</span>
            </div>
            {state === 'offline' && <div className="badge warn">{t('amps.offline_note', { at: fmtTime(meter.confirmed_at, t) })}</div>}
          </>
        )}
      </div>

      {canManage && (
        <div className="card col">
          <strong>{t('amps.link.title')}</strong>
          {sub.meter_id ? (
            <button className="ghost" disabled={!online || busy || !!activeCmd}
              onClick={() => void run(() => ampsService.unlinkMeter(sub.id, userId!))}>
              {t('amps.link.unlink')}
            </button>
          ) : freeMeters.length === 0 ? (
            <div className="list-empty small">{t('amps.link.no_free')}</div>
          ) : (
            <div className="row">
              <select className="grow" value={linkTo} onChange={e => setLinkTo(e.target.value)}>
                <option value="">{t('amps.link.select')}</option>
                {freeMeters.map(m => <option key={m.id} value={m.id}>{m.serial_no}{m.model ? ` · ${m.model}` : ''}</option>)}
              </select>
              <button disabled={!online || busy || !linkTo}
                onClick={() => void run(() => ampsService.linkMeter(sub.id, linkTo, userId!))}>
                {t('amps.link.confirm')}
              </button>
            </div>
          )}
        </div>
      )}

      {canCommand && meter && (
        <form className="card col" onSubmit={onSubmitChange}>
          <strong>{t('amps.change.title')}</strong>
          {!meter.supports_remote_control ? (
            <div className="muted small">{t('amps.change.no_remote')}</div>
          ) : (
            <>
              <div className="muted small">{t('amps.change.rule')}</div>
              <label className="col">
                <span className="small muted">{t('amps.change.new_value')}</span>
                <input type="number" inputMode="decimal" min={meter.min_amps} max={allowedMaxAmps(sub, meter)}
                  step={meter.step_amps} value={amps} onChange={e => setAmps(e.target.value)} required />
              </label>
              <input placeholder={t('common.notes')} value={note} onChange={e => setNote(e.target.value)} />
              <button type="submit" disabled={!online || busy || !!activeCmd}>{t('amps.change.submit')}</button>
              {activeCmd && <div className="small muted">{t('amps.change.wait_active')}</div>}
              {!online && <div className="badge warn">{t('amps.err.offline')}</div>}
            </>
          )}

          {lastCommandId && (
            requestCmd
              ? <CommandBadge status={requestCmd.status} t={t} />
              : requestOp && (requestOp.status === 'failed' || requestOp.status === 'conflict')
                ? <div className="badge danger">
                    {t('amps.cmd.request_failed', { err: serverErrorText(requestOp.last_error ?? '', t, sub, meter) })}
                  </div>
                : <div className="badge warn">{t('amps.cmd.queued')}</div>
          )}
        </form>
      )}

      {err && <div className="badge danger">{err}</div>}

      <div className="card col">
        <strong>{t('amps.cmd.title')}</strong>
        {commands.length === 0 && <div className="list-empty small">{t('amps.cmd.none')}</div>}
        {commands.map(c => (
          <div key={c.id} className="col" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div className="kvp">
              <span className="k">{t('amps.log.line', { from: c.previous_amps ?? '—', to: c.requested_amps })}</span>
              <CommandBadge status={c.status} t={t} />
            </div>
            <div className="kvp small muted">
              <span>{fmtTime(c.requested_at, t)}</span>
              <span>{t('amps.cmd.attempts', { n: c.attempts })}</span>
            </div>
            {c.last_error && c.status !== 'confirmed' && <div className="small muted">{c.last_error}</div>}
            {c.status === 'pending' && c.attempts === 0 && canCommand && (
              <button className="ghost" disabled={!online || busy}
                onClick={() => void run(() => ampsService.cancel(c.id, userId!))}>
                {t('amps.change.cancel')}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="card col">
        <strong>{t('amps.log.title')}</strong>
        {changes.length === 0 && <div className="list-empty small">{t('amps.log.none')}</div>}
        {changes.map(c => (
          <div key={c.id} className="kvp">
            <span className="k">{fmtTime(c.changed_at, t)} · {t(`amps.src.${c.source}`)}</span>
            <span className="v">{t('amps.log.line', { from: c.previous_amps, to: c.new_amps })}</span>
          </div>
        ))}
      </div>

      {can('amp.report') && (
        <div className="card col">
          <strong>{t('amps.adj.title')}</strong>
          <div className="muted small">{t('amps.adj.note')}</div>
          {adjustments.length === 0 && <div className="list-empty small">{t('amps.adj.none')}</div>}
          {adjustments.map(a => (
            <div key={a.id} className="kvp">
              <span className="k">{t('amps.adj.line', { amount: a.amount != null ? a.amount.toFixed(2) : '—', from: a.effective_from })}</span>
              <span className={`badge ${a.status === 'needs_pricing' ? 'danger' : a.status === 'pending' ? 'warn' : 'ok'}`}>
                {t(`amps.adj.${a.status}`)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
