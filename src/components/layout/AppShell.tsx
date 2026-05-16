// =====================================================================
// AppShell. Top bar with brand + sync + lang toggle + sign-out.
// Bottom nav (mobile) and iOS install prompt are rendered here once,
// outside the routed content.
// =====================================================================

import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useT } from '../../lib/i18n';
import { SyncIndicator } from '../ui/SyncIndicator';
import { OfflineBanner } from '../ui/OfflineBanner';
import { LanguageToggle } from '../ui/LanguageToggle';
import { IosInstallPrompt } from '../ui/IosInstallPrompt';
import { BottomNav } from './BottomNav';

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const t = useT();

  return (
    <>
      <div className="topbar">
        <strong style={{ flex: 1 }}>{t('app.name')}</strong>
        <SyncIndicator />
        <LanguageToggle />
        {profile && (
          <button
            className="ghost small"
            onClick={() => void signOut()}
            aria-label={t('common.sign_out')}
          >
            {t('common.sign_out')}
          </button>
        )}
      </div>

      <OfflineBanner />

      <main className={`shell ${profile ? 'with-bn' : ''}`}>
        {profile && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            {t('common.signed_in_as', {
              name: profile.full_name,
              role: t(`role.${profile.role}`),
            })}
          </div>
        )}
        {children}
      </main>

      {profile && <BottomNav />}
      <IosInstallPrompt />
    </>
  );
}
