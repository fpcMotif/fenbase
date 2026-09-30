import { describe, expect, it } from 'vitest';
import { assertFieldValue, validateCollectionFields, validateRecordValues, type DemoField } from '../demoValidation';

const fields: DemoField[] = [
  { name: 'title', type: 'text', required: true },
  { name: 'count', type: 'number' },
  { name: 'active', type: 'boolean' },
];

describe('demo collection and record validation', () => {
  it('accepts unique field definitions and correctly typed values', () => {
    expect(() => validateCollectionFields(fields)).not.toThrow();
    expect(assertFieldValue(fields, 'active', false)).toEqual(fields[2]);
    expect(() => validateRecordValues(fields, { title: 'Lead', count: 2, active: true })).not.toThrow();
  });

  it('rejects empty, duplicate, or malformed field definitions', () => {
    expect(() => validateCollectionFields([])).toThrow(/between 1 and 30/);
    expect(() => validateCollectionFields([fields[0], fields[0]])).toThrow(/Duplicate field name/);
    expect(() => validateCollectionFields([{ name: 'Bad name', type: 'text' }])).toThrow(/Invalid field name/);
  });

  it('rejects unknown fields and values that do not match their field type', () => {
    expect(() => assertFieldValue(fields, 'missing', 'x')).toThrow(/Unknown field/);
    expect(() => assertFieldValue(fields, 'count', '2')).toThrow(/does not match/);
    expect(() => validateRecordValues(fields, { title: 'Lead', extra: true })).toThrow(/Unknown field/);
  });

  it('requires required values and rejects blank required text', () => {
    expect(() => validateRecordValues(fields, { count: 1 })).toThrow(/Required field is missing/);
    expect(() => validateRecordValues(fields, { title: '  ' })).toThrow(/Required field is empty/);
  });

  it('rejects non-finite numbers and oversized text values', () => {
    expect(() => assertFieldValue(fields, 'count', Number.NaN)).toThrow(/does not match/);
    expect(() => assertFieldValue(fields, 'title', 'x'.repeat(4001))).toThrow(/too long/);
  });
});
