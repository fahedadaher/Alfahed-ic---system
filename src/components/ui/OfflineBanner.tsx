// =====================================================================
// Sticky banner shown when the device is offline. Reading is fine —
// this just lets users know online-only actions are disabled.
// =====================================================================

import { useOnline } from '../../lib/network/network-monitor';
import { useT } from '../../lib/i18n';

export function OfflineBanner() {
  const online = useOnline();
  const t = useT();
  if (online) return null;
  return <div className="banner">{t('common.no_internet')}</div>;
}
