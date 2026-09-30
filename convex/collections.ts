import { v } from 'convex/values';
import { requireUser } from './auth';
import { mutation, query } from './_generated/server';
import { requireOwnedCollection, validateCollectionFields } from './demoValidation';

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

export const create = mutation({
  args: {
    name: v.string(),
    title: v.string(),
    fields: v.array(fieldValidator),
  },
  returns: v.id('demoCollections'),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const name = args.name.trim();
    const title = args.title.trim();

    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
      throw new Error(
        'Collection name must start with a lowercase letter and use lowercase letters, numbers, or underscores',
      );
    }
    if (title.length === 0 || title.length > 120) {
      throw new Error('Collection title must contain between 1 and 120 characters');
    }
    validateCollectionFields(args.fields);

    const existing = await ctx.db
      .query('demoCollections')
      .withIndex('by_owner_name', (q) => q.eq('ownerId', ownerId).eq('name', name))
      .first();
    if (existing) {
      throw new Error(`Collection name already exists: ${name}`);
    }

    return await ctx.db.insert('demoCollections', {
      ownerId,
      name,
      title,
      fields: args.fields,
    });
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
