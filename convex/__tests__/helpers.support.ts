import { getFunctionName, type FunctionReference } from 'convex/server';
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
  | 'requestCounts'
  | 'reviewTasks'
  | 'requestEvents'
  | 'requestAttachments'
  | 'attachmentEvents';

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

export type StoredFile = { _id: string; _creationTime: number; sha256: string; size: number; contentType?: string };

interface StoragePaginator {
  paginate(options: { cursor: string | null; numItems: number }): Promise<{
    page: StoredFile[];
    isDone: boolean;
    continueCursor: string;
  }>;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
    system: {
      get(tableOrId: string, maybeId?: string): Promise<StoredFile | null>;
      query(table: '_storage'): { order(direction: 'asc' | 'desc'): StoragePaginator };
    };
  };
  storage: {
    store(blob: Blob, options?: { sha256?: string }): Promise<string>;
    get(storageId: string): Promise<Blob | null>;
    delete(storageId: string): Promise<void>;
    getUrl(storageId: string): Promise<string | null>;
  };
  scheduler: { runAfter(delayMs: number, functionReference: unknown, args: unknown): Promise<string> };
  scheduled: Array<{ delayMs: number; name: string; args: unknown }>;
  // Tests age a blob or change its stored bytes through this map, the way a crash or a corrupt disk would.
  files: Map<string, StoredFile & { bytes: Uint8Array }>;
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
    'reviewTasks',
    'requestEvents',
    'requestAttachments',
    'attachmentEvents',
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
    system: {
      async get(tableOrId, maybeId) {
        const file = files.get(maybeId ?? tableOrId);
        if (!file) return null;
        const { bytes: _bytes, ...metadata } = file;
        return metadata;
      },
      query() {
        let direction: 'asc' | 'desc' = 'asc';
        const paginator: StoragePaginator = {
          async paginate({ cursor, numItems }) {
            const all = [...files.values()].sort(
              (left, right) => (direction === 'asc' ? 1 : -1) * (left._creationTime - right._creationTime),
            );
            const start = cursor === null ? 0 : Number(cursor);
            const page = all.slice(start, start + numItems).map(({ bytes: _bytes, ...metadata }) => metadata);
            const end = start + page.length;
            return { page, isDone: end >= all.length, continueCursor: String(end) };
          },
        };
        return {
          order(next) {
            direction = next;
            return paginator;
          },
        };
      },
    },
  };

  const files: TestContext['files'] = new Map();
  let nextFileId = 1;
  const storage: TestContext['storage'] = {
    async store(blob, options) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await digestHex(bytes);
      if (options?.sha256 !== undefined && options.sha256 !== sha256) throw new Error('sha256 mismatch');
      const id = `_storage:${nextFileId++}`;
      lastCreationTime = Math.max(Date.now(), lastCreationTime + 1);
      files.set(id, { _id: id, _creationTime: lastCreationTime, sha256, size: bytes.byteLength, bytes });
      return id;
    },
    async get(storageId) {
      const file = files.get(storageId);
      return file ? new Blob([file.bytes.slice()]) : null;
    },
    async delete(storageId) {
      if (!files.delete(storageId)) throw new Error(`Storage file not found: ${storageId}`);
    },
    async getUrl() {
      throw new Error('Attachments must never be served through storage URLs');
    },
  };

  const scheduled: TestContext['scheduled'] = [];
  const scheduler: TestContext['scheduler'] = {
    async runAfter(delayMs, functionReference, args) {
      scheduled.push({ delayMs, name: functionName(functionReference), args });
      return `_scheduled_functions:${scheduled.length}`;
    },
  };

  return {
    db,
    storage,
    scheduler,
    scheduled,
    files,
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

function functionName(functionReference: unknown): string {
  return getFunctionName(functionReference as FunctionReference<'query' | 'mutation' | 'action'>);
}

export type ActionTestContext = Pick<TestContext, 'storage' | 'scheduler'> & {
  runQuery(functionReference: unknown, args: unknown): Promise<unknown>;
  runMutation(functionReference: unknown, args: unknown): Promise<unknown>;
};

// An action context whose `runQuery` and `runMutation` call the registered handlers by name, such as
// `requestAttachments:attach`, against the same in-memory tables and storage.
export function createActionContext(ctx: TestContext, registry: Record<string, unknown>): ActionTestContext {
  const run = (functionReference: unknown, args: unknown) => {
    const name = functionName(functionReference);
    if (!(name in registry)) throw new Error(`No test handler registered for ${name}`);
    const entry = registry[name];
    // A plain function stands in for a handler, such as one that fails the way a crashed mutation would.
    if (typeof entry === 'function' && Reflect.get(entry, '_handler') === undefined) {
      return Promise.resolve(Reflect.apply(entry, undefined, [args]));
    }
    return invokeHandler(entry, ctx, args);
  };
  return { storage: ctx.storage, scheduler: ctx.scheduler, runQuery: run, runMutation: run };
}

export async function invokeHandler(
  registeredFunction: unknown,
  ctx: TestContext | ActionTestContext,
  args: unknown,
): Promise<unknown> {
  if (typeof registeredFunction !== 'function') throw new Error('Convex function is not registered');
  const handler = Reflect.get(registeredFunction, '_handler');
  if (typeof handler !== 'function') throw new Error('Convex function handler is unavailable');
  return Reflect.apply(handler, undefined, [ctx, args]);
}
