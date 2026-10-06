import type { Definition, DefinitionField } from '../../convex/definitionModel';
import { ownValue, type RequestValue, type RequestValues } from '../../convex/requestValues';

export type RequestFormValues = Record<string, RequestValue | null | undefined>;

function hasFieldType(field: DefinitionField, value: unknown): value is RequestValue {
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
    if (value === null || value === undefined || value === '') continue;
    values[field.key] = value;
  }
  return values;
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
