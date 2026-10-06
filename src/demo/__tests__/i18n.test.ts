import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { i18n as I18n } from 'i18next';
import { ConvexError } from 'convex/values';
import { DEFINITION_ERROR_CODES } from '../../../convex/definitionModel';
import { REQUEST_ERROR_CODES } from '../../../convex/requestValues';
import { actionErrorData, actionErrorKeys, requestIssueMessage } from '../actionErrors';

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

  it.each(['builder', 'nav', 'requests', 'requestErrors'])('defines the same %s keys in both languages', (section) => {
    const english = leafKeys(i18n.getResourceBundle('en-US', 'translation')[section], section).sort();
    const chinese = leafKeys(i18n.getResourceBundle('zh-CN', 'translation')[section], section).sort();
    expect(english.length).toBeGreaterThan(0);
    expect(chinese).toEqual(english);
  });

  it('formats version numbers, field options and the system requester column through translations', () => {
    for (const language of ['en-US', 'zh-CN']) {
      const t = i18n.getFixedT(language);
      expect(t('builder.versionLabel', { version: 3 }), language).toContain('3');
      expect(t('builder.fieldOption', { label: 'Days', key: 'days' }), language).toMatch(/Days.*days/);
      for (const key of [
        'builder.systemColumns.requester',
        'builder.versionsTruncated',
        'builder.reviewersTruncated',
        'builder.dateRulePair',
        'builder.labelTooLong',
      ]) {
        expect(i18n.exists(key, { lng: language, fallbackLng: false }), `${language} ${key}`).toBe(true);
      }
    }
    expect(i18n.getFixedT('en-US')('builder.versionLabel', { version: 3 })).toBe('v3');
  });
});

describe('request text', () => {
  it('gives every request error code its own message in both languages', () => {
    for (const code of REQUEST_ERROR_CODES) {
      const key = `requestErrors.${code}`;
      for (const language of ['en-US', 'zh-CN']) {
        expect(i18n.exists(key, { lng: language, fallbackLng: false }), `${language} ${code}`).toBe(true);
      }
      expect(i18n.getFixedT('zh-CN')(key)).not.toBe(i18n.getFixedT('en-US')(key));
    }
  });

  it('puts the field label and the configured bounds into the message', () => {
    const t = i18n.getFixedT('en-US');
    const labelOf = (key: string) => (key === 'days' ? 'Days' : key);
    expect(
      requestIssueMessage({ code: 'RECORD_NUMBER_OUT_OF_RANGE', field: 'days', min: 1, max: 366 }, t, labelOf),
    ).toBe('Enter a number from 1 to 366 for Days.');
    expect(requestIssueMessage({ code: 'RECORD_TEXT_TOO_LONG', field: 'days', maxLength: 20 }, t, labelOf)).toContain(
      '20',
    );
    const zh = i18n.getFixedT('zh-CN');
    expect(requestIssueMessage({ code: 'RECORD_DATE_RANGE_INVALID', field: 'days' }, zh, labelOf)).toContain('Days');
  });

  it('reads bounds, revisions and the current version from a server error', () => {
    const error = new ConvexError({
      code: 'RECORD_DEFINITION_OUTDATED',
      message: 'x',
      currentVersionId: 'applicationDefinitionVersions:2',
    });
    expect(actionErrorData(error)).toMatchObject({ currentVersionId: 'applicationDefinitionVersions:2' });
    expect(
      actionErrorData(
        new ConvexError({ code: 'RECORD_NUMBER_OUT_OF_RANGE', message: 'x', field: 'days', min: 1, max: 3 }),
      ),
    ).toMatchObject({ field: 'days', min: 1, max: 3 });
  });
});
