// =====================================================================
// Tiny i18n module. No external dependency.
//
// - Arabic is the primary language (`ar`); English (`en`) is the fallback.
// - The `t()` function accepts a key path like "sale.new" and a small
//   parameters object. Missing keys log a warning in dev and return
//   the key itself so missing strings are obvious.
// - Language is persisted in localStorage so a refresh keeps the choice.
// =====================================================================

import { useEffect, useSyncExternalStore } from 'react';

export type Lang = 'ar' | 'en';

import { ar } from './dict/ar';
import { en } from './dict/en';

const DICTS: Record<Lang, Record<string, string>> = { ar, en };

const STORAGE_KEY = 'alfahad.lang';
const listeners = new Set<() => void>();

function detectInitial(): Lang {
  if (typeof window === 'undefined') return 'ar';
  const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
  if (saved === 'ar' || saved === 'en') return saved;
  // First run — default to Arabic.
  return 'ar';
}

let current: Lang = detectInitial();
applyDocument(current);

export function getLang(): Lang { return current; }

export function setLang(next: Lang) {
  if (next === current) return;
  current = next;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  applyDocument(next);
  listeners.forEach(l => { try { l(); } catch { /* ignore */ } });
}

function applyDocument(lang: Lang) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.setAttribute('lang', lang);
  html.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
}

/**
 * Translate a key. Supports `{name}` placeholders.
 *
 * @example  t('common.save')
 * @example  t('sale.qty_available', { qty: 5 })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[current];
  let str = dict[key];
  if (str === undefined) {
    // Fallback to English if Arabic missing, then to the key.
    str = DICTS.en[key] ?? key;
    if (typeof console !== 'undefined' && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key "${key}" for lang "${current}"`);
    }
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

/** React hook for the current language. Re-renders on change. */
export function useLang(): Lang {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => current,
    () => 'ar',
  );
}

/** Convenience: rerender on lang change without needing the value. */
export function useT() {
  useLang();
  // also poke once on mount in case docs need re-applying
  useEffect(() => { applyDocument(current); }, []);
  return t;
}
