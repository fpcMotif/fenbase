import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  emptyForm,
  invalidLabelControl,
  incompleteDateRuleControl,
  toDefinition,
  type FieldRow,
} from '../definitionForm';
import { runPendingAction } from '../pendingAction';

const REVIEWER = 'memberships:b' as Id<'memberships'>;

const noteRow: FieldRow = {
  key: 'note',
  type: 'text',
  labelEnUS: 'Note',
  labelZhCN: '备注',
  required: false,
  maxLength: 500,
};

describe('builder form to definition', () => {
  it('sends labels without surrounding whitespace', () => {
    const definition = toDefinition(
      { ...emptyForm, fields: [{ ...noteRow, labelEnUS: '  Note ', labelZhCN: '\t备注 ' }], listColumns: ['note'] },
      REVIEWER,
    );
    expect(definition.fields[0].label).toEqual({ enUS: 'Note', zhCN: '备注' });
  });

  it('keeps the system requester column in the list layout', () => {
    const definition = toDefinition({ ...emptyForm, fields: [noteRow], listColumns: ['requester', 'note'] }, REVIEWER);
    expect(definition.listColumns).toEqual(['requester', 'note']);
  });
});

describe('label error placement', () => {
  it('marks the Chinese label when only the Chinese label is invalid', () => {
    expect(invalidLabelControl({ ...noteRow, labelZhCN: '  ' })).toBe('labelZhCN');
    expect(invalidLabelControl({ ...noteRow, labelZhCN: '备'.repeat(121) })).toBe('labelZhCN');
  });

  it('marks the English label when it is invalid or when neither label explains the error', () => {
    expect(invalidLabelControl({ ...noteRow, labelEnUS: '' })).toBe('labelEnUS');
    expect(invalidLabelControl({ ...noteRow, labelEnUS: '', labelZhCN: '' })).toBe('labelEnUS');
    expect(invalidLabelControl(noteRow)).toBe('labelEnUS');
  });
});

describe('date rule pair', () => {
  it('asks for an end date when only the start date is chosen, and the reverse', () => {
    expect(incompleteDateRuleControl({ dateRuleStart: 'startDate', dateRuleEnd: null })).toBe('dateRuleEnd');
    expect(incompleteDateRuleControl({ dateRuleStart: undefined, dateRuleEnd: 'endDate' })).toBe('dateRuleStart');
  });

  it('accepts both or neither', () => {
    expect(incompleteDateRuleControl({ dateRuleStart: 'startDate', dateRuleEnd: 'endDate' })).toBeNull();
    expect(incompleteDateRuleControl({ dateRuleStart: null, dateRuleEnd: null })).toBeNull();
  });
});

describe('pending builder actions', () => {
  it('clears the pending state before the success toast is shown', async () => {
    const pending: boolean[] = [];
    const outcome = await runPendingAction(
      (value) => pending.push(value),
      async () => 'saved',
    ).then((result) => ({ result, pendingWhenShown: pending.at(-1) }));
    expect(outcome).toEqual({ result: 'saved', pendingWhenShown: false });
    expect(pending).toEqual([true, false]);
  });

  it('clears the pending state and passes the error to the single error handler', async () => {
    const pending: boolean[] = [];
    const failure = new Error('rejected');
    const outcome = await runPendingAction(
      (value) => pending.push(value),
      async () => {
        throw failure;
      },
    ).then(
      () => 'resolved',
      (error: unknown) => ({ error, pendingWhenHandled: pending.at(-1) }),
    );
    expect(outcome).toEqual({ error: failure, pendingWhenHandled: false });
    expect(pending).toEqual([true, false]);
  });
});
