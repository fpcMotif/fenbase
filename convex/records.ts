import { v } from 'convex/values';
import { requireUser } from './auth';
import { mutation, query } from './_generated/server';
import { requireOwnedCollection, requireOwnedRecord, validateRecordValues } from './demoValidation';

const scalarValidator = v.union(v.string(), v.number(), v.boolean());
const valuesValidator = v.record(v.string(), scalarValidator);

const recordValidator = v.object({
  _id: v.id('demoRecords'),
  _creationTime: v.number(),
  collectionId: v.id('demoCollections'),
  values: valuesValidator,
  updatedAt: v.number(),
});

export const get = query({
  args: { recordId: v.id('demoRecords') },
  returns: recordValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const record = await requireOwnedRecord(ctx, ownerId, args.recordId);
    await requireOwnedCollection(ctx, ownerId, record.collectionId);
    const { _id, _creationTime, collectionId, values, updatedAt } = record;
    return { _id, _creationTime, collectionId, values, updatedAt };
  },
});

export const list = query({
  args: {
    collectionId: v.id('demoCollections'),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(recordValidator),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    const limit = args.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Record list limit must be an integer from 1 to 100');
    }

    const rows = await ctx.db
      .query('demoRecords')
      .withIndex('by_owner_and_collection', (q) => q.eq('ownerId', ownerId).eq('collectionId', collection._id))
      .order('desc')
      .take(limit + 1);

    return {
      items: rows.slice(0, limit).map(({ _id, _creationTime, collectionId, values, updatedAt }) => ({
        _id,
        _creationTime,
        collectionId,
        values,
        updatedAt,
      })),
      hasMore: rows.length > limit,
    };
  },
});

export const create = mutation({
  args: {
    collectionId: v.id('demoCollections'),
    values: valuesValidator,
  },
  returns: v.id('demoRecords'),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    validateRecordValues(collection.fields, args.values);

    return await ctx.db.insert('demoRecords', {
      ownerId,
      collectionId: collection._id,
      values: args.values,
      updatedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    recordId: v.id('demoRecords'),
    values: valuesValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const record = await requireOwnedRecord(ctx, ownerId, args.recordId);
    const collection = await requireOwnedCollection(ctx, ownerId, record.collectionId);
    validateRecordValues(collection.fields, args.values);

    await ctx.db.patch(record._id, {
      values: args.values,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: { recordId: v.id('demoRecords') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const record = await requireOwnedRecord(ctx, ownerId, args.recordId);
    await ctx.db.delete(record._id);
    return null;
  },
});
