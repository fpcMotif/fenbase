import { afterEach, describe, expect, it } from 'vitest';
import {
  compareCalendarDates,
  isCalendarDate,
  validateDefinition,
  type Definition,
  type DefinitionField,
} from '../definitionModel';

const REVIEWER = 'memberships:b';

type FieldOf<T extends DefinitionField['type']> = Extract<DefinitionField, { type: T }>;

const daysField: FieldOf<'number'> = {
  type: 'number',
  key: 'days',
  label: { enUS: 'Days', zhCN: '天数' },
  required: true,
  min: 1,
  max: 366,
  integer: true,
};
const reasonField: FieldOf<'text'> = {
  type: 'text',
  key: 'reason',
  label: { enUS: 'Reason', zhCN: '原因' },
  required: true,
  maxLength: 1000,
};
const leaveFields: DefinitionField[] = [
  { type: 'date', key: 'startDate', label: { enUS: 'Start date', zhCN: '开始日期' }, required: true },
  { type: 'date', key: 'endDate', label: { enUS: 'End date', zhCN: '结束日期' }, required: true },
  daysField,
  reasonField,
];

function leave(overrides: Partial<Definition> = {}): Definition {
  return {
    fields: leaveFields,
    listColumns: ['startDate', 'endDate', 'days', 'reason'],
    dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
    policyPreset: 'requesterAndAssignedReviewer',
    reviewerMembershipId: REVIEWER,
    ...overrides,
  } as Definition;
}

const originalTimeZone = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe('calendar dates', () => {
  it.each(['UTC', 'Australia/Perth', 'Pacific/Kiritimati', 'America/Los_Angeles'])(
    'checks real calendar dates without time-zone conversion in %s',
    (timeZone) => {
      process.env.TZ = timeZone;
      expect(isCalendarDate('2028-02-29')).toBe(true);
      expect(isCalendarDate('2026-02-28')).toBe(true);
      expect(isCalendarDate('2026-12-31')).toBe(true);
      expect(isCalendarDate('2026-02-29')).toBe(false);
      expect(isCalendarDate('2100-02-29')).toBe(false);
      expect(isCalendarDate('2026-1-5')).toBe(false);
      expect(isCalendarDate('2026-13-01')).toBe(false);
      expect(isCalendarDate('2026-04-31')).toBe(false);
      expect(isCalendarDate('2026-01-01T00:00:00Z')).toBe(false);
      expect(compareCalendarDates('2026-01-31', '2026-02-01')).toBeLessThan(0);
      expect(compareCalendarDates('2026-02-01', '2026-02-01')).toBe(0);
      expect(compareCalendarDates('2027-01-01', '2026-12-31')).toBeGreaterThan(0);
    },
  );
});

describe('validateDefinition', () => {
  it('accepts the leave reference definition', () => {
    expect(validateDefinition(leave(), [])).toBeNull();
  });

  it.each<[string, Definition, { code: string; field?: string }]>([
    ['no fields', leave({ fields: [], listColumns: [] }), { code: 'DEFINITION_FIELD_COUNT_INVALID' }],
    [
      'more than 30 fields',
      leave({
        fields: Array.from({ length: 31 }, (_, index) => ({
          type: 'boolean' as const,
          key: `flag${index}`,
          label: { enUS: 'Flag', zhCN: '标记' },
          required: false,
        })),
        listColumns: ['flag0'],
        dateRules: [],
      }),
      { code: 'DEFINITION_FIELD_COUNT_INVALID' },
    ],
    [
      'a key that does not match the pattern',
      leave({ fields: [{ ...reasonField, key: 'Reason' }, ...leaveFields.slice(0, 3)] }),
      { code: 'DEFINITION_FIELD_KEY_INVALID', field: 'Reason' },
    ],
    [
      'a snake-case key',
      leave({ fields: [...leaveFields, { ...reasonField, key: 'extra_note' }] }),
      { code: 'DEFINITION_FIELD_KEY_INVALID', field: 'extra_note' },
    ],
    [
      'a reserved key',
      leave({ fields: [...leaveFields, { ...reasonField, key: 'status' }] }),
      { code: 'DEFINITION_FIELD_KEY_RESERVED', field: 'status' },
    ],
    [
      'a duplicate key',
      leave({ fields: [...leaveFields, { ...reasonField }] }),
      { code: 'DEFINITION_FIELD_KEY_DUPLICATE', field: 'reason' },
    ],
    [
      'a blank Chinese label',
      leave({ fields: [{ ...leaveFields[0], label: { enUS: 'Start date', zhCN: '   ' } }, ...leaveFields.slice(1)] }),
      { code: 'DEFINITION_FIELD_LABEL_INVALID', field: 'startDate' },
    ],
    [
      'a label longer than 120 characters',
      leave({
        fields: [{ ...leaveFields[0], label: { enUS: 'x'.repeat(121), zhCN: '开始' } }, ...leaveFields.slice(1)],
      }),
      { code: 'DEFINITION_FIELD_LABEL_INVALID', field: 'startDate' },
    ],
    [
      'a text maxLength of 0',
      leave({ fields: [...leaveFields.slice(0, 3), { ...reasonField, maxLength: 0 }] }),
      { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: 'reason' },
    ],
    [
      'a text maxLength of 4001',
      leave({ fields: [...leaveFields.slice(0, 3), { ...reasonField, maxLength: 4001 }] }),
      { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: 'reason' },
    ],
    [
      'a number min above max',
      leave({ fields: [...leaveFields.slice(0, 2), { ...daysField, min: 10, max: 1 }, leaveFields[3]] }),
      { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: 'days' },
    ],
    [
      'a NaN number bound',
      leave({ fields: [...leaveFields.slice(0, 2), { ...daysField, max: Number.NaN }, leaveFields[3]] }),
      { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: 'days' },
    ],
    [
      'a fractional bound on an integer field',
      leave({ fields: [...leaveFields.slice(0, 2), { ...daysField, min: 0.5 }, leaveFields[3]] }),
      { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: 'days' },
    ],
    [
      'a list column that is not a field',
      leave({ listColumns: ['startDate', 'employee'] }),
      { code: 'DEFINITION_LIST_COLUMNS_INVALID', field: 'employee' },
    ],
    [
      'a repeated list column',
      leave({ listColumns: ['startDate', 'startDate'] }),
      { code: 'DEFINITION_LIST_COLUMNS_INVALID', field: 'startDate' },
    ],
    ['no list columns', leave({ listColumns: [] }), { code: 'DEFINITION_LIST_COLUMNS_INVALID' }],
    [
      'eleven list columns',
      leave({
        fields: Array.from({ length: 11 }, (_, index) => ({
          type: 'boolean' as const,
          key: `flag${index}`,
          label: { enUS: 'Flag', zhCN: '标记' },
          required: false,
        })),
        listColumns: Array.from({ length: 11 }, (_, index) => `flag${index}`),
        dateRules: [],
      }),
      { code: 'DEFINITION_LIST_COLUMNS_INVALID' },
    ],
    [
      'a date rule on a number field',
      leave({ dateRules: [{ startKey: 'startDate', endKey: 'days' }] }),
      { code: 'DEFINITION_DATE_RULE_INVALID', field: 'days' },
    ],
    [
      'a date rule comparing a field with itself',
      leave({ dateRules: [{ startKey: 'startDate', endKey: 'startDate' }] }),
      { code: 'DEFINITION_DATE_RULE_INVALID', field: 'startDate' },
    ],
    [
      'an unknown policy preset',
      leave({ policyPreset: 'everyoneSeesEverything' } as unknown as Partial<Definition>),
      { code: 'DEFINITION_POLICY_INVALID' },
    ],
  ])('rejects %s with the first error code', (_label, definition, expected) => {
    expect(validateDefinition(definition, [])).toEqual(expected);
  });

  it('rejects a field type the builder does not support', () => {
    const fields: unknown[] = [...leaveFields, { type: 'json', key: 'payload', label: leaveFields[0].label }];
    expect(validateDefinition(leave({ fields: fields as DefinitionField[] }), [])).toEqual({
      code: 'DEFINITION_FIELD_TYPE_UNKNOWN',
      field: 'payload',
    });
  });

  it('keeps every published key with its type', () => {
    const published = leaveFields.map(({ key, type }) => ({ key, type }));
    expect(
      validateDefinition(leave({ fields: leaveFields.slice(1), listColumns: ['endDate'], dateRules: [] }), published),
    ).toEqual({
      code: 'DEFINITION_FIELD_REMOVED',
      field: 'startDate',
    });
    expect(
      validateDefinition(
        leave({
          fields: [
            ...leaveFields.slice(0, 2),
            { type: 'text', key: 'days', label: leaveFields[2].label, required: true, maxLength: 10 },
            leaveFields[3],
          ],
        }),
        published,
      ),
    ).toEqual({ code: 'DEFINITION_FIELD_TYPE_CHANGED', field: 'days' });
    expect(
      validateDefinition(
        leave({
          fields: [
            ...leaveFields,
            { type: 'text', key: 'note', label: { enUS: 'Note', zhCN: '备注' }, required: false, maxLength: 500 },
          ],
        }),
        published,
      ),
    ).toBeNull();
  });
});
