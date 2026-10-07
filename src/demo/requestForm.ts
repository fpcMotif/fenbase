import type { Definition, DefinitionField } from '../../convex/definitionModel';
import type { RecordFilter } from '../../convex/recordQuery';
import { normalizeRequestValues, ownValue, type RequestValue, type RequestValues } from '../../convex/requestValues';

export type RequestFormValues = Record<string, RequestValue | null | undefined>;

function hasFieldType(field: DefinitionField, value: unknown): value is RequestValue {
  if (field.type === 'attachment') return false;
  if (field.type === 'number') return typeof value === 'number';
  if (field.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

export function toFormValues(definition: Pick<Definition, 'fields'>, values: RequestFormValues): RequestFormValues {
  const form: RequestFormValues = {};
  for (const field of definition.fields) {
    const value = ownValue(values, field.key);
    if (hasFieldType(field, value)) form[field.key] = value;
    else if (field.type === 'boolean') form[field.key] = false;
  }
  return form;
}

export function toRequestValues(definition: Pick<Definition, 'fields'>, form: RequestFormValues): RequestValues {
  const values: RequestValues = {};
  for (const field of definition.fields) {
    const value = ownValue(form, field.key);
    if (value === null || value === undefined || field.type === 'attachment') continue;
    values[field.key] = value;
  }
  return normalizeRequestValues(values);
}

export function carryOverValues(definition: Pick<Definition, 'fields'>, form: RequestFormValues): RequestFormValues {
  const kept: RequestFormValues = {};
  for (const field of definition.fields) {
    const value = ownValue(form, field.key);
    if (hasFieldType(field, value)) kept[field.key] = value;
  }
  return kept;
}

export function fieldLabel(field: DefinitionField, language: string): string {
  return language === 'zh-CN' ? field.label.zhCN : field.label.enUS;
}

export function columnTitle(
  key: string,
  field: DefinitionField | undefined,
  language: string,
  t: (key: string) => string,
): string {
  return field ? fieldLabel(field, language) : t(`builder.systemColumns.${key}`);
}

export type DateRange = { from?: string; to?: string };

// The list's date filter follows the configured date rule: requests starting on or after `from` and ending on or
// before `to`.
export function dateRangeFilters(definition: Pick<Definition, 'dateRules'>, range: DateRange): RecordFilter[] {
  const rule = definition.dateRules[0];
  if (!rule) return [];
  const filters: RecordFilter[] = [];
  if (range.from) filters.push({ field: rule.startKey, operator: '$gte', value: range.from });
  if (range.to) filters.push({ field: rule.endKey, operator: '$lte', value: range.to });
  return filters;
}
