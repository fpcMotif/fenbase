import { describe, expect, it, vi } from 'vitest';
import { create, list, remove, update } from '../records';
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
