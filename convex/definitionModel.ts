import { v, type Infer } from 'convex/values';

// The application definition contract. Shared by the Convex schema, the definition functions and the demo builder, so
// it must stay free of server-only imports.

export const MAX_DEFINITION_FIELDS = 30;
export const MAX_LIST_COLUMNS = 10;
export const MAX_DATE_RULES = 1;
export const MAX_LABEL_LENGTH = 120;
export const MAX_TEXT_FIELD_LENGTH = 4000;
export const FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,62}$/;
export const RESERVED_FIELD_KEYS: readonly string[] = [
  'requester',
  'requesterMembershipId',
  'status',
  'state',
  'reviewer',
  'reviewerMembershipId',
  'version',
  'versionId',
  'createdAt',
  'updatedAt',
  'id',
];

export const SYSTEM_LIST_COLUMNS = ['requester'] as const;

export const DEFINITION_FIELD_TYPES = ['text', 'number', 'boolean', 'date'] as const;
export const POLICY_PRESETS = ['requesterAndAssignedReviewer', 'requesterAssignedReviewerAndReaders'] as const;

export const DEFINITION_ERROR_CODES = [
  'DEFINITION_NOT_FOUND',
  'DEFINITION_REVISION_CONFLICT',
  'DEFINITION_NOTHING_TO_PUBLISH',
  'DEFINITION_VERSION_NOT_FOUND',
  'DEFINITION_FIELD_TYPE_UNKNOWN',
  'DEFINITION_FIELD_KEY_INVALID',
  'DEFINITION_FIELD_KEY_DUPLICATE',
  'DEFINITION_FIELD_KEY_RESERVED',
  'DEFINITION_FIELD_COUNT_INVALID',
  'DEFINITION_FIELD_LABEL_INVALID',
  'DEFINITION_FIELD_BOUNDS_INVALID',
  'DEFINITION_FIELD_REMOVED',
  'DEFINITION_FIELD_TYPE_CHANGED',
  'DEFINITION_LIST_COLUMNS_INVALID',
  'DEFINITION_DATE_RULE_INVALID',
  'DEFINITION_POLICY_INVALID',
  'DEFINITION_REVIEWER_INVALID',
] as const;

export type DefinitionErrorCode = (typeof DEFINITION_ERROR_CODES)[number];

export const fieldLabelValidator = v.object({ enUS: v.string(), zhCN: v.string() });

const fieldBase = { key: v.string(), label: fieldLabelValidator, required: v.boolean() };

export const definitionFieldValidator = v.union(
  v.object({ type: v.literal('text'), ...fieldBase, maxLength: v.number() }),
  v.object({ type: v.literal('number'), ...fieldBase, min: v.number(), max: v.number(), integer: v.boolean() }),
  v.object({ type: v.literal('boolean'), ...fieldBase }),
  v.object({ type: v.literal('date'), ...fieldBase }),
);

export const policyPresetValidator = v.union(
  v.literal('requesterAndAssignedReviewer'),
  v.literal('requesterAssignedReviewerAndReaders'),
);

export const dateRuleValidator = v.object({ startKey: v.string(), endKey: v.string() });

export const definitionValidator = v.object({
  fields: v.array(definitionFieldValidator),
  listColumns: v.array(v.string()),
  dateRules: v.array(dateRuleValidator),
  policyPreset: policyPresetValidator,
  reviewerMembershipId: v.id('memberships'),
});

export const publishedKeyValidator = v.object({
  key: v.string(),
  type: v.union(v.literal('text'), v.literal('number'), v.literal('boolean'), v.literal('date')),
});

export type Definition = Infer<typeof definitionValidator>;
export type DefinitionField = Infer<typeof definitionFieldValidator>;
export type DefinitionFieldType = DefinitionField['type'];
export type PolicyPreset = Infer<typeof policyPresetValidator>;
export type PublishedKey = Infer<typeof publishedKeyValidator>;
export type DefinitionIssue = { code: DefinitionErrorCode; field?: string };

function isFieldType(type: unknown): type is DefinitionFieldType {
  return DEFINITION_FIELD_TYPES.some((known) => known === type);
}

function validLabel(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH;
}

function validBounds(field: DefinitionField): boolean {
  if (field.type === 'text') {
    return Number.isInteger(field.maxLength) && field.maxLength >= 1 && field.maxLength <= MAX_TEXT_FIELD_LENGTH;
  }
  if (field.type === 'number') {
    if (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max) return false;
    return !field.integer || (Number.isInteger(field.min) && Number.isInteger(field.max));
  }
  return true;
}

export function validateDefinition(
  definition: Definition,
  publishedKeys: readonly PublishedKey[],
): DefinitionIssue | null {
  const { fields } = definition;
  if (fields.length < 1 || fields.length > MAX_DEFINITION_FIELDS) return { code: 'DEFINITION_FIELD_COUNT_INVALID' };

  const types = new Map<string, DefinitionFieldType>();
  for (const field of fields) {
    if (!isFieldType(field.type)) return { code: 'DEFINITION_FIELD_TYPE_UNKNOWN', field: field.key };
    if (!FIELD_KEY_PATTERN.test(field.key)) return { code: 'DEFINITION_FIELD_KEY_INVALID', field: field.key };
    if (RESERVED_FIELD_KEYS.includes(field.key)) return { code: 'DEFINITION_FIELD_KEY_RESERVED', field: field.key };
    if (types.has(field.key)) return { code: 'DEFINITION_FIELD_KEY_DUPLICATE', field: field.key };
    if (!validLabel(field.label.enUS) || !validLabel(field.label.zhCN)) {
      return { code: 'DEFINITION_FIELD_LABEL_INVALID', field: field.key };
    }
    if (!validBounds(field)) return { code: 'DEFINITION_FIELD_BOUNDS_INVALID', field: field.key };
    types.set(field.key, field.type);
  }

  for (const published of publishedKeys) {
    const type = types.get(published.key);
    if (type === undefined) return { code: 'DEFINITION_FIELD_REMOVED', field: published.key };
    if (type !== published.type) return { code: 'DEFINITION_FIELD_TYPE_CHANGED', field: published.key };
  }

  const { listColumns } = definition;
  if (listColumns.length < 1 || listColumns.length > MAX_LIST_COLUMNS)
    return { code: 'DEFINITION_LIST_COLUMNS_INVALID' };
  const seenColumns = new Set<string>();
  for (const column of listColumns) {
    const known = types.has(column) || SYSTEM_LIST_COLUMNS.some((system) => system === column);
    if (!known || seenColumns.has(column)) return { code: 'DEFINITION_LIST_COLUMNS_INVALID', field: column };
    seenColumns.add(column);
  }

  if (definition.dateRules.length > MAX_DATE_RULES) return { code: 'DEFINITION_DATE_RULE_INVALID' };
  for (const rule of definition.dateRules) {
    for (const key of [rule.startKey, rule.endKey]) {
      if (types.get(key) !== 'date') return { code: 'DEFINITION_DATE_RULE_INVALID', field: key };
    }
    if (rule.startKey === rule.endKey) return { code: 'DEFINITION_DATE_RULE_INVALID', field: rule.endKey };
  }

  if (!POLICY_PRESETS.some((preset) => preset === definition.policyPreset))
    return { code: 'DEFINITION_POLICY_INVALID' };
  return null;
}

export function withTrimmedLabels(definition: Definition): Definition {
  return {
    ...definition,
    fields: definition.fields.map((field) => ({
      ...field,
      label: { enUS: field.label.enUS.trim(), zhCN: field.label.zhCN.trim() },
    })),
  };
}

export function publishedKeysOf(definition: Definition | null): PublishedKey[] {
  if (definition === null) return [];
  return definition.fields.map(({ key, type }) => ({ key, type }));
}
