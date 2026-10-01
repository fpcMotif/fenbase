import { describe, expect, it, vi } from 'vitest';
import { create, get, remove, update } from '../collections';
import { createContext, invokeHandler, type TestContext, type TestDoc } from './helpers';

vi.mock('../auth', () => ({ requireUser: async () => 'user-1' }));

const collectionFields = [
  { name: 'company', type: 'text', required: true },
  { name: 'amount', type: 'number' },
  { name: 'qualified', type: 'boolean' },
];

function makeCollection(overrides: Partial<TestDoc> = {}): TestDoc {
  return {
    _id: 'demoCollections:1',
    _creationTime: 1,
    ownerId: 'user-1',
    name: 'leads',
    title: 'Leads',
    fields: collectionFields,
    ...overrides,
  };
}

function makeRecord(collectionId: string, ownerId = 'user-1'): TestDoc {
  return {
    _id: 'demoRecords:1',
    _creationTime: 2,
    ownerId,
    collectionId,
    values: { company: 'Aster Labs', amount: 1200 },
    updatedAt: 1,
  };
}

function makeWorkflow(collectionId: string, ownerId = 'user-1'): TestDoc {
  return {
    _id: 'demoWorkflows:1',
    _creationTime: 2,
    ownerId,
    collectionId,
    name: 'Qualify',
    field: 'qualified',
    value: true,
  };
}

describe('demo collection configuration', () => {
  it('reopens a saved collection with its persisted field configuration', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()] });

    const result = await invokeHandler(get, ctx, { collectionId: 'demoCollections:1' });

    expect(result).toMatchObject({
      _id: 'demoCollections:1',
      name: 'leads',
      title: 'Leads',
      fields: collectionFields,
    });
  });

  it('refuses to reopen another user’s collection', async () => {
    const ctx = createContext({ demoCollections: [makeCollection({ ownerId: 'user-2' })] });

    await expect(invokeHandler(get, ctx, { collectionId: 'demoCollections:1' })).rejects.toThrow(
      'Collection not found',
    );
  });

  it('creates a collection with the requested name, title, and fields', async () => {
    const ctx = createContext();

    const id = await invokeHandler(create, ctx, { name: ' leads ', title: ' Leads ', fields: collectionFields });

    expect(typeof id).toBe('string');
    expect(ctx.read('demoCollections', id as string)).toMatchObject({
      ownerId: 'user-1',
      name: 'leads',
      title: 'Leads',
      fields: collectionFields,
    });
  });

  it('rejects a duplicate collection name per owner without inserting', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()] });

    await expect(
      invokeHandler(create, ctx, { name: 'leads', title: 'Other', fields: collectionFields }),
    ).rejects.toThrow('Collection name already exists: leads');
    expect(ctx.counts.inserts).toBe(0);
  });

  it('rejects invalid names, blank titles, and malformed field definitions', async () => {
    const ctx = createContext();

    await expect(
      invokeHandler(create, ctx, { name: 'Bad-Name', title: 'Leads', fields: collectionFields }),
    ).rejects.toThrow(/Collection name must start with/);
    await expect(invokeHandler(create, ctx, { name: 'leads', title: '   ', fields: collectionFields })).rejects.toThrow(
      /Collection title must contain between 1 and 120/,
    );
    await expect(
      invokeHandler(create, ctx, {
        name: 'leads',
        title: 'Leads',
        fields: [
          { name: 'company', type: 'text' },
          { name: 'company', type: 'number' },
        ],
      }),
    ).rejects.toThrow('Duplicate field name: company');
    await expect(
      invokeHandler(create, ctx, { name: 'leads', title: 'Leads', fields: [{ name: 'Bad name', type: 'text' }] }),
    ).rejects.toThrow('Invalid field name: Bad name');
    expect(ctx.counts.inserts).toBe(0);
  });
});

describe('demo collection rename', () => {
  it('renames the collection and keeps its fields untouched', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()], demoRecords: [makeRecord('demoCollections:1')] });

    await invokeHandler(update, ctx, {
      collectionId: 'demoCollections:1',
      name: 'renamed_leads',
      title: 'Renamed leads',
    });

    const collection = ctx.read('demoCollections', 'demoCollections:1');
    expect(collection).toMatchObject({ name: 'renamed_leads', title: 'Renamed leads', fields: collectionFields });
    expect(ctx.counts.patches).toBe(1);
    expect(ctx.read('demoRecords', 'demoRecords:1')).toMatchObject({ collectionId: 'demoCollections:1' });
  });

  it('allows a collection to keep its own name', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()] });

    await invokeHandler(update, ctx, { collectionId: 'demoCollections:1', name: 'leads', title: 'Leads' });

    expect(ctx.read('demoCollections', 'demoCollections:1')).toMatchObject({ name: 'leads', title: 'Leads' });
    expect(ctx.counts.patches).toBe(1);
  });

  it('rejects a name already used by another collection of the same owner', async () => {
    const ctx = createContext({
      demoCollections: [
        makeCollection(),
        makeCollection({ _id: 'demoCollections:2', _creationTime: 2, name: 'accounts' }),
      ],
    });

    await expect(
      invokeHandler(update, ctx, { collectionId: 'demoCollections:2', name: 'leads', title: 'Accounts' }),
    ).rejects.toThrow('Collection name already exists: leads');
    expect(ctx.counts.patches).toBe(0);
    expect(ctx.read('demoCollections', 'demoCollections:2')).toMatchObject({ name: 'accounts' });
  });

  it('rejects invalid names and blank titles without writing', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()] });

    await expect(
      invokeHandler(update, ctx, { collectionId: 'demoCollections:1', name: '1_leads', title: 'Leads' }),
    ).rejects.toThrow(/Collection name must start with/);
    await expect(
      invokeHandler(update, ctx, { collectionId: 'demoCollections:1', name: 'leads', title: '' }),
    ).rejects.toThrow(/Collection title must contain between 1 and 120/);
    expect(ctx.counts.patches).toBe(0);
  });

  it('refuses to rename another user’s collection', async () => {
    const ctx = createContext({ demoCollections: [makeCollection({ ownerId: 'user-2' })] });

    await expect(
      invokeHandler(update, ctx, { collectionId: 'demoCollections:1', name: 'stolen_leads', title: 'Stolen' }),
    ).rejects.toThrow('Collection not found');
    expect(ctx.counts.patches).toBe(0);
    expect(ctx.read('demoCollections', 'demoCollections:1')).toMatchObject({ ownerId: 'user-2', name: 'leads' });
  });
});

describe('demo collection deletion', () => {
  it('deletes an empty owned collection', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()] });

    await invokeHandler(remove, ctx, { collectionId: 'demoCollections:1' });

    expect(ctx.read('demoCollections', 'demoCollections:1')).toBeNull();
    expect(ctx.counts.deletes).toBe(1);
  });

  it('refuses to delete a collection that still has records', async () => {
    const ctx = createContext({ demoCollections: [makeCollection()], demoRecords: [makeRecord('demoCollections:1')] });

    await expect(invokeHandler(remove, ctx, { collectionId: 'demoCollections:1' })).rejects.toThrow(
      'Remove all records before deleting this collection',
    );
    expect(ctx.counts.deletes).toBe(0);
    expect(ctx.read('demoCollections', 'demoCollections:1')).not.toBeNull();
    expect(ctx.read('demoRecords', 'demoRecords:1')).not.toBeNull();
  });

  it('refuses to delete a collection that still has workflows', async () => {
    const ctx = createContext({
      demoCollections: [makeCollection()],
      demoWorkflows: [makeWorkflow('demoCollections:1')],
    });

    await expect(invokeHandler(remove, ctx, { collectionId: 'demoCollections:1' })).rejects.toThrow(
      'Delete workflows before deleting this collection',
    );
    expect(ctx.counts.deletes).toBe(0);
    expect(ctx.read('demoCollections', 'demoCollections:1')).not.toBeNull();
    expect(ctx.read('demoWorkflows', 'demoWorkflows:1')).not.toBeNull();
  });

  it('refuses to delete another user’s collection', async () => {
    const ctx = createContext({ demoCollections: [makeCollection({ ownerId: 'user-2' })] });

    await expect(invokeHandler(remove, ctx, { collectionId: 'demoCollections:1' })).rejects.toThrow(
      'Collection not found',
    );
    expect(ctx.counts.deletes).toBe(0);
    expect(ctx.read('demoCollections', 'demoCollections:1')).not.toBeNull();
  });
});
