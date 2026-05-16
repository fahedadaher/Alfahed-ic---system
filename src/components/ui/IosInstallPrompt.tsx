// =====================================================================
// iOS install prompt.
//
// iOS Safari does not fire `beforeinstallprompt`, so we detect Safari
// + not-yet-installed (no `standalone` flag) and show a one-time hint
// for "Add to Home Screen". Dismissals are persisted.
// =====================================================================

import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n';

const STORAGE_KEY = 'alfahad.ios-install-dismissed';

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    // @ts-expect-error — non-standard iOS Safari flag
    window.navigator.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

export function IosInstallPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isIosSafari() || isStandalone()) return;
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed) return;
    // Delay so it doesn't compete with sign-in.
    const id = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(id);
  }, []);

  if (!show) return null;

  return (
    <div className="ios-install" role="status" aria-live="polite">
      <div className="ii-text">
        <div className="ii-title">{t('pwa.install.title')}</div>
        <div className="muted small">{t('pwa.install.ios')}</div>
      </div>
      <button
        type="button"
        className="ghost small"
        onClick={() => {
          localStorage.setItem(STORAGE_KEY, '1');
          setShow(false);
        }}
      >
        {t('pwa.install.dismiss')}
      </button>
    </div>
  );
}
