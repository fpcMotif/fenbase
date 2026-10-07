import { describe, expect, it } from 'vitest';
import type { DefinitionField } from '../../../convex/definitionModel';
import {
  carryOverValues,
  columnTitle,
  dateRangeFilters,
  fieldLabel,
  toFormValues,
  toRequestValues,
} from '../requestForm';

const fields: DefinitionField[] = [
  { type: 'date', key: 'startDate', label: { enUS: 'Start date', zhCN: '开始日期' }, required: true },
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
  { type: 'boolean', key: 'urgent', label: { enUS: 'Urgent', zhCN: '加急' }, required: false },
  { type: 'text', key: 'note', label: { enUS: 'Note', zhCN: '备注' }, required: false, maxLength: 500 },
];
const definition = { fields };

describe('request form values', () => {
  it('opens a new form with every switch off and nothing else filled', () => {
    expect(toFormValues(definition, {})).toEqual({ urgent: false });
  });

  it('reopens saved values exactly, keeping date-only strings untouched', () => {
    const saved = { startDate: '2026-03-02', days: 3, reason: 'Visit', urgent: true };
    expect(toFormValues(definition, saved)).toEqual(saved);
  });

  it('sends only filled values, so a cleared optional field is removed instead of stored empty', () => {
    expect(
      toRequestValues(definition, { startDate: '2026-03-02', days: 3, reason: 'Visit', urgent: false, note: '' }),
    ).toEqual({ startDate: '2026-03-02', days: 3, reason: 'Visit', urgent: false });
    expect(toRequestValues(definition, { startDate: null, days: undefined, reason: 'x' })).toEqual({ reason: 'x' });
    expect(toRequestValues(definition, { reason: 'x', note: '   ' })).toEqual({ reason: 'x' });
  });

  it('never sends, reopens or carries over an attachment field, whose files live outside the values', () => {
    const evidence: DefinitionField = {
      type: 'attachment',
      key: 'supportingDocument',
      label: { enUS: 'Supporting document', zhCN: '证明材料' },
      required: true,
      maxFiles: 2,
      maxBytes: 2048,
      accept: ['application/pdf'],
    };
    const withEvidence = { fields: [...fields, evidence] };
    const form = { reason: 'x', supportingDocument: 'scan.pdf' };
    expect(toRequestValues(withEvidence, form)).toEqual({ reason: 'x' });
    expect(toFormValues(withEvidence, form)).toEqual({ reason: 'x', urgent: false });
    expect(carryOverValues(withEvidence, form)).toEqual({ reason: 'x' });
  });

  it('drops keys the definition does not name', () => {
    expect(toRequestValues(definition, { reason: 'x', state: 'approved' })).toEqual({ reason: 'x' });
  });

  it('keeps typed values whose key and type survive in a newer version', () => {
    const newer = {
      fields: [
        fields[0],
        { type: 'text', key: 'days', label: { enUS: 'Days', zhCN: '天数' }, required: false, maxLength: 10 } as const,
        fields[2],
      ],
    };
    expect(carryOverValues(newer, { startDate: '2026-03-02', days: 3, reason: 'Visit', note: 'gone' })).toEqual({
      startDate: '2026-03-02',
      reason: 'Visit',
    });
  });

  it('fills nothing for keys named like built-in object properties', () => {
    const builtIns = {
      fields: [
        { type: 'text', key: 'toString', label: { enUS: 'A', zhCN: '甲' }, required: false, maxLength: 10 } as const,
        { type: 'boolean', key: 'valueOf', label: { enUS: 'B', zhCN: '乙' }, required: false } as const,
      ],
    };
    expect(toFormValues(builtIns, {})).toEqual({ valueOf: false });
    expect(toRequestValues(builtIns, {})).toEqual({});
    expect(carryOverValues(builtIns, {})).toEqual({});
  });

  it('titles a field column by its label and a system column by its own key', () => {
    const t = (key: string) => `t:${key}`;
    expect(columnTitle('days', fields[1], 'zh-CN', t)).toBe('天数');
    expect(columnTitle('requester', undefined, 'en-US', t)).toBe('t:builder.systemColumns.requester');
    expect(columnTitle('submittedAt', undefined, 'en-US', t)).toBe('t:builder.systemColumns.submittedAt');
  });

  it('turns a date range into filters on the configured rule’s start and end keys', () => {
    const ruled = { dateRules: [{ startKey: 'leaveFrom', endKey: 'leaveTo' }] };
    expect(dateRangeFilters(ruled, { from: '2026-05-01', to: '2026-05-31' })).toEqual([
      { field: 'leaveFrom', operator: '$gte', value: '2026-05-01' },
      { field: 'leaveTo', operator: '$lte', value: '2026-05-31' },
    ]);
    expect(dateRangeFilters(ruled, { from: '', to: '2026-05-31' })).toEqual([
      { field: 'leaveTo', operator: '$lte', value: '2026-05-31' },
    ]);
    expect(dateRangeFilters(ruled, {})).toEqual([]);
    expect(dateRangeFilters({ dateRules: [] }, { from: '2026-05-01' })).toEqual([]);
  });

  it('labels a field in the active language', () => {
    expect(fieldLabel(fields[0], 'zh-CN')).toBe('开始日期');
    expect(fieldLabel(fields[0], 'en-US')).toBe('Start date');
  });
});
