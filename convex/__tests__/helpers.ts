export type TableName = 'demoCollections' | 'demoRecords' | 'demoWorkflows' | 'demoWorkflowRuns';

export interface TestDoc extends Record<string, unknown> {
  _id: string;
  _creationTime: number;
}

interface IndexRange {
  eq(field: string, value: unknown): IndexRange;
}

interface IndexedQuery {
  order(direction: 'asc' | 'desc'): IndexedQuery;
  take(count: number): TestDoc[];
  first(): TestDoc | null;
  unique(): TestDoc | null;
}

export interface TestContext {
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

export function createContext(seed: Partial<Record<TableName, TestDoc[]>> = {}): TestContext {
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
            first() {
              return docs[0] ?? null;
            },
            unique() {
              if (docs.length > 1) throw new Error(`Expected a unique document in ${_indexName}`);
              return docs[0] ?? null;
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

export async function invokeHandler(registeredFunction: unknown, ctx: TestContext, args: unknown): Promise<unknown> {
  if (typeof registeredFunction !== 'function') throw new Error('Convex function is not registered');
  const handler = Reflect.get(registeredFunction, '_handler');
  if (typeof handler !== 'function') throw new Error('Convex function handler is unavailable');
  return Reflect.apply(handler, undefined, [ctx, args]);
}
