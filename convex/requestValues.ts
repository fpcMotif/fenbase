import { v, type Infer } from 'convex/values';
import { RESERVED_FIELD_KEYS, canonicalJson, type Definition } from './definitionModel';

// Request value rules derived from a pinned published definition. Shared by the `requests` functions (authoritative)
// and the demo client (early validation), so it must stay free of server-only imports.

export const MAX_REQUEST_VALUES_BYTES = 8192;
export const MAX_REQUESTS_PER_APPLICATION = 1000;
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const REQUEST_ERROR_CODES = [
  'RECORD_FIELD_SERVER_OWNED',
  'RECORD_FIELD_UNKNOWN',
  'RECORD_FIELD_REQUIRED',
  'RECORD_FIELD_TYPE_INVALID',
  'RECORD_TEXT_TOO_LONG',
  'RECORD_NUMBER_OUT_OF_RANGE',
  'RECORD_NUMBER_NOT_INTEGER',
  'RECORD_DATE_INVALID',
  'RECORD_DATE_RANGE_INVALID',
  'RECORD_TOO_LARGE',
  'RECORD_NOT_FOUND',
  'RECORD_REVISION_CONFLICT',
  'RECORD_OPERATION_CONFLICT',
  'RECORD_OPERATION_ID_INVALID',
  'RECORD_APPLICATION_FULL',
  'RECORD_DEFINITION_OUTDATED',
  'RECORD_BROWSE_LIMIT_EXCEEDED',
  'REQUEST_STATE_CONFLICT',
  'REQUEST_REVIEWER_UNAVAILABLE',
  'REQUEST_SELF_REVIEW',
] as const;

export const requestStateValidator = v.union(
  v.literal('draft'),
  v.literal('pending'),
  v.literal('approved'),
  v.literal('rejected'),
  v.literal('withdrawn'),
);
export type RequestState = Infer<typeof requestStateValidator>;

export function isRequestState(value: unknown): value is RequestState {
  return requestStateValidator.members.some((member) => member.value === value);
}

export const reviewCommandValidator = v.union(
  v.literal('submit'),
  v.literal('approve'),
  v.literal('reject'),
  v.literal('withdraw'),
);
export type ReviewCommand = Infer<typeof reviewCommandValidator>;

export const reviewTaskStatusValidator = v.union(v.literal('pending'), v.literal('completed'), v.literal('cancelled'));

export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[number];

export function isRequestErrorCode(code: string): code is RequestErrorCode {
  return REQUEST_ERROR_CODES.some((known) => known === code);
}

export const requestValueValidator = v.union(v.string(), v.number(), v.boolean());
export const requestValuesValidator = v.record(v.string(), requestValueValidator);

export type RequestValue = Infer<typeof requestValueValidator>;
export type RequestValues = Infer<typeof requestValuesValidator>;
export type RequestIssue = {
  code: RequestErrorCode;
  field?: string;
  min?: number;
  max?: number;
  maxLength?: number;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// A date-only value is a real Gregorian day written as YYYY-MM-DD. It is checked by arithmetic, never through `Date`,
// so no time zone can shift it.
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function requestValuesBytes(values: Record<string, unknown>): number {
  return new TextEncoder().encode(canonicalJson(values)).length;
}

// Field keys may be named like built-in object properties (`toString`, `constructor`), so a plain lookup would return
// the inherited function for a value the record does not hold.
export function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function isBlank(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

// The stored form of caller values: blank text is absent, as the demo form sends it, and -0 is 0, because canonical
// JSON cannot tell them apart.
export function normalizeRequestValues(values: RequestValues): RequestValues {
  const normalized: RequestValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (isBlank(value)) continue;
    normalized[key] = Object.is(value, -0) ? 0 : value;
  }
  return normalized;
}

// Returns the first issue in a fixed order: server-owned keys, unknown keys, each field in definition order, the date
// rules, then the size budget.
export function validateRequestValues(
  definition: Pick<Definition, 'fields' | 'dateRules'>,
  values: Record<string, unknown>,
): RequestIssue | null {
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  const serverOwned = keys.find((key) => RESERVED_FIELD_KEYS.includes(key));
  if (serverOwned !== undefined) return { code: 'RECORD_FIELD_SERVER_OWNED', field: serverOwned };
  const known = new Set(definition.fields.map((field) => field.key));
  const unknown = keys.find((key) => !known.has(key));
  if (unknown !== undefined) return { code: 'RECORD_FIELD_UNKNOWN', field: unknown };

  for (const field of definition.fields) {
    const value = ownValue(values, field.key);
    if (isBlank(value)) {
      if (field.required) return { code: 'RECORD_FIELD_REQUIRED', field: field.key };
      continue;
    }
    const typed =
      field.type === 'text' || field.type === 'date'
        ? typeof value === 'string'
        : field.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean';
    if (!typed) return { code: 'RECORD_FIELD_TYPE_INVALID', field: field.key };
    if (field.type === 'text' && typeof value === 'string' && value.length > field.maxLength) {
      return { code: 'RECORD_TEXT_TOO_LONG', field: field.key, maxLength: field.maxLength };
    }
    if (field.type === 'number' && typeof value === 'number') {
      if (field.integer && !Number.isInteger(value)) return { code: 'RECORD_NUMBER_NOT_INTEGER', field: field.key };
      if (value < field.min || value > field.max) {
        return { code: 'RECORD_NUMBER_OUT_OF_RANGE', field: field.key, min: field.min, max: field.max };
      }
    }
    if (field.type === 'date' && typeof value === 'string' && !isCalendarDate(value)) {
      return { code: 'RECORD_DATE_INVALID', field: field.key };
    }
  }

  for (const rule of definition.dateRules) {
    const start = ownValue(values, rule.startKey);
    const end = ownValue(values, rule.endKey);
    // YYYY-MM-DD strings sort in calendar order, so a string comparison is a date comparison.
    if (typeof start === 'string' && typeof end === 'string' && !isBlank(start) && !isBlank(end) && end < start) {
      return { code: 'RECORD_DATE_RANGE_INVALID', field: rule.endKey };
    }
  }

  if (requestValuesBytes(values) > MAX_REQUEST_VALUES_BYTES) return { code: 'RECORD_TOO_LARGE' };
  return null;
}
