// =====================================================================
// Login page. Email + password. Honors offline state — login requires
// connectivity, so we show a clear message instead of swallowing the
// inevitable failure.
// =====================================================================

import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth/AuthProvider';
import { useOnline } from '../lib/network/network-monitor';
import { useT } from '../lib/i18n';
import { LanguageToggle } from '../components/ui/LanguageToggle';

export function LoginPage() {
  const { signIn } = useAuth();
  const online = useOnline();
  const t = useT();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!online) { setErr(t('offline.signin_unavailable')); return; }
    setBusy(true);
    const { error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error) setErr(error);
  }

  return (
    <main className="shell" style={{ maxWidth: 420 }}>
      <div className="card col">
        <div className="row">
          <h1 style={{ margin: 0, flex: 1 }}>{t('common.sign_in')}</h1>
          <LanguageToggle />
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>{t('app.tagline')}</p>

        <form className="col" onSubmit={onSubmit}>
          <label className="col" style={{ gap: 4 }}>
            <span className="small muted">{t('common.email')}</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="col" style={{ gap: 4 }}>
            <span className="small muted">{t('common.password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>

          {!online && <div className="badge danger">{t('offline.signin_unavailable')}</div>}
          {err && <div className="badge danger">{err}</div>}

          <button type="submit" disabled={busy || !online}>
            {busy ? t('common.signing_in') : t('common.sign_in')}
          </button>
        </form>
      </div>
    </main>
  );
}
