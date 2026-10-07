import schema from '../schema';

export type TableName =
  | 'demoCollections'
  | 'demoRecords'
  | 'demoWorkflows'
  | 'demoWorkflowRuns'
  | 'organizations'
  | 'applications'
  | 'memberships'
  | 'applicationDefinitions'
  | 'applicationDefinitionVersions'
  | 'requests'
  | 'requestCounts';

export type WriteOperation = 'insert' | 'patch' | 'replace' | 'delete';

export interface TestDoc extends Record<string, unknown> {
  _id: string;
  _creationTime: number;
}

interface IndexRange {
  eq(field: string, value: unknown): IndexRange;
  gt(field: string, value: string): IndexRange;
  lt(field: string, value: string): IndexRange;
}

type RangeCondition = { field: string; matches: (value: unknown) => boolean };

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
  writes: Array<{ table: TableName; operation: WriteOperation; id: string }>;
  indexReads: Array<{ table: TableName; index: string; rows: number }>;
  read(table: TableName, id: string): TestDoc | null;
  rows(table: TableName): TestDoc[];
  seed(table: TableName, doc: TestDoc): void;
}

export function createContext(seed: Partial<Record<TableName, TestDoc[]>> = {}): TestContext {
  const tables = new Map<TableName, Map<string, TestDoc>>();
  const tableNames: TableName[] = [
    'demoCollections',
    'demoRecords',
    'demoWorkflows',
    'demoWorkflowRuns',
    'organizations',
    'applications',
    'memberships',
    'applicationDefinitions',
    'applicationDefinitionVersions',
    'requests',
    'requestCounts',
  ];
  for (const table of tableNames) {
    tables.set(table, new Map((seed[table] ?? []).map((doc) => [doc._id, doc])));
  }

  const counts = { inserts: 0, patches: 0, deletes: 0 };
  const writes: TestContext['writes'] = [];
  const indexReads: TestContext['indexReads'] = [];
  let nextId = 1;
  let lastCreationTime = 0;
  const getTable = (table: TableName) => {
    const docs = tables.get(table);
    if (!docs) throw new Error(`Unknown table: ${table}`);
    return docs;
  };
  const tableOf = (id: string): TableName => {
    const table = tableNames.find((name) => getTable(name).has(id));
    if (!table) throw new Error(`Document not found: ${id}`);
    return table;
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
        withIndex(indexName, buildRange) {
          const conditions: RangeCondition[] = [];
          const range: IndexRange = {
            eq(field, value) {
              conditions.push({ field, matches: (actual) => actual === value });
              return range;
            },
            gt(field, value) {
              conditions.push({ field, matches: (actual) => typeof actual === 'string' && actual > value });
              return range;
            },
            lt(field, value) {
              conditions.push({ field, matches: (actual) => typeof actual === 'string' && actual < value });
              return range;
            },
          };
          buildRange(range);
          // Like Convex, accept only an index the schema declares, ranged over a prefix of its fields in order.
          const index = schema.tables[table][' indexes']().find((item) => item.indexDescriptor === indexName);
          if (!index) throw new Error(`Unknown index ${table}.${indexName}`);
          conditions.forEach(({ field }, position) => {
            if (index.fields[position] !== field) throw new Error(`${table}.${indexName} cannot range on ${field}`);
          });
          let docs = [...getTable(table).values()].filter((doc) =>
            conditions.every(({ field, matches }) => matches(doc[field])),
          );
          const record = (rows: number) => indexReads.push({ table, index: indexName, rows });

          const query: IndexedQuery = {
            order(direction) {
              const factor = direction === 'asc' ? 1 : -1;
              docs = docs.sort((left, right) => factor * (Number(left._creationTime) - Number(right._creationTime)));
              return query;
            },
            take(count) {
              const taken = docs.slice(0, count);
              record(taken.length);
              return taken;
            },
            first() {
              record(Math.min(docs.length, 1));
              return docs[0] ?? null;
            },
            unique() {
              if (docs.length > 1) throw new Error(`Expected a unique document in ${indexName}`);
              record(docs.length);
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
      lastCreationTime = Math.max(Date.now(), lastCreationTime + 1);
      getTable(table).set(id, { ...value, _id: id, _creationTime: lastCreationTime });
      writes.push({ table, operation: 'insert', id });
      return id;
    },
    async patch(id, value) {
      const table = tableOf(id);
      counts.patches += 1;
      const doc = getTable(table).get(id);
      getTable(table).set(id, { ...doc, ...value, _id: id, _creationTime: Number(doc?._creationTime) });
      writes.push({ table, operation: 'patch', id });
    },
    async delete(id) {
      const table = tableOf(id);
      counts.deletes += 1;
      getTable(table).delete(id);
      writes.push({ table, operation: 'delete', id });
    },
  };

  return {
    db,
    counts,
    writes,
    indexReads,
    read(table, id) {
      return getTable(table).get(id) ?? null;
    },
    rows(table) {
      return [...getTable(table).values()];
    },
    seed(table, doc) {
      getTable(table).set(doc._id, doc);
    },
  };
}

export async function invokeHandler(registeredFunction: unknown, ctx: TestContext, args: unknown): Promise<unknown> {
  if (typeof registeredFunction !== 'function') throw new Error('Convex function is not registered');
  const handler = Reflect.get(registeredFunction, '_handler');
  if (typeof handler !== 'function') throw new Error('Convex function handler is unavailable');
  return Reflect.apply(handler, undefined, [ctx, args]);
}
