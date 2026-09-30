import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export type DemoField = Doc<'demoCollections'>['fields'][number];
export type DemoValue = string | number | boolean;

type DemoContext = MutationCtx | QueryCtx;

const fieldNamePattern = /^[a-z][a-z0-9_]{0,62}$/;
const maxFieldCount = 30;
const maxTextLength = 4000;

export function validateCollectionFields(fields: readonly DemoField[]): void {
  if (fields.length === 0 || fields.length > maxFieldCount) {
    throw new Error(`A collection must have between 1 and ${maxFieldCount} fields`);
  }

  const names = new Set<string>();
  for (const field of fields) {
    if (!fieldNamePattern.test(field.name)) {
      throw new Error(`Invalid field name: ${field.name}`);
    }
    if (names.has(field.name)) {
      throw new Error(`Duplicate field name: ${field.name}`);
    }
    names.add(field.name);
  }
}

export function assertFieldValue(fields: readonly DemoField[], fieldName: string, value: DemoValue): DemoField {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`Unknown field: ${fieldName}`);
  }

  const matchesType =
    (field.type === 'text' && typeof value === 'string') ||
    (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (field.type === 'boolean' && typeof value === 'boolean');
  if (!matchesType) {
    throw new Error(`Value does not match the ${field.type} field: ${fieldName}`);
  }
  if (field.type === 'text' && typeof value === 'string' && value.length > maxTextLength) {
    throw new Error(`Text value is too long for field: ${fieldName}`);
  }

  return field;
}

export function validateRecordValues(fields: readonly DemoField[], values: Record<string, DemoValue>): void {
  for (const [fieldName, value] of Object.entries(values)) {
    assertFieldValue(fields, fieldName, value);
  }

  for (const field of fields) {
    if (!field.required) continue;
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) {
      throw new Error(`Required field is missing: ${field.name}`);
    }
    if (field.type === 'text') {
      const value = values[field.name];
      if (typeof value === 'string' && !value.trim()) {
        throw new Error(`Required field is empty: ${field.name}`);
      }
    }
  }
}

export async function requireOwnedCollection(
  ctx: DemoContext,
  ownerId: string,
  collectionId: Id<'demoCollections'>,
): Promise<Doc<'demoCollections'>> {
  const collection = await ctx.db.get(collectionId);
  if (!collection || collection.ownerId !== ownerId) {
    throw new Error('Collection not found');
  }
  return collection;
}

export async function requireOwnedRecord(
  ctx: DemoContext,
  ownerId: string,
  recordId: Id<'demoRecords'>,
): Promise<Doc<'demoRecords'>> {
  const record = await ctx.db.get(recordId);
  if (!record || record.ownerId !== ownerId) {
    throw new Error('Record not found');
  }
  return record;
}
