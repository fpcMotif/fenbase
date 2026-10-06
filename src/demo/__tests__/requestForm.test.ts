import { describe, expect, it } from 'vitest';
import type { DefinitionField } from '../../../convex/definitionModel';
import { carryOverValues, fieldLabel, toFormValues, toRequestValues } from '../requestForm';

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

  it('labels a field in the active language', () => {
    expect(fieldLabel(fields[0], 'zh-CN')).toBe('开始日期');
    expect(fieldLabel(fields[0], 'en-US')).toBe('Start date');
  });
});
