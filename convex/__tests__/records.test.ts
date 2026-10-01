import { describe, expect, it, vi } from 'vitest';
import { browse, create, get, list, remove, update } from '../records';
import { createContext, invokeHandler } from './helpers';

vi.mock('../auth', () => ({ requireUser: async () => 'user-1' }));

const collection = {
  _id: 'demoCollections:1',
  _creationTime: 1,
  ownerId: 'user-1',
  name: 'leads',
  title: 'Leads',
  fields: [
    { name: 'company', type: 'text', required: true },
    { name: 'amount', type: 'number', required: true },
    { name: 'qualified', type: 'boolean', required: true },
    { name: 'note', type: 'text' },
  ],
};

describe('owned collection records', () => {
  it('reads an owned record by identifier without exposing its owner metadata', async () => {
    const ctx = createContext({ demoCollections: [collection] });
    const values = { company: 'Private company', amount: 0, qualified: false };
    const recordId = await invokeHandler(create, ctx, { collectionId: collection._id, values });
    const record = await invokeHandler(get, ctx, { recordId });
    expect(record).toMatchObject({ _id: recordId, collectionId: collection._id, values });
    expect(record).not.toHaveProperty('ownerId');
    await invokeHandler(remove, ctx, { recordId });
    await expect(invokeHandler(get, ctx, { recordId })).rejects.toMatchObject({ data: { code: 'RECORD_NOT_FOUND' } });
  });

  it('rejects a known record identifier belonging to another owner', async () => {
    const ctx = createContext({
      demoCollections: [collection],
      demoRecords: [
        {
          _id: 'demoRecords:private',
          _creationTime: 1,
          ownerId: 'user-2',
          collectionId: collection._id,
          values: { company: 'Other owner', amount: 1, qualified: true },
          updatedAt: 1,
        },
      ],
    });
    await expect(invokeHandler(get, ctx, { recordId: 'demoRecords:private' })).rejects.toMatchObject({
      data: { code: 'RECORD_NOT_FOUND' },
    });
  });

  it('returns a transportable required-field error without creating a record', async () => {
    const ctx = createContext({ demoCollections: [collection] });

    await expect(invokeHandler(create, ctx, { collectionId: collection._id, values: {} })).rejects.toMatchObject({
      data: { code: 'RECORD_FIELD_REQUIRED', field: 'company' },
    });
    expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toEqual({ items: [], hasMore: false });
  });

  it('creates, reads, replaces, and deletes typed values through the record API', async () => {
    const ctx = createContext({ demoCollections: [collection] });
    const id = await invokeHandler(create, ctx, {
      collectionId: collection._id,
      values: { company: 'Aster Labs', amount: 0, qualified: false, note: 'Optional' },
    });
    expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toMatchObject({
      items: [
        {
          _id: id,
          collectionId: collection._id,
          values: { company: 'Aster Labs', amount: 0, qualified: false, note: 'Optional' },
        },
      ],
      hasMore: false,
    });
    await invokeHandler(update, ctx, { recordId: id, values: { company: 'Edited', amount: -12.5, qualified: true } });
    expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toMatchObject({
      items: [{ _id: id, collectionId: collection._id, values: { company: 'Edited', amount: -12.5, qualified: true } }],
    });
    await invokeHandler(remove, ctx, { recordId: id });
    expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toEqual({ items: [], hasMore: false });
    await expect(invokeHandler(update, ctx, { recordId: id, values: {} })).rejects.toMatchObject({
      data: { code: 'RECORD_NOT_FOUND' },
    });
  });

  it.each([
    [{ company: 'Valid', amount: 1, qualified: true, extra: 'unknown' }, 'RECORD_FIELD_UNKNOWN', 'extra'],
    [{ company: 'Valid', amount: '1', qualified: true }, 'RECORD_FIELD_TYPE_INVALID', 'amount'],
    [{ company: 'Valid', amount: 1, qualified: 'false' }, 'RECORD_FIELD_TYPE_INVALID', 'qualified'],
    [{ company: 12, amount: 1, qualified: true }, 'RECORD_FIELD_TYPE_INVALID', 'company'],
    [{ company: 'Valid', amount: Number.POSITIVE_INFINITY, qualified: true }, 'RECORD_FIELD_TYPE_INVALID', 'amount'],
    [{ company: 'x'.repeat(4001), amount: 1, qualified: true }, 'RECORD_TEXT_TOO_LONG', 'company'],
    [{ company: '   ', amount: 1, qualified: true }, 'RECORD_FIELD_REQUIRED', 'company'],
    [{ company: 'Valid', qualified: true }, 'RECORD_FIELD_REQUIRED', 'amount'],
    [{ company: 'Valid', amount: 1 }, 'RECORD_FIELD_REQUIRED', 'qualified'],
  ])('rejects invalid create and update values %# without partial writes', async (values, code, field) => {
    const ctx = createContext({ demoCollections: [collection] });
    const original = { company: 'Original', amount: 0, qualified: false };
    const id = await invokeHandler(create, ctx, { collectionId: collection._id, values: original });
    for (const [operation, args] of [
      [create, { collectionId: collection._id, values }],
      [update, { recordId: id, values }],
    ] as const) {
      await expect(invokeHandler(operation, ctx, args)).rejects.toMatchObject({ data: { code, field } });
      expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toMatchObject({
        items: [{ _id: id, values: original }],
      });
      expect(ctx.counts.inserts).toBe(1);
      expect(ctx.counts.patches).toBe(0);
    }
  });

  it('isolates record lists by collection and owner and denies non-owner mutations', async () => {
    const ctx = createContext({
      demoCollections: [
        collection,
        { ...collection, _id: 'demoCollections:2', name: 'other' },
        { ...collection, _id: 'demoCollections:3', ownerId: 'user-2' },
      ],
    });
    const first = await invokeHandler(create, ctx, {
      collectionId: collection._id,
      values: { company: 'First', amount: 1, qualified: false },
    });
    await invokeHandler(create, ctx, {
      collectionId: 'demoCollections:2',
      values: { company: 'Second', amount: 2, qualified: true },
    });
    expect(await invokeHandler(list, ctx, { collectionId: collection._id })).toMatchObject({
      items: [{ _id: first, values: { company: 'First' } }],
    });
    const intruder = createContext({
      demoCollections: [collection],
      demoRecords: [
        {
          _id: 'demoRecords:foreign',
          _creationTime: 1,
          ownerId: 'user-2',
          collectionId: collection._id,
          values: { company: 'Foreign' },
          updatedAt: 1,
        },
      ],
    });
    expect(await invokeHandler(list, intruder, { collectionId: collection._id })).toEqual({
      items: [],
      hasMore: false,
    });
    for (const operation of [update, remove]) {
      await expect(
        invokeHandler(operation, intruder, { recordId: 'demoRecords:foreign', values: {} }),
      ).rejects.toMatchObject({ data: { code: 'RECORD_NOT_FOUND' } });
    }
    for (const operation of [list, create]) {
      await expect(
        invokeHandler(operation, ctx, { collectionId: 'demoCollections:3', values: {} }),
      ).rejects.toMatchObject({ data: { code: 'COLLECTION_NOT_FOUND' } });
    }
    expect(intruder.counts.patches).toBe(0);
    expect(intruder.counts.deletes).toBe(0);
  });
});

describe('browsing owned collection records', () => {
  function stored(id: string, createdAt: number, ownerId: string, collectionId: string, amount: number) {
    return {
      _id: id,
      _creationTime: createdAt,
      ownerId,
      collectionId,
      values: { company: `Company ${id}`, amount, qualified: amount > 10 },
      updatedAt: createdAt,
    };
  }

  it('filters, sorts, and pages only the owner records of the owned collection', async () => {
    const ctx = createContext({
      demoCollections: [collection, { ...collection, _id: 'demoCollections:2' }],
      demoRecords: [
        stored('demoRecords:a', 1, 'user-1', collection._id, 5),
        stored('demoRecords:b', 2, 'user-1', collection._id, 20),
        stored('demoRecords:c', 3, 'user-1', collection._id, 30),
        stored('demoRecords:d', 4, 'user-1', collection._id, 20),
        stored('demoRecords:other-owner', 5, 'user-2', collection._id, 99),
        stored('demoRecords:other-collection', 6, 'user-1', 'demoCollections:2', 99),
      ],
    });

    const result = await invokeHandler(browse, ctx, {
      collectionId: collection._id,
      filters: [{ field: 'amount', operator: '$gte', value: 10 }],
      sort: { field: 'amount', direction: 'asc' },
      page: 2,
      pageSize: 2,
    });

    expect(result).toEqual({
      items: [
        {
          _id: 'demoRecords:c',
          _creationTime: 3,
          collectionId: collection._id,
          values: { company: 'Company demoRecords:c', amount: 30, qualified: true },
          updatedAt: 3,
        },
      ],
      total: 3,
      collectionTotal: 4,
      page: 2,
      pageSize: 2,
      pageCount: 2,
    });
  });

  it('rejects a collection owned by someone else', async () => {
    const ctx = createContext({ demoCollections: [{ ...collection, ownerId: 'user-2' }] });
    await expect(invokeHandler(browse, ctx, { collectionId: collection._id })).rejects.toMatchObject({
      data: { code: 'COLLECTION_NOT_FOUND' },
    });
  });

  it('rejects an unsupported query with a coded error', async () => {
    const ctx = createContext({ demoCollections: [collection] });
    await expect(
      invokeHandler(browse, ctx, {
        collectionId: collection._id,
        filters: [{ field: 'company', operator: '$gt', value: 'a' }],
      }),
    ).rejects.toMatchObject({ data: { code: 'RECORD_QUERY_OPERATOR_INVALID', field: 'company' } });
  });

  it('refuses to browse a collection above the record limit instead of truncating it', async () => {
    const ctx = createContext({
      demoCollections: [collection],
      demoRecords: Array.from({ length: 1001 }, (_, index) =>
        stored(`demoRecords:${index}`, index, 'user-1', collection._id, index),
      ),
    });
    await expect(invokeHandler(browse, ctx, { collectionId: collection._id })).rejects.toMatchObject({
      data: { code: 'RECORD_BROWSE_LIMIT_EXCEEDED' },
    });
  });

  it('refuses a new record once the collection holds the maximum number of records', async () => {
    const ctx = createContext({
      demoCollections: [collection],
      demoRecords: Array.from({ length: 1000 }, (_, index) =>
        stored(`demoRecords:${index}`, index, 'user-1', collection._id, index),
      ),
    });
    await expect(
      invokeHandler(create, ctx, {
        collectionId: collection._id,
        values: { company: 'One too many', amount: 1, qualified: false },
      }),
    ).rejects.toMatchObject({ data: { code: 'RECORD_COLLECTION_FULL' } });
    expect(ctx.counts.inserts).toBe(0);
  });
});
