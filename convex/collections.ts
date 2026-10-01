import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { requireUser } from './auth';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import {
  requireOwnedCollection,
  validateCollectionFields,
  validateCollectionName,
  validateCollectionTitle,
} from './demoValidation';

const fieldValidator = v.object({
  name: v.string(),
  type: v.union(v.literal('text'), v.literal('number'), v.literal('boolean')),
  required: v.optional(v.boolean()),
});

const collectionValidator = v.object({
  _id: v.id('demoCollections'),
  _creationTime: v.number(),
  name: v.string(),
  title: v.string(),
  fields: v.array(fieldValidator),
});

// Throws when another collection owned by the same user already uses `name`; pass the id being
// renamed so keeping its own current name is allowed.
async function assertNameAvailable(ctx: MutationCtx, ownerId: string, name: string, selfId?: Id<'demoCollections'>) {
  const existing = await ctx.db
    .query('demoCollections')
    .withIndex('by_owner_name', (q) => q.eq('ownerId', ownerId).eq('name', name))
    .first();
  if (existing && existing._id !== selfId) {
    throw new ConvexError(`Collection name already exists: ${name}`);
  }
}

export const list = query({
  args: {},
  returns: v.object({
    items: v.array(collectionValidator),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUser(ctx);
    const rows = await ctx.db
      .query('demoCollections')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .order('desc')
      .take(101);

    return {
      items: rows.slice(0, 100).map(({ _id, _creationTime, name, title, fields }) => ({
        _id,
        _creationTime,
        name,
        title,
        fields,
      })),
      hasMore: rows.length > 100,
    };
  },
});

export const get = query({
  args: { collectionId: v.id('demoCollections') },
  returns: collectionValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    return {
      _id: collection._id,
      _creationTime: collection._creationTime,
      name: collection.name,
      title: collection.title,
      fields: collection.fields,
    };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    title: v.string(),
    fields: v.array(fieldValidator),
  },
  returns: v.id('demoCollections'),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const name = validateCollectionName(args.name);
    const title = validateCollectionTitle(args.title);
    validateCollectionFields(args.fields);
    await assertNameAvailable(ctx, ownerId, name);

    return await ctx.db.insert('demoCollections', {
      ownerId,
      name,
      title,
      fields: args.fields,
    });
  },
});

export const update = mutation({
  args: {
    collectionId: v.id('demoCollections'),
    name: v.string(),
    title: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    const name = validateCollectionName(args.name);
    const title = validateCollectionTitle(args.title);
    await assertNameAvailable(ctx, ownerId, name, collection._id);

    await ctx.db.patch(collection._id, { name, title });
    return null;
  },
});

export const remove = mutation({
  args: { collectionId: v.id('demoCollections') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    const [record, workflow] = await Promise.all([
      ctx.db
        .query('demoRecords')
        .withIndex('by_owner_and_collection', (q) => q.eq('ownerId', ownerId).eq('collectionId', collection._id))
        .first(),
      ctx.db
        .query('demoWorkflows')
        .withIndex('by_owner_and_collection', (q) => q.eq('ownerId', ownerId).eq('collectionId', collection._id))
        .first(),
    ]);

    if (record) throw new Error('Remove all records before deleting this collection');
    if (workflow) throw new Error('Delete workflows before deleting this collection');

    await ctx.db.delete(collection._id);
    return null;
  },
});
