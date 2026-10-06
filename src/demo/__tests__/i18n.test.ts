import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { i18n as I18n } from 'i18next';

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
