// =====================================================================
// Compact language toggle. AR ⇄ EN.
// =====================================================================

import { setLang, useLang } from '../../lib/i18n';

export function LanguageToggle() {
  const lang = useLang();
  const next = lang === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() => setLang(next)}
      aria-label={`Switch language to ${next}`}
      title={next === 'ar' ? 'العربية' : 'English'}
    >
      {lang === 'ar' ? 'EN' : 'ع'}
    </button>
  );
}
