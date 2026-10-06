import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { i18n as I18n } from 'i18next';
import { DEFINITION_ERROR_CODES } from '../../../convex/definitionModel';
import { actionErrorKeys } from '../actionErrors';

const MEMBERSHIP_ERROR_CODES = [
  'APPLICATION_ACCESS_DENIED',
  'PERMISSION_DENIED',
  'SELF_ADMINISTRATION_DENIED',
  'MEMBERSHIP_NOT_FOUND',
  'MEMBERSHIP_INACTIVE',
  'MEMBERSHIP_LIST_LIMIT_EXCEEDED',
];

let i18n: I18n;

beforeAll(async () => {
  vi.stubGlobal('document', { documentElement: { lang: '' } });
  i18n = (await import('../i18n')).default;
});

describe('membership error messages', () => {
  it.each(['en-US', 'zh-CN'])('translates every public membership error code in %s', (language) => {
    const t = i18n.getFixedT(language);
    for (const code of MEMBERSHIP_ERROR_CODES) {
      const key = `membershipErrors.${code}`;
      expect(i18n.exists(key, { lng: language, fallbackLng: false }), key).toBe(true);
      expect(t(key)).not.toBe(key);
    }
  });

  it('uses different text for each language', () => {
    for (const code of MEMBERSHIP_ERROR_CODES) {
      const key = `membershipErrors.${code}`;
      expect(i18n.getFixedT('zh-CN')(key)).not.toBe(i18n.getFixedT('en-US')(key));
    }
  });
});

function leafKeys(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, entry]) => leafKeys(entry, `${prefix}.${key}`));
}

describe('definition builder text', () => {
  it('maps every definition error code to its own message in both languages', () => {
    for (const code of DEFINITION_ERROR_CODES) {
      const key = actionErrorKeys.get(code);
      expect(key, code).toBe(`definitionErrors.${code}`);
      for (const language of ['en-US', 'zh-CN']) {
        expect(
          i18n.exists(`definitionErrors.${code}`, { lng: language, fallbackLng: false }),
          `${language} ${code}`,
        ).toBe(true);
      }
      expect(i18n.getFixedT('zh-CN')(`definitionErrors.${code}`)).not.toBe(
        i18n.getFixedT('en-US')(`definitionErrors.${code}`),
      );
    }
  });

  it('defines the same builder keys in both languages', () => {
    const english = leafKeys(i18n.getResourceBundle('en-US', 'translation').builder, 'builder').sort();
    const chinese = leafKeys(i18n.getResourceBundle('zh-CN', 'translation').builder, 'builder').sort();
    expect(english.length).toBeGreaterThan(0);
    expect(chinese).toEqual(english);
  });
});
