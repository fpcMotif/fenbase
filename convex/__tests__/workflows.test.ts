import { describe, expect, it, vi } from 'vitest';
import { run } from '../workflows';

vi.mock('../auth', () => ({ requireUser: async () => 'user-1' }));

type TableName = 'demoCollections' | 'demoRecords' | 'demoWorkflows' | 'demoWorkflowRuns';

interface TestDoc extends Record<string, unknown> {
  _id: string;
  _creationTime: number;
}

interface IndexRange {
  eq(field: string, value: unknown): IndexRange;
}

interface IndexedQuery {
  order(direction: 'asc' | 'desc'): IndexedQuery;
  take(count: number): TestDoc[];
}

interface TestContext {
  db: {
    get(id: string): Promise<TestDoc | null>;
    query(table: TableName): {
      withIndex(indexName: string, buildRange: (range: IndexRange) => IndexRange): IndexedQuery;
    };
    insert(table: TableName, value: Record<string, unknown>): Promise<string>;
    patch(id: string, value: Record<string, unknown>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  counts: { inserts: number; patches: number; deletes: number };
  read(table: TableName, id: string): TestDoc | null;
}

function createContext(seed: Partial<Record<TableName, TestDoc[]>>): TestContext {
  const tables = new Map<TableName, Map<string, TestDoc>>();
  const tableNames: TableName[] = ['demoCollections', 'demoRecords', 'demoWorkflows', 'demoWorkflowRuns'];
  for (const table of tableNames) {
    tables.set(table, new Map((seed[table] ?? []).map((doc) => [doc._id, doc])));
  }

  const counts = { inserts: 0, patches: 0, deletes: 0 };
  let nextId = 1;
  const getTable = (table: TableName) => {
    const docs = tables.get(table);
    if (!docs) throw new Error(`Unknown table: ${table}`);
    return docs;
  };

  const db: TestContext['db'] = {
    async get(id) {
      for (const table of tableNames) {
        const doc = getTable(table).get(id);
        if (doc) return doc;
      }
      return null;
    },
    query(table) {
      return {
        withIndex(_indexName, buildRange) {
          const conditions: Array<{ field: string; value: unknown }> = [];
          const range: IndexRange = {
            eq(field, value) {
              conditions.push({ field, value });
              return range;
            },
          };
          buildRange(range);
          let docs = [...getTable(table).values()].filter((doc) =>
            conditions.every(({ field, value }) => doc[field] === value),
          );

          const query: IndexedQuery = {
            order(direction) {
              const factor = direction === 'asc' ? 1 : -1;
              docs = docs.sort((left, right) => factor * (Number(left._creationTime) - Number(right._creationTime)));
              return query;
            },
            take(count) {
              return docs.slice(0, count);
            },
          };
          return query;
        },
      };
    },
    async insert(table, value) {
      counts.inserts += 1;
      const id = `${table}:${nextId++}`;
      getTable(table).set(id, { ...value, _id: id, _creationTime: Date.now() });
      return id;
    },
    async patch(id, value) {
      counts.patches += 1;
      for (const table of tableNames) {
        const doc = getTable(table).get(id);
        if (doc) {
          getTable(table).set(id, { ...doc, ...value });
          return;
        }
      }
      throw new Error(`Document not found: ${id}`);
    },
    async delete(id) {
      counts.deletes += 1;
      for (const table of tableNames) {
        if (getTable(table).delete(id)) return;
      }
      throw new Error(`Document not found: ${id}`);
    },
  };

  return {
    db,
    counts,
    read(table, id) {
      return getTable(table).get(id) ?? null;
    },
  };
}

async function invokeHandler(registeredFunction: unknown, ctx: TestContext, args: unknown): Promise<unknown> {
  if (typeof registeredFunction !== 'function') throw new Error('Convex function is not registered');
  const handler = Reflect.get(registeredFunction, '_handler');
  if (typeof handler !== 'function') throw new Error('Convex function handler is unavailable');
  return Reflect.apply(handler, undefined, [ctx, args]);
}

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
