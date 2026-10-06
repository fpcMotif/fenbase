import { ConvexError } from 'convex/values';
import { maxTextLength, type DemoField, type DemoValue } from './demoValidation';
import { isCalendarDate } from './requestValues';

// Filtering, sorting, and pagination for one collection's records. Shared by the `records.browse` query (authoritative)
// and the demo client (early validation), so it must stay free of server-only imports.

export type RecordQueryValue = DemoValue;
export type RecordQueryField = { name: DemoField['name']; type: DemoField['type'] | 'date' };

export type RecordFilter = {
  field: string;
  operator: string;
  value?: RecordQueryValue;
};

export type RecordSort = {
  field: string;
  direction: string;
};

export interface RecordQuery {
  filters?: readonly RecordFilter[];
  sort?: RecordSort;
  page?: number;
  pageSize?: number;
}

export interface BrowsableRecord {
  _id: string;
  _creationTime: number;
  values: Record<string, RecordQueryValue>;
}

export interface RecordPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const DEFAULT_RECORD_PAGE_SIZE = 20;
export const MAX_RECORD_PAGE_SIZE = 100;
export const MAX_RECORD_FILTERS = 10;
// Records are filtered and sorted in memory because Convex cannot index the dynamic field names inside `values`. The
// cap bounds the records read per browse; Convex's per-function read limit still applies to very wide or text-heavy
// collections, and exceeding it fails the query rather than truncating the results.
export const MAX_RECORDS_PER_COLLECTION = 1000;
// Sort key for the record's creation time; field names cannot start with an underscore, so it never collides with a
// collection field.
export const RECORD_CREATED_SORT_FIELD = '_creationTime';

// The bounded NocoBase operator set this journey supports for each primitive field type. Every filter is combined with
// AND.
export const RECORD_FILTER_OPERATORS = {
  text: ['$includes', '$notIncludes', '$eq', '$ne', '$empty', '$notEmpty'],
  number: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$empty', '$notEmpty'],
  boolean: ['$isTruly', '$isFalsy'],
  date: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$empty', '$notEmpty'],
} as const satisfies Record<RecordQueryField['type'], readonly string[]>;

const operatorsWithoutValue = new Set(['$empty', '$notEmpty', '$isTruly', '$isFalsy']);

export function filterTakesValue(operator: string): boolean {
  return !operatorsWithoutValue.has(operator);
}

function reject(code: string, message: string, field?: string): never {
  throw new ConvexError(field === undefined ? { code, message } : { code, field, message });
}

function requireField(fields: readonly RecordQueryField[], name: string): RecordQueryField {
  return (
    fields.find((field) => field.name === name) ?? reject('RECORD_QUERY_FIELD_UNKNOWN', `Unknown field: ${name}`, name)
  );
}

function validateFilter(fields: readonly RecordQueryField[], filter: RecordFilter): void {
  const field = requireField(fields, filter.field);
  const operators: readonly string[] = RECORD_FILTER_OPERATORS[field.type];
  if (!operators.includes(filter.operator)) {
    reject('RECORD_QUERY_OPERATOR_INVALID', `Unsupported operator for ${field.name}: ${filter.operator}`, field.name);
  }
  const { value } = filter;
  const validValue = !filterTakesValue(filter.operator)
    ? value === undefined
    : field.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'date'
        ? typeof value === 'string' && isCalendarDate(value)
        : typeof value === 'string' &&
          value.length <= maxTextLength &&
          (value !== '' || (filter.operator !== '$includes' && filter.operator !== '$notIncludes'));
  if (!validValue) reject('RECORD_QUERY_VALUE_INVALID', `Invalid filter value for ${field.name}`, field.name);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

// Throws a coded ConvexError for the first problem found, so the client can show a translated message.
export function validateRecordQuery(fields: readonly RecordQueryField[], query: RecordQuery): void {
  const filters = query.filters ?? [];
  if (filters.length > MAX_RECORD_FILTERS) {
    reject('RECORD_QUERY_FILTER_COUNT_INVALID', `Use at most ${MAX_RECORD_FILTERS} filters`);
  }
  for (const filter of filters) validateFilter(fields, filter);
  if (query.sort) {
    if (query.sort.field !== RECORD_CREATED_SORT_FIELD) requireField(fields, query.sort.field);
    if (query.sort.direction !== 'asc' && query.sort.direction !== 'desc') {
      reject('RECORD_QUERY_SORT_INVALID', 'Sort direction must be asc or desc');
    }
  }
  const { page = 1, pageSize = DEFAULT_RECORD_PAGE_SIZE } = query;
  if (!isPositiveInteger(page) || !isPositiveInteger(pageSize) || pageSize > MAX_RECORD_PAGE_SIZE) {
    reject(
      'RECORD_QUERY_PAGE_INVALID',
      `Page must be a positive integer and page size an integer from 1 to ${MAX_RECORD_PAGE_SIZE}`,
    );
  }
}

function isEmpty(value: RecordQueryValue | undefined): boolean {
  return value === undefined || value === '';
}

// Mirrors the NocoBase operators of the same names: `$ne` keeps records without a value, `$includes`/`$notIncludes`
// ignore letter case and skip records without a value, and an empty text value counts as empty.
function matches(record: BrowsableRecord, filter: RecordFilter): boolean {
  const actual = record.values[filter.field];
  const expected = filter.value;
  switch (filter.operator) {
    case '$eq':
      return actual === expected;
    case '$ne':
      return actual !== expected;
    case '$empty':
      return isEmpty(actual);
    case '$notEmpty':
      return !isEmpty(actual);
    case '$includes':
    case '$notIncludes': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      const includes = actual.toLowerCase().includes(expected.toLowerCase());
      return filter.operator === '$includes' ? includes : !includes;
    }
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      // Numbers compare numerically; date-only values compare as YYYY-MM-DD strings, which is calendar order.
      const comparable =
        (typeof actual === 'number' && typeof expected === 'number') ||
        (typeof actual === 'string' && typeof expected === 'string');
      if (!comparable) return false;
      if (filter.operator === '$gt') return actual > expected;
      if (filter.operator === '$gte') return actual >= expected;
      if (filter.operator === '$lt') return actual < expected;
      return actual <= expected;
    }
    case '$isTruly':
      return actual === true;
    case '$isFalsy':
      return actual !== true;
    default:
      return false;
  }
}

function compareValues(left: RecordQueryValue | undefined, right: RecordQueryValue | undefined): number {
  if (left === right) return 0;
  // A missing value sorts as the largest value, like NULL in PostgreSQL: last when ascending, first when descending.
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  // Text compares by lower-cased code units, not locale collation, so the order is identical in every runtime.
  if (typeof left === 'string' && typeof right === 'string' && left.toLowerCase() !== right.toLowerCase()) {
    return left.toLowerCase() < right.toLowerCase() ? -1 : 1;
  }
  return left < right ? -1 : 1;
}

function sortValue(record: BrowsableRecord, field: string): RecordQueryValue | undefined {
  return field === RECORD_CREATED_SORT_FIELD ? record._creationTime : record.values[field];
}

// Ties fall back to newest first, then to the record id, so every page boundary is stable.
function compareRecords(left: BrowsableRecord, right: BrowsableRecord, sort: RecordSort | undefined): number {
  if (sort) {
    const order = compareValues(sortValue(left, sort.field), sortValue(right, sort.field));
    if (order !== 0) return sort.direction === 'desc' ? -order : order;
  }
  if (left._creationTime !== right._creationTime) return right._creationTime - left._creationTime;
  return left._id < right._id ? 1 : left._id > right._id ? -1 : 0;
}

export function queryRecords<T extends BrowsableRecord>(
  records: readonly T[],
  fields: readonly RecordQueryField[],
  query: RecordQuery,
): RecordPage<T> {
  validateRecordQuery(fields, query);
  const filters = query.filters ?? [];
  const pageSize = query.pageSize ?? DEFAULT_RECORD_PAGE_SIZE;
  const matching = records
    .filter((record) => filters.every((filter) => matches(record, filter)))
    .sort((left, right) => compareRecords(left, right, query.sort));
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(query.page ?? 1, pageCount);
  return {
    items: matching.slice((page - 1) * pageSize, page * pageSize),
    total: matching.length,
    page,
    pageSize,
    pageCount,
  };
}
