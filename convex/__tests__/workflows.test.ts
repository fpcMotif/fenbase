import { describe, expect, it, vi } from 'vitest';
import { run } from '../workflows';
import { createContext, invokeHandler, type TestContext, type TestDoc, type TableName } from './helpers.support';

vi.mock('../auth', () => ({ requireUser: async () => 'user-1' }));

function makeCollection(): TestDoc {
  return {
    _id: 'demoCollections:1',
    _creationTime: 1,
    ownerId: 'user-1',
    name: 'leads',
    title: 'Leads',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'status', type: 'text' },
    ],
  };
}

function makeWorkflow(ownerId = 'user-1'): TestDoc {
  return {
    _id: 'demoWorkflows:1',
    _creationTime: 2,
    ownerId,
    collectionId: 'demoCollections:1',
    name: 'Mark contacted',
    field: 'status',
    value: 'contacted',
  };
}

function makeRecord(id: number, ownerId = 'user-1', collectionId = 'demoCollections:1'): TestDoc {
  return {
    _id: `demoRecords:${id}`,
    _creationTime: id,
    ownerId,
    collectionId,
    values: { name: `Lead ${id}`, status: 'new' },
    updatedAt: 1,
  };
}

describe('demo workflows', () => {
  it('updates every owned record in the collection and records the completed count', async () => {
    const ctx = createContext({
      demoCollections: [makeCollection()],
      demoWorkflows: [makeWorkflow()],
      demoRecords: [
        makeRecord(1),
        makeRecord(2),
        makeRecord(3, 'user-2'),
        makeRecord(4, 'user-1', 'demoCollections:2'),
      ],
    });

    const result = await invokeHandler(run, ctx, { workflowId: 'demoWorkflows:1' });

    expect(result).toMatchObject({
      workflowId: 'demoWorkflows:1',
      status: 'completed',
      updatedCount: 2,
    });
    expect(ctx.read('demoRecords', 'demoRecords:1')?.values).toEqual({ name: 'Lead 1', status: 'contacted' });
    expect(ctx.read('demoRecords', 'demoRecords:2')?.values).toEqual({ name: 'Lead 2', status: 'contacted' });
    expect(ctx.read('demoRecords', 'demoRecords:3')?.values).toEqual({ name: 'Lead 3', status: 'new' });
    expect(ctx.read('demoRecords', 'demoRecords:4')?.values).toEqual({ name: 'Lead 4', status: 'new' });
    expect(ctx.counts.inserts).toBe(1);
  });

  it('rejects more than 100 records before writing records or a run', async () => {
    const records = Array.from({ length: 101 }, (_, index) => makeRecord(index + 1));
    const ctx = createContext({
      demoCollections: [makeCollection()],
      demoWorkflows: [makeWorkflow()],
      demoRecords: records,
    });

    await expect(invokeHandler(run, ctx, { workflowId: 'demoWorkflows:1' })).rejects.toThrow(/at most 100 records/);

    expect(ctx.counts.patches).toBe(0);
    expect(ctx.counts.inserts).toBe(0);
    expect(ctx.read('demoRecords', 'demoRecords:1')?.values).toEqual({ name: 'Lead 1', status: 'new' });
  });

  it('rejects another user’s workflow without changing records', async () => {
    const ctx = createContext({
      demoCollections: [makeCollection()],
      demoWorkflows: [makeWorkflow('user-2')],
      demoRecords: [makeRecord(1)],
    });

    await expect(invokeHandler(run, ctx, { workflowId: 'demoWorkflows:1' })).rejects.toThrow('Workflow not found');

    expect(ctx.counts.patches).toBe(0);
    expect(ctx.counts.inserts).toBe(0);
    expect(ctx.read('demoRecords', 'demoRecords:1')?.values).toEqual({ name: 'Lead 1', status: 'new' });
  });
});
