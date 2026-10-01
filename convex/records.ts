import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { requireUser } from './auth';
import { mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { requireOwnedCollection, requireOwnedRecord, validateRecordValues } from './demoValidation';
import { MAX_RECORDS_PER_COLLECTION, queryRecords, validateRecordQuery } from './recordQuery';

const scalarValidator = v.union(v.string(), v.number(), v.boolean());
const valuesValidator = v.record(v.string(), scalarValidator);

const recordValidator = v.object({
  _id: v.id('demoRecords'),
  _creationTime: v.number(),
  collectionId: v.id('demoCollections'),
  values: valuesValidator,
  updatedAt: v.number(),
});

// Reads one past the cap so callers can tell a full collection from an oversized one.
async function readCollectionRecords(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  collectionId: Id<'demoCollections'>,
) {
  return await ctx.db
    .query('demoRecords')
    .withIndex('by_owner_and_collection', (q) => q.eq('ownerId', ownerId).eq('collectionId', collectionId))
    .take(MAX_RECORDS_PER_COLLECTION + 1);
}

export const browse = query({
  args: {
    collectionId: v.id('demoCollections'),
    // Operators, fields, and directions are checked by `validateRecordQuery` rather than by validators, so malformed input gets a coded,
    // translatable error.
    filters: v.optional(
      v.array(v.object({ field: v.string(), operator: v.string(), value: v.optional(scalarValidator) })),
    ),
    sort: v.optional(v.object({ field: v.string(), direction: v.string() })),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(recordValidator),
    total: v.number(),
    collectionTotal: v.number(),
    page: v.number(),
    pageSize: v.number(),
    pageCount: v.number(),
  }),
  handler: async (ctx, { collectionId: requestedCollectionId, ...query }) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, requestedCollectionId);
    validateRecordQuery(collection.fields, query);
    const rows = await readCollectionRecords(ctx, ownerId, collection._id);
    if (rows.length > MAX_RECORDS_PER_COLLECTION) {
      throw new ConvexError({
        code: 'RECORD_BROWSE_LIMIT_EXCEEDED',
        message: `Collections with more than ${MAX_RECORDS_PER_COLLECTION} records cannot be browsed`,
      });
    }
    const result = queryRecords(rows, collection.fields, query);
    return {
      ...result,
      items: result.items.map(({ _id, _creationTime, collectionId, values, updatedAt }) => ({
        _id,
        _creationTime,
        collectionId,
        values,
        updatedAt,
      })),
      collectionTotal: rows.length,
    };
  },
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
    const existing = await readCollectionRecords(ctx, ownerId, collection._id);
    if (existing.length >= MAX_RECORDS_PER_COLLECTION) {
      throw new ConvexError({
        code: 'RECORD_COLLECTION_FULL',
        message: `A collection can hold at most ${MAX_RECORDS_PER_COLLECTION} records`,
      });
    }

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
