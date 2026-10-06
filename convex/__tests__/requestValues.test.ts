import { describe, expect, it } from 'vitest';
import type { Definition, DefinitionField } from '../definitionModel';
import {
  MAX_REQUEST_VALUES_BYTES,
  isCalendarDate,
  isRequestErrorCode,
  normalizeRequestValues,
  validateRequestValues,
} from '../requestValues';

const leaveFields: DefinitionField[] = [
  { type: 'date', key: 'startDate', label: { enUS: 'Start date', zhCN: '开始日期' }, required: true },
  { type: 'date', key: 'endDate', label: { enUS: 'End date', zhCN: '结束日期' }, required: true },
  {
    type: 'number',
    key: 'days',
    label: { enUS: 'Days', zhCN: '天数' },
    required: true,
    min: 1,
    max: 366,
    integer: true,
  },
  { type: 'text', key: 'reason', label: { enUS: 'Reason', zhCN: '原因' }, required: true, maxLength: 1000 },
];

const leave: Pick<Definition, 'fields' | 'dateRules'> = {
  fields: leaveFields,
  dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
};

const valid = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Family visit' };

describe('calendar dates', () => {
  it.each(['2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31', '2026-12-31'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '2023-02-29',
    '1900-02-29',
    '2025-04-31',
    '2025-13-01',
    '2025-00-10',
    '2025-01-00',
    '0000-01-01',
    '25-1-1',
    '2025-1-01',
    '2026-03-02T00:00:00Z',
    ' 2026-03-02',
    '２０２６-03-02',
  ])('rejects %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});

describe('request value validation', () => {
  it('accepts values that satisfy the pinned definition', () => {
    expect(validateRequestValues(leave, valid)).toBeNull();
  });

  it('reports a server-owned key before an unknown key, and both before field checks', () => {
    expect(validateRequestValues(leave, { ...valid, mystery: 1, state: 'approved' })).toEqual({
      code: 'RECORD_FIELD_SERVER_OWNED',
      field: 'state',
    });
    expect(validateRequestValues(leave, { reviewerMembershipId: 'memberships:x' })).toEqual({
      code: 'RECORD_FIELD_SERVER_OWNED',
      field: 'reviewerMembershipId',
    });
    expect(validateRequestValues(leave, { mystery: 1 })).toEqual({ code: 'RECORD_FIELD_UNKNOWN', field: 'mystery' });
  });

  it('requires present values, treats blank text as missing and false as present', () => {
    const withoutDays: Record<string, unknown> = { ...valid };
    delete withoutDays.days;
    expect(validateRequestValues(leave, withoutDays)).toEqual({ code: 'RECORD_FIELD_REQUIRED', field: 'days' });
    expect(validateRequestValues(leave, { ...valid, reason: '   ' })).toEqual({
      code: 'RECORD_FIELD_REQUIRED',
      field: 'reason',
    });
    const withFlag = {
      fields: [
        ...leaveFields,
        { type: 'boolean', key: 'urgent', label: { enUS: 'Urgent', zhCN: '加急' }, required: true } as const,
      ],
      dateRules: leave.dateRules,
    };
    expect(validateRequestValues(withFlag, { ...valid, urgent: false })).toBeNull();
  });

  it.each<[string, unknown]>([
    ['text as number', { reason: 12 }],
    ['number as string', { days: '3' }],
    ['NaN', { days: Number.NaN }],
    ['Infinity', { days: Number.POSITIVE_INFINITY }],
    ['date as number', { startDate: 20260302 }],
    ['object', { reason: { text: 'x' } }],
  ])('rejects a mistyped %s', (_label, override) => {
    const issue = validateRequestValues(leave, { ...valid, ...(override as object) });
    expect(issue?.code).toBe('RECORD_FIELD_TYPE_INVALID');
  });

  it('checks text maxLength at the boundary', () => {
    expect(validateRequestValues(leave, { ...valid, reason: 'x'.repeat(1000) })).toBeNull();
    expect(validateRequestValues(leave, { ...valid, reason: 'x'.repeat(1001) })).toEqual({
      code: 'RECORD_TEXT_TOO_LONG',
      field: 'reason',
      maxLength: 1000,
    });
  });

  it('checks number bounds and integers at the boundary', () => {
    expect(validateRequestValues(leave, { ...valid, days: 1 })).toBeNull();
    expect(validateRequestValues(leave, { ...valid, days: 366 })).toBeNull();
    for (const days of [0, 367]) {
      expect(validateRequestValues(leave, { ...valid, days })).toEqual({
        code: 'RECORD_NUMBER_OUT_OF_RANGE',
        field: 'days',
        min: 1,
        max: 366,
      });
    }
    expect(validateRequestValues(leave, { ...valid, days: 1.5 })).toEqual({
      code: 'RECORD_NUMBER_NOT_INTEGER',
      field: 'days',
    });
  });

  it('rejects an impossible calendar date', () => {
    expect(validateRequestValues(leave, { ...valid, endDate: '2026-02-30' })).toEqual({
      code: 'RECORD_DATE_INVALID',
      field: 'endDate',
    });
  });

  it('rejects a reversed range on the end key, accepts an equal range, and skips a rule with a missing value', () => {
    expect(validateRequestValues(leave, { ...valid, endDate: '2026-03-01' })).toEqual({
      code: 'RECORD_DATE_RANGE_INVALID',
      field: 'endDate',
    });
    expect(validateRequestValues(leave, { ...valid, endDate: valid.startDate })).toBeNull();
    const optional = {
      fields: leaveFields.map((field) => ({ ...field, required: false })),
      dateRules: leave.dateRules,
    };
    expect(validateRequestValues(optional, { startDate: '2026-03-05' })).toBeNull();
  });

  it('applies the configured rule to whatever keys the definition names', () => {
    const renamed = {
      fields: [
        { type: 'date', key: 'leaveFrom', label: { enUS: 'From', zhCN: '从' }, required: true } as const,
        { type: 'date', key: 'leaveTo', label: { enUS: 'To', zhCN: '到' }, required: true } as const,
      ],
      dateRules: [{ startKey: 'leaveFrom', endKey: 'leaveTo' }],
    };
    expect(validateRequestValues(renamed, { leaveFrom: '2026-05-02', leaveTo: '2026-05-01' })).toEqual({
      code: 'RECORD_DATE_RANGE_INVALID',
      field: 'leaveTo',
    });
    expect(
      validateRequestValues({ ...renamed, dateRules: [] }, { leaveFrom: '2026-05-02', leaveTo: '2026-05-01' }),
    ).toBeNull();
  });

  it('counts the size budget in UTF-8 bytes of the canonical JSON', () => {
    const wide = {
      fields: [
        { type: 'text', key: 'a', label: { enUS: 'A', zhCN: '甲' }, required: false, maxLength: 4000 } as const,
        { type: 'text', key: 'b', label: { enUS: 'B', zhCN: '乙' }, required: false, maxLength: 4000 } as const,
        { type: 'text', key: 'c', label: { enUS: 'C', zhCN: '丙' }, required: false, maxLength: 4000 } as const,
      ],
      dateRules: [],
    };
    // {"a":"","b":"","c":""} is 22 bytes of structure around the text.
    const structure = 22;
    const fitting = MAX_REQUEST_VALUES_BYTES - structure;
    const exact = { a: 'x'.repeat(4000), b: 'x'.repeat(fitting - 8000), c: 'x'.repeat(4000) };
    expect(validateRequestValues(wide, exact)).toBeNull();
    expect(validateRequestValues(wide, { ...exact, b: `${exact.b}x` })).toEqual({ code: 'RECORD_TOO_LARGE' });
    // 3 bytes per character in UTF-8: 3000 characters of 汉 is 9000 bytes, under every maxLength but over the budget.
    expect(validateRequestValues(wide, { a: '汉'.repeat(3000) })).toEqual({ code: 'RECORD_TOO_LARGE' });
  });

  it('treats keys named like built-in object properties as ordinary fields', () => {
    const builtIns = {
      fields: [
        { type: 'text', key: 'toString', label: { enUS: 'A', zhCN: '甲' }, required: false, maxLength: 10 } as const,
        {
          type: 'number',
          key: 'constructor',
          label: { enUS: 'B', zhCN: '乙' },
          required: true,
          min: 0,
          max: 9,
          integer: true,
        } as const,
        { type: 'date', key: 'valueOf', label: { enUS: 'C', zhCN: '丙' }, required: false } as const,
        { type: 'date', key: 'hasOwnProperty', label: { enUS: 'D', zhCN: '丁' }, required: false } as const,
      ],
      dateRules: [{ startKey: 'valueOf', endKey: 'hasOwnProperty' }],
    };
    expect(validateRequestValues(builtIns, { constructor: 1 })).toBeNull();
    expect(validateRequestValues(builtIns, {})).toEqual({ code: 'RECORD_FIELD_REQUIRED', field: 'constructor' });
  });

  it('treats a blank optional value of any type as missing', () => {
    const optional = {
      fields: [
        { type: 'text', key: 'note', label: { enUS: 'Note', zhCN: '备注' }, required: false, maxLength: 10 } as const,
        { type: 'date', key: 'returnDate', label: { enUS: 'Return', zhCN: '返回' }, required: false } as const,
      ],
      dateRules: [],
    };
    expect(validateRequestValues(optional, { note: '   ', returnDate: '' })).toBeNull();
  });

  it('reports field issues in definition order', () => {
    expect(validateRequestValues(leave, { startDate: 'bad', endDate: 'bad', days: 0, reason: '' })).toEqual({
      code: 'RECORD_DATE_INVALID',
      field: 'startDate',
    });
  });
});

describe('request error codes', () => {
  it('recognizes request codes and nothing else', () => {
    expect(isRequestErrorCode('RECORD_DATE_RANGE_INVALID')).toBe(true);
    expect(isRequestErrorCode('DEFINITION_NOT_FOUND')).toBe(false);
    expect(isRequestErrorCode('')).toBe(false);
  });
});

describe('request value normalization', () => {
  it('drops blank text so an empty value is never stored', () => {
    expect(normalizeRequestValues({ note: '', reason: '  ', days: 3, urgent: false })).toEqual({
      days: 3,
      urgent: false,
    });
  });

  it('stores negative zero as zero, so a later 0 to -0 change is not a silent no-op', () => {
    expect(Object.is(normalizeRequestValues({ balance: -0 }).balance, 0)).toBe(true);
  });

  it('keeps text with surrounding spaces as typed', () => {
    expect(normalizeRequestValues({ reason: ' Visit ' })).toEqual({ reason: ' Visit ' });
  });
});
