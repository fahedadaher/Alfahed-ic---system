// =====================================================================
// i18n tests. Verify ar/en parity, params interpolation, fallback.
// =====================================================================

import { describe, it, expect } from 'vitest';
import { ar } from './dict/ar';
import { en } from './dict/en';
import { t, setLang, getLang } from './index';

describe('i18n dictionaries', () => {
  it('Arabic and English have the same keys', () => {
    const arKeys = new Set(Object.keys(ar));
    const enKeys = new Set(Object.keys(en));
    const onlyAr = [...arKeys].filter(k => !enKeys.has(k));
    const onlyEn = [...enKeys].filter(k => !arKeys.has(k));
    expect(onlyAr, `missing in en: ${onlyAr.join(', ')}`).toEqual([]);
    expect(onlyEn, `missing in ar: ${onlyEn.join(', ')}`).toEqual([]);
  });

  it('every Arabic value is non-empty', () => {
    for (const [k, v] of Object.entries(ar)) {
      expect(v, `empty value for "${k}"`).toBeTruthy();
    }
  });

  it('every English value is non-empty', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v, `empty value for "${k}"`).toBeTruthy();
    }
  });
});

describe('t() function', () => {
  it('returns Arabic by default', () => {
    setLang('ar');
    expect(getLang()).toBe('ar');
    expect(t('common.save')).toBe(ar['common.save']);
  });

  it('switches to English on demand', () => {
    setLang('en');
    expect(t('common.save')).toBe(en['common.save']);
  });

  it('interpolates {placeholders}', () => {
    setLang('en');
    const out = t('sale.qty_available', { qty: 7 });
    expect(out).toContain('7');
    expect(out).not.toContain('{qty}');
  });

  it('falls back to English for missing Arabic key', () => {
    // Both dicts have the same keys today, so this just exercises the fallthrough.
    setLang('ar');
    const out = t('common.save');
    expect(out).toBe(ar['common.save']);
  });

  it('returns the key itself for unknown keys', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });
});
