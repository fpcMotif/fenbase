import type { Id } from '../../convex/_generated/dataModel';
import {
  MAX_LABEL_LENGTH,
  type Definition,
  type DefinitionField,
  type DefinitionFieldType,
  type PolicyPreset,
} from '../../convex/definitionModel';

export type FieldRow = {
  key: string;
  type: DefinitionFieldType;
  labelEnUS: string;
  labelZhCN: string;
  required: boolean;
  maxLength?: number | null;
  min?: number | null;
  max?: number | null;
  integer?: boolean;
};

export type BuilderFormValues = {
  fields: FieldRow[];
  listColumns: string[];
  dateRuleStart?: string | null;
  dateRuleEnd?: string | null;
  policyPreset: PolicyPreset;
  reviewerMembershipId?: Id<'memberships'>;
};

export const newFieldRow: FieldRow = {
  key: '',
  type: 'text',
  labelEnUS: '',
  labelZhCN: '',
  required: false,
  maxLength: 500,
  min: 0,
  max: 100,
  integer: true,
};

export const emptyForm: BuilderFormValues = {
  fields: [newFieldRow],
  listColumns: [],
  dateRuleStart: null,
  dateRuleEnd: null,
  policyPreset: 'requesterAndAssignedReviewer',
  reviewerMembershipId: undefined,
};

export function toFormValues(definition: Definition): BuilderFormValues {
  const [rule] = definition.dateRules;
  return {
    fields: definition.fields.map((field) => ({
      ...newFieldRow,
      key: field.key,
      type: field.type,
      labelEnUS: field.label.enUS,
      labelZhCN: field.label.zhCN,
      required: field.required,
      ...(field.type === 'text' ? { maxLength: field.maxLength } : {}),
      ...(field.type === 'number' ? { min: field.min, max: field.max, integer: field.integer } : {}),
    })),
    listColumns: definition.listColumns,
    dateRuleStart: rule?.startKey ?? null,
    dateRuleEnd: rule?.endKey ?? null,
    policyPreset: definition.policyPreset,
    reviewerMembershipId: definition.reviewerMembershipId,
  };
}

function toField(row: FieldRow): DefinitionField {
  const base = {
    key: row.key.trim(),
    label: { enUS: row.labelEnUS.trim(), zhCN: row.labelZhCN.trim() },
    required: Boolean(row.required),
  };
  if (row.type === 'text') return { type: 'text', ...base, maxLength: row.maxLength ?? Number.NaN };
  if (row.type === 'number') {
    return {
      type: 'number',
      ...base,
      min: row.min ?? Number.NaN,
      max: row.max ?? Number.NaN,
      integer: Boolean(row.integer),
    };
  }
  return { type: row.type, ...base };
}

function isValidLabel(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH;
}

export function invalidLabelControl(row: FieldRow): 'labelEnUS' | 'labelZhCN' {
  return isValidLabel(row.labelEnUS) && !isValidLabel(row.labelZhCN) ? 'labelZhCN' : 'labelEnUS';
}

export function incompleteDateRuleControl(
  values: Pick<BuilderFormValues, 'dateRuleStart' | 'dateRuleEnd'>,
): 'dateRuleStart' | 'dateRuleEnd' | null {
  if (values.dateRuleStart && !values.dateRuleEnd) return 'dateRuleEnd';
  if (!values.dateRuleStart && values.dateRuleEnd) return 'dateRuleStart';
  return null;
}

export function toDefinition(values: BuilderFormValues, reviewerMembershipId: Id<'memberships'>): Definition {
  return {
    fields: values.fields.map(toField),
    listColumns: values.listColumns ?? [],
    dateRules:
      values.dateRuleStart && values.dateRuleEnd
        ? [{ startKey: values.dateRuleStart, endKey: values.dateRuleEnd }]
        : [],
    policyPreset: values.policyPreset,
    reviewerMembershipId,
  };
}
