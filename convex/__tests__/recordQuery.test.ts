import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { queryRecords, type RecordQuery } from '../recordQuery';

const fields = [
  { name: 'company', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'qualified', type: 'boolean' },
] as const;

function record(id: string, createdAt: number, values: Record<string, string | number | boolean>) {
  return { _id: id, _creationTime: createdAt, values };
}

const records = [
  record('r1', 1, { company: 'Aster Labs', amount: 1200, qualified: false }),
  record('r2', 2, { company: 'Cedar Studio', amount: 3400, qualified: true }),
  record('r3', 3, { company: 'orchid works', amount: 2100 }),
  record('r4', 4, { company: '', qualified: true }),
  record('r5', 5, { amount: 3400, qualified: false }),
];

const ids = (page: { items: Array<{ _id: string }> }) => page.items.map((item) => item._id);

describe('browsing collection records', () => {
  it('keeps text records containing the value regardless of letter case, newest first by default', () => {
    const page = queryRecords(records, fields, { filters: [{ field: 'company', operator: '$includes', value: 'OR' }] });
    expect(ids(page)).toEqual(['r3']);
    expect(page).toMatchObject({ total: 1, page: 1, pageCount: 1 });
  });

  it.each([
    ['$notIncludes', 'or', ['r4', 'r2', 'r1']],
    ['$eq', 'Aster Labs', ['r1']],
    ['$eq', 'aster labs', []],
    ['$ne', 'Aster Labs', ['r5', 'r4', 'r3', 'r2']],
    ['$empty', undefined, ['r5', 'r4']],
    ['$notEmpty', undefined, ['r3', 'r2', 'r1']],
  ])('applies text operator %s %s', (operator, value, expected) => {
    const page = queryRecords(records, fields, { filters: [{ field: 'company', operator, value }] });
    expect(ids(page)).toEqual(expected);
  });

  it.each([
    ['$eq', 3400, ['r5', 'r2']],
    ['$ne', 3400, ['r4', 'r3', 'r1']],
    ['$gt', 2100, ['r5', 'r2']],
    ['$gte', 2100, ['r5', 'r3', 'r2']],
    ['$lt', 2100, ['r1']],
    ['$lte', 2100, ['r3', 'r1']],
    ['$empty', undefined, ['r4']],
    ['$notEmpty', undefined, ['r5', 'r3', 'r2', 'r1']],
  ])('applies number operator %s %s', (operator, value, expected) => {
    const page = queryRecords(records, fields, { filters: [{ field: 'amount', operator, value }] });
    expect(ids(page)).toEqual(expected);
  });

  it.each([
    ['$isTruly', ['r4', 'r2']],
    ['$isFalsy', ['r5', 'r3', 'r1']],
  ])('applies boolean operator %s, treating a missing value as no', (operator, expected) => {
    const page = queryRecords(records, fields, { filters: [{ field: 'qualified', operator }] });
    expect(ids(page)).toEqual(expected);
  });

  it.each([
    ['asc', ['r1', 'r3', 'r5', 'r2', 'r4']],
    ['desc', ['r4', 'r5', 'r2', 'r3', 'r1']],
  ])('sorts numbers %s, placing missing values as the largest and ties newest first', (direction, expected) => {
    const page = queryRecords(records, fields, { sort: { field: 'amount', direction } });
    expect(ids(page)).toEqual(expected);
  });

  it('sorts text ignoring letter case, then by exact text', () => {
    const named = [
      record('a', 1, { company: 'beta' }),
      record('b', 2, { company: 'alpha' }),
      record('c', 3, { company: 'Alpha' }),
    ];
    const page = queryRecords(named, fields, { sort: { field: 'company', direction: 'asc' } });
    expect(ids(page)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by creation time when asked', () => {
    const page = queryRecords(records, fields, { sort: { field: '_creationTime', direction: 'asc' } });
    expect(ids(page)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('combines every filter with the sort', () => {
    const page = queryRecords(records, fields, {
      filters: [
        { field: 'qualified', operator: '$isFalsy' },
        { field: 'amount', operator: '$notEmpty' },
      ],
      sort: { field: 'amount', direction: 'asc' },
    });
    expect(ids(page)).toEqual(['r1', 'r3', 'r5']);
  });

  describe('pages', () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      record(`p${String(index + 1).padStart(2, '0')}`, index + 1, { company: 'Same', amount: index % 2 }),
    );

    it('splits results into pages that together hold every match exactly once', () => {
      const pages = [1, 2, 3].map((page) =>
        queryRecords(many, fields, { sort: { field: 'company', direction: 'asc' }, page, pageSize: 10 }),
      );
      expect(pages.map((page) => page.items.length)).toEqual([10, 10, 5]);
      expect(pages[0]).toMatchObject({ total: 25, pageCount: 3, pageSize: 10 });
      expect(ids(pages[0]).slice(0, 2)).toEqual(['p25', 'p24']);
      expect(ids(pages[2])).toEqual(['p05', 'p04', 'p03', 'p02', 'p01']);
      expect(new Set(pages.flatMap(ids)).size).toBe(25);
    });

    it('moves a page past the end back to the last page', () => {
      const page = queryRecords(many, fields, { page: 9, pageSize: 10 });
      expect(page.page).toBe(3);
      expect(ids(page)).toEqual(['p05', 'p04', 'p03', 'p02', 'p01']);
    });

    it('reports one empty page when nothing matches', () => {
      const page = queryRecords(many, fields, { filters: [{ field: 'amount', operator: '$gt', value: 5 }], page: 2 });
      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20, pageCount: 1 });
    });
  });

  describe('rejected queries', () => {
    function rejection(query: RecordQuery): unknown {
      try {
        queryRecords(records, fields, query);
      } catch (error) {
        return error instanceof ConvexError ? error.data : error;
      }
      throw new Error('Expected the query to be rejected');
    }

    it.each<[string, RecordQuery, Record<string, string>]>([
      [
        'an unknown filter field',
        { filters: [{ field: 'owner', operator: '$eq', value: 'x' }] },
        { code: 'RECORD_QUERY_FIELD_UNKNOWN', field: 'owner' },
      ],
      [
        'an operator from another field type',
        { filters: [{ field: 'company', operator: '$gt', value: 'a' }] },
        { code: 'RECORD_QUERY_OPERATOR_INVALID', field: 'company' },
      ],
      [
        'an unsupported operator',
        { filters: [{ field: 'amount', operator: '$like', value: 1 }] },
        { code: 'RECORD_QUERY_OPERATOR_INVALID', field: 'amount' },
      ],
      [
        'a value of the wrong type',
        { filters: [{ field: 'amount', operator: '$gt', value: '5' }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'amount' },
      ],
      [
        'a missing value',
        { filters: [{ field: 'company', operator: '$eq' }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'company' },
      ],
      [
        'a value the operator does not take',
        { filters: [{ field: 'company', operator: '$empty', value: 'x' }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'company' },
      ],
      [
        'an empty contains value',
        { filters: [{ field: 'company', operator: '$includes', value: '' }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'company' },
      ],
      [
        'a non-finite number',
        { filters: [{ field: 'amount', operator: '$lt', value: Number.POSITIVE_INFINITY }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'amount' },
      ],
      [
        'an overlong text value',
        { filters: [{ field: 'company', operator: '$eq', value: 'x'.repeat(4001) }] },
        { code: 'RECORD_QUERY_VALUE_INVALID', field: 'company' },
      ],
      [
        'an unknown sort field',
        { sort: { field: 'owner', direction: 'asc' } },
        { code: 'RECORD_QUERY_FIELD_UNKNOWN', field: 'owner' },
      ],
      [
        'an unknown sort direction',
        { sort: { field: 'amount', direction: 'up' } },
        { code: 'RECORD_QUERY_SORT_INVALID' },
      ],
      ['page zero', { page: 0 }, { code: 'RECORD_QUERY_PAGE_INVALID' }],
      ['a fractional page', { page: 1.5 }, { code: 'RECORD_QUERY_PAGE_INVALID' }],
      ['an empty page size', { pageSize: 0 }, { code: 'RECORD_QUERY_PAGE_INVALID' }],
      ['a page size over 100', { pageSize: 101 }, { code: 'RECORD_QUERY_PAGE_INVALID' }],
    ])('rejects %s', (_label, query, expected) => {
      expect(rejection(query)).toMatchObject(expected);
    });

    it('rejects more than ten filters', () => {
      const filters = Array.from({ length: 11 }, () => ({ field: 'amount', operator: '$notEmpty' }));
      expect(rejection({ filters })).toMatchObject({ code: 'RECORD_QUERY_FILTER_COUNT_INVALID' });
    });
  });
});
