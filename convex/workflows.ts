import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireUser } from './auth';
import { assertFieldValue, requireOwnedCollection, validateRecordValues } from './demoValidation';

const MAX_RECORDS_PER_RUN = 100;
const MAX_WORKFLOWS_PER_USER = 100;
const MAX_RUNS_PER_WORKFLOW = 100;
const RUN_HISTORY_LIMIT = 20;

const workflowValidator = v.object({
  _id: v.id('demoWorkflows'),
  collectionId: v.id('demoCollections'),
  name: v.string(),
  field: v.string(),
  value: v.union(v.string(), v.number(), v.boolean()),
});

const workflowRunValidator = v.object({
  _id: v.id('demoWorkflowRuns'),
  workflowId: v.id('demoWorkflows'),
  status: v.literal('completed'),
  updatedCount: v.number(),
  completedAt: v.number(),
});

export const list = query({
  args: {},
  returns: v.object({ items: v.array(workflowValidator), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const ownerId = await requireUser(ctx);
    const workflows = await ctx.db
      .query('demoWorkflows')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .order('desc')
      .take(MAX_WORKFLOWS_PER_USER + 1);

    return {
      items: workflows.slice(0, MAX_WORKFLOWS_PER_USER).map(({ _id, collectionId, name, field, value }) => ({
        _id,
        collectionId,
        name,
        field,
        value,
      })),
      hasMore: workflows.length > MAX_WORKFLOWS_PER_USER,
    };
  },
});

export const listRuns = query({
  args: { workflowId: v.id('demoWorkflows') },
  returns: v.array(workflowRunValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.ownerId !== ownerId) throw new ConvexError('Workflow not found');

    const runs = await ctx.db
      .query('demoWorkflowRuns')
      .withIndex('by_workflow', (q) => q.eq('workflowId', args.workflowId))
      .order('desc')
      .take(RUN_HISTORY_LIMIT);

    return runs.map(({ _id, workflowId, status, updatedCount, completedAt }) => ({
      _id,
      workflowId,
      status,
      updatedCount,
      completedAt,
    }));
  },
});

export const create = mutation({
  args: {
    collectionId: v.id('demoCollections'),
    name: v.string(),
    field: v.string(),
    value: v.union(v.string(), v.number(), v.boolean()),
  },
  returns: v.object({ workflowId: v.id('demoWorkflows') }),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const collection = await requireOwnedCollection(ctx, ownerId, args.collectionId);
    const name = args.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new ConvexError('Workflow name must contain between 1 and 120 characters');
    }
    assertFieldValue(collection.fields, args.field, args.value);

    const workflows = await ctx.db
      .query('demoWorkflows')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .take(MAX_WORKFLOWS_PER_USER + 1);
    if (workflows.length >= MAX_WORKFLOWS_PER_USER) {
      throw new ConvexError(`A user can create at most ${MAX_WORKFLOWS_PER_USER} demo workflows`);
    }

    const workflowId = await ctx.db.insert('demoWorkflows', {
      ownerId,
      collectionId: args.collectionId,
      name,
      field: args.field,
      value: args.value,
    });

    return { workflowId };
  },
});

export const run = mutation({
  args: { workflowId: v.id('demoWorkflows') },
  returns: workflowRunValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.ownerId !== ownerId) throw new ConvexError('Workflow not found');

    const collection = await requireOwnedCollection(ctx, ownerId, workflow.collectionId);
    assertFieldValue(collection.fields, workflow.field, workflow.value);

    const records = await ctx.db
      .query('demoRecords')
      .withIndex('by_owner_and_collection', (q) => q.eq('ownerId', ownerId).eq('collectionId', workflow.collectionId))
      .take(MAX_RECORDS_PER_RUN + 1);
    if (records.length > MAX_RECORDS_PER_RUN) {
      throw new ConvexError(`A demo workflow can update at most ${MAX_RECORDS_PER_RUN} records per run`);
    }

    const completedAt = Date.now();
    for (const record of records) {
      const values = { ...record.values, [workflow.field]: workflow.value };
      validateRecordValues(collection.fields, values);
      await ctx.db.patch(record._id, { values, updatedAt: completedAt });
    }

    const runId = await ctx.db.insert('demoWorkflowRuns', {
      ownerId,
      workflowId: workflow._id,
      status: 'completed',
      updatedCount: records.length,
      completedAt,
    });

    return {
      _id: runId,
      workflowId: workflow._id,
      status: 'completed' as const,
      updatedCount: records.length,
      completedAt,
    };
  },
});

export const remove = mutation({
  args: { workflowId: v.id('demoWorkflows') },
  returns: v.object({ workflowId: v.id('demoWorkflows') }),
  handler: async (ctx, args) => {
    const ownerId = await requireUser(ctx);
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.ownerId !== ownerId) throw new ConvexError('Workflow not found');

    const runs = await ctx.db
      .query('demoWorkflowRuns')
      .withIndex('by_workflow', (q) => q.eq('workflowId', args.workflowId))
      .take(MAX_RUNS_PER_WORKFLOW + 1);
    if (runs.length > MAX_RUNS_PER_WORKFLOW) {
      throw new ConvexError(`A demo workflow with more than ${MAX_RUNS_PER_WORKFLOW} runs cannot be removed`);
    }

    for (const run of runs) await ctx.db.delete(run._id);
    await ctx.db.delete(workflow._id);

    return { workflowId: workflow._id };
  },
});
