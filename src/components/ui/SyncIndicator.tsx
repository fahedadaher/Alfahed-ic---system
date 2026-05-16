// =====================================================================
// Sync indicator. Pill in the top bar showing the outbox state.
// =====================================================================

import { useSyncState } from '../../hooks/useLiveQuery';
import { useT } from '../../lib/i18n';

export function SyncIndicator() {
  const s = useSyncState();
  const t = useT();

  const tone =
    !s.online      ? 'danger' :
    s.failed > 0   ? 'warn'   :
    s.in_flight > 0 || s.pending > 0 ? '' : 'ok';

  const label =
    !s.online                          ? t('sync.offline') :
    s.in_flight > 0                    ? t('sync.syncing', { n: s.in_flight + s.pending }) :
    s.pending > 0                      ? t('sync.queued',  { n: s.pending }) :
    s.failed > 0                       ? t('sync.failed',  { n: s.failed }) :
    t('sync.synced');

  const cls = ['badge', tone, s.in_flight > 0 ? 'pulse' : ''].filter(Boolean).join(' ');

  return <span className={cls} title={label}>{label}</span>;
}
