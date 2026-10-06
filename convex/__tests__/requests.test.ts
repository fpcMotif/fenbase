import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeOrganization } from '../fixtures';
import { create, get, list, remove, update } from '../requests';
import { createContext, invokeHandler, type TestContext, type TestDoc } from './helpers';

const auth = vi.hoisted(() => ({ currentUser: null as string | null }));

vi.mock('../auth', () => ({
  requireUser: async () => {
    if (auth.currentUser === null) throw new ConvexError('Unauthenticated');
    return auth.currentUser;
  },
}));

const ORG_1 = 'organizations:1';
const ORG_2 = 'organizations:2';
const APP_1 = 'applications:1';
const APP_2 = 'applications:2';
const APP_Z = 'applications:z';
const V1 = 'applicationDefinitionVersions:v1';
const V2 = 'applicationDefinitionVersions:v2';
const V_APP_2 = 'applicationDefinitionVersions:app2';
const V_Z = 'applicationDefinitionVersions:z';

const leaveFields = [
  { type: 'date', key: 'startDate', label: { enUS: 'Start date', zhCN: '开始日期' }, required: true },
  { type: 'date', key: 'endDate', label: { enUS: 'End date', zhCN: '结束日期' }, required: true },
  {
    type: 'number',
    key: 'days',
    label: { enUS: 'Days', zhCN: '天数' },
    required: true,
    min: 1,
    max: 366,
    integer: true,
  },
  { type: 'text', key: 'reason', label: { enUS: 'Reason', zhCN: '原因' }, required: true, maxLength: 1000 },
];
const noteField = { type: 'text', key: 'note', label: { enUS: 'Note', zhCN: '备注' }, required: false, maxLength: 500 };

type Preset = 'requesterAndAssignedReviewer' | 'requesterAssignedReviewerAndReaders';

function leaveDefinition(preset: Preset = 'requesterAndAssignedReviewer', withNote = false) {
  return {
    fields: withNote ? [...leaveFields, noteField] : leaveFields,
    listColumns: withNote ? ['requester', 'startDate', 'days', 'note'] : ['requester', 'startDate', 'days'],
    dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
    policyPreset: preset,
    reviewerMembershipId: 'memberships:b',
  };
}

function membership(
  id: string,
  authUserId: string,
  grants: string[],
  options: { applicationId?: string; organizationId?: string; status?: 'active' | 'inactive' } = {},
): TestDoc {
  return {
    _id: `memberships:${id}`,
    _creationTime: 1,
    authUserId,
    applicationId: options.applicationId ?? APP_1,
    organizationId: options.organizationId ?? ORG_1,
    status: options.status ?? 'active',
    grants,
    updatedAt: 1,
  };
}

function versionRow(id: string, applicationId: string, organizationId: string, version: number, definition: unknown) {
  return {
    _id: id,
    _creationTime: version,
    applicationId,
    organizationId,
    version,
    definition,
    sourceRevision: version,
    publishedAt: version,
    publishedByMembershipId: 'memberships:c',
  };
}

function headRow(id: string, applicationId: string, organizationId: string, currentVersionId: string | null) {
  return {
    _id: id,
    _creationTime: 1,
    applicationId,
    organizationId,
    draft: leaveDefinition(),
    revision: 2,
    publishedRevision: 2,
    currentVersionId,
    latestVersion: currentVersionId ? 1 : 0,
    updatedAt: 1,
    updatedByMembershipId: 'memberships:c',
  };
}

function fixtureContext(options: { app1Preset?: Preset; app1Published?: boolean } = {}): TestContext {
  const published = options.app1Published ?? true;
  return createContext({
    organizations: [
      { _id: ORG_1, _creationTime: 1, key: 'fixture-org-1', name: 'Fixture Org One' },
      { _id: ORG_2, _creationTime: 1, key: 'fixture-org-2', name: 'Fixture Org Two' },
    ],
    applications: [
      { _id: APP_1, _creationTime: 1, organizationId: ORG_1, key: 'leaveRequests', name: 'Leave requests' },
      { _id: APP_2, _creationTime: 1, organizationId: ORG_1, key: 'expenseClaims', name: 'Expense claims' },
      { _id: APP_Z, _creationTime: 1, organizationId: ORG_2, key: 'leaveRequests', name: 'Leave requests' },
    ],
    memberships: [
      membership('a', 'user-a', ['submitRequests']),
      membership('a2', 'user-a2', ['submitRequests']),
      membership('b', 'user-b', ['submitRequests', 'reviewRequests']),
      membership('c', 'user-c', ['configureApplication']),
      membership('r', 'user-r', ['readApplicationRecords']),
      membership('n', 'user-n', []),
      membership('i', 'user-i', ['submitRequests'], { status: 'inactive' }),
      membership('a-app2', 'user-a', ['submitRequests'], { applicationId: APP_2 }),
      membership('z', 'user-z', ['submitRequests', 'readApplicationRecords'], {
        applicationId: APP_Z,
        organizationId: ORG_2,
      }),
    ],
    applicationDefinitions: [
      headRow('applicationDefinitions:1', APP_1, ORG_1, published ? V1 : null),
      headRow('applicationDefinitions:2', APP_2, ORG_1, V_APP_2),
      headRow('applicationDefinitions:z', APP_Z, ORG_2, V_Z),
    ],
    applicationDefinitionVersions: [
      ...(published ? [versionRow(V1, APP_1, ORG_1, 1, leaveDefinition(options.app1Preset))] : []),
      versionRow(V_APP_2, APP_2, ORG_1, 1, leaveDefinition()),
      versionRow(V_Z, APP_Z, ORG_2, 1, leaveDefinition('requesterAssignedReviewerAndReaders')),
    ],
  });
}

const leave = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Family visit' };

function signIn(authUserId: string | null): void {
  auth.currentUser = authUserId;
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  return typeof data === 'object' && data !== null ? { ...data } : undefined;
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

async function expectCode(operation: Promise<unknown>, code: string, extra: Record<string, unknown> = {}) {
  const error = await rejection(operation);
  expect(error, `expected ${code}`).toBeInstanceOf(ConvexError);
  expect(errorData(error)).toMatchObject({ code, ...extra });
}

function snapshot(ctx: TestContext): string {
  return JSON.stringify(ctx.rows('requests'));
}

async function expectRejectedWithoutWrites(
  ctx: TestContext,
  operation: () => Promise<unknown>,
  code: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const before = snapshot(ctx);
  const writesBefore = ctx.writes.length;
  await expectCode(operation(), code, extra);
  expect(ctx.writes.slice(writesBefore)).toEqual([]);
  expect(snapshot(ctx)).toBe(before);
}

let operationCounter = 0;
function nextOperationId(): string {
  operationCounter += 1;
  return `op-${String(operationCounter).padStart(6, '0')}`;
}

type Created = { requestId: string; revision: number; version: number; created: boolean };

function createAs(
  ctx: TestContext,
  user: string,
  values: Record<string, unknown> = leave,
  options: { applicationId?: string; definitionVersionId?: string; operationId?: string } = {},
) {
  signIn(user);
  return invokeHandler(create, ctx, {
    applicationId: options.applicationId ?? APP_1,
    definitionVersionId: options.definitionVersionId ?? V1,
    operationId: options.operationId ?? nextOperationId(),
    values,
  }) as Promise<Created>;
}

function updateAs(
  ctx: TestContext,
  user: string,
  requestId: string,
  expectedRevision: number,
  values: Record<string, unknown>,
) {
  signIn(user);
  return invokeHandler(update, ctx, { applicationId: APP_1, requestId, expectedRevision, values }) as Promise<{
    revision: number;
  }>;
}

function removeAs(ctx: TestContext, user: string, requestId: string, expectedRevision: number) {
  signIn(user);
  return invokeHandler(remove, ctx, { applicationId: APP_1, requestId, expectedRevision });
}

type View = {
  _id: string;
  version: number;
  versionId: string;
  revision: number;
  state: string;
  values: Record<string, unknown>;
  requester: { membershipId: string; isMe: boolean };
  canEdit: boolean;
};
type ListResult = { items: View[]; total: number; page: number; pageSize: number; pageCount: number; scope: string };

function getAs(ctx: TestContext, user: string, requestId: string, applicationId = APP_1) {
  signIn(user);
  return invokeHandler(get, ctx, { applicationId, requestId }) as Promise<View | null>;
}

function listAs(ctx: TestContext, user: string, query: Record<string, unknown> = {}, applicationId = APP_1) {
  signIn(user);
  return invokeHandler(list, ctx, { applicationId, ...query }) as Promise<ListResult>;
}

function argKeys(registered: unknown): string[] {
  const exportArgs = Reflect.get(registered as object, 'exportArgs');
  const parsed = JSON.parse((exportArgs as () => string)()) as { type: string; value: Record<string, unknown> };
  expect(parsed.type).toBe('object');
  return Object.keys(parsed.value).sort();
}

beforeEach(() => signIn(null));

describe('request argument contract', () => {
  it('accepts only the documented top-level arguments, so server-owned fields cannot be sent', () => {
    expect(argKeys(create)).toEqual(['applicationId', 'definitionVersionId', 'operationId', 'values']);
    expect(argKeys(update)).toEqual(['applicationId', 'expectedRevision', 'requestId', 'values']);
    expect(argKeys(remove)).toEqual(['applicationId', 'expectedRevision', 'requestId']);
    expect(argKeys(get)).toEqual(['applicationId', 'requestId']);
    expect(argKeys(list)).toEqual(['applicationId', 'filters', 'page', 'pageSize', 'sort']);
  });
});

describe('creating a request', () => {
  it('derives requester, organization, version, policy and state on the server', async () => {
    const ctx = fixtureContext();
    const created = await createAs(ctx, 'user-a');
    expect(created).toMatchObject({ revision: 1, version: 1, created: true });
    const [row] = ctx.rows('requests');
    expect(row).toMatchObject({
      applicationId: APP_1,
      organizationId: ORG_1,
      requesterMembershipId: 'memberships:a',
      definitionVersionId: V1,
      version: 1,
      policyPreset: 'requesterAndAssignedReviewer',
      state: 'draft',
      revision: 1,
      values: leave,
    });
    expect(typeof row.operationFingerprint).toBe('string');
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ['a server-owned state value', { ...leave, state: 'approved' }, 'RECORD_FIELD_SERVER_OWNED', { field: 'state' }],
    [
      'a reviewer assignment',
      { ...leave, reviewerMembershipId: 'memberships:b' },
      'RECORD_FIELD_SERVER_OWNED',
      { field: 'reviewerMembershipId' },
    ],
    [
      'a forged requester',
      { ...leave, requester: 'memberships:b' },
      'RECORD_FIELD_SERVER_OWNED',
      { field: 'requester' },
    ],
    ['an unknown key', { ...leave, approvedBy: 'me' }, 'RECORD_FIELD_UNKNOWN', { field: 'approvedBy' }],
    [
      'a missing required field',
      { startDate: '2026-03-02', endDate: '2026-03-04', days: 3 },
      'RECORD_FIELD_REQUIRED',
      { field: 'reason' },
    ],
    ['a mistyped number', { ...leave, days: '3' }, 'RECORD_FIELD_TYPE_INVALID', { field: 'days' }],
    [
      'an oversized text',
      { ...leave, reason: 'x'.repeat(1001) },
      'RECORD_TEXT_TOO_LONG',
      { field: 'reason', maxLength: 1000 },
    ],
    ['an out-of-range number', { ...leave, days: 400 }, 'RECORD_NUMBER_OUT_OF_RANGE', { min: 1, max: 366 }],
    ['an invalid date', { ...leave, startDate: '2026-02-29' }, 'RECORD_DATE_INVALID', { field: 'startDate' }],
    ['a reversed range', { ...leave, endDate: '2026-03-01' }, 'RECORD_DATE_RANGE_INVALID', { field: 'endDate' }],
    ["V2's optional key on V1", { ...leave, note: 'hello' }, 'RECORD_FIELD_UNKNOWN', { field: 'note' }],
  ])('rejects %s without a write', async (_label, values, code, extra) => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-a', values), code, extra);
  });

  it('requires submitRequests and an active membership in this organization', async () => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-n'), 'PERMISSION_DENIED');
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-c'), 'PERMISSION_DENIED');
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-r'), 'PERMISSION_DENIED');
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-i'), 'APPLICATION_ACCESS_DENIED');
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-z'), 'APPLICATION_ACCESS_DENIED');
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-nobody'), 'APPLICATION_ACCESS_DENIED');
    signIn(null);
    await expect(
      invokeHandler(create, ctx, {
        applicationId: APP_1,
        definitionVersionId: V1,
        operationId: 'op-anon-1',
        values: leave,
      }),
    ).rejects.toThrow('Unauthenticated');
    expect(ctx.rows('requests')).toEqual([]);
  });

  it('rejects a malformed operation id', async () => {
    const ctx = fixtureContext();
    for (const operationId of ['short', 'has space here', 'x'.repeat(65), 'semi;colon-id']) {
      await expectRejectedWithoutWrites(
        ctx,
        () => createAs(ctx, 'user-a', leave, { operationId }),
        'RECORD_OPERATION_ID_INVALID',
      );
    }
  });

  it('refuses an application without a published definition and a version from elsewhere', async () => {
    const unpublished = fixtureContext({ app1Published: false });
    await expectRejectedWithoutWrites(unpublished, () => createAs(unpublished, 'user-a'), 'DEFINITION_NOT_FOUND');

    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(
      ctx,
      () => createAs(ctx, 'user-a', leave, { definitionVersionId: V_APP_2 }),
      'RECORD_DEFINITION_OUTDATED',
      { currentVersionId: V1 },
    );
  });

  it('returns the original request for a repeated operation id and rejects a reused id with a new payload', async () => {
    const ctx = fixtureContext();
    const first = await createAs(ctx, 'user-a', leave, { operationId: 'retry-0001' });
    const reordered = { reason: leave.reason, days: leave.days, endDate: leave.endDate, startDate: leave.startDate };
    const writesBefore = ctx.writes.length;
    const replay = await createAs(ctx, 'user-a', reordered, { operationId: 'retry-0001' });
    expect(replay).toEqual({ ...first, created: false });
    expect(ctx.writes.length).toBe(writesBefore);

    await expectRejectedWithoutWrites(
      ctx,
      () => createAs(ctx, 'user-a', { ...leave, days: 2 }, { operationId: 'retry-0001' }),
      'RECORD_OPERATION_CONFLICT',
    );

    const other = await createAs(ctx, 'user-a2', leave, { operationId: 'retry-0001' });
    expect(other.created).toBe(true);
    expect(other.requestId).not.toBe(first.requestId);
    expect(ctx.rows('requests')).toHaveLength(2);
  });

  it('pins new requests to the current version and asks the client to reload an outdated form', async () => {
    const ctx = fixtureContext();
    const v1Request = await createAs(ctx, 'user-a');
    await seedV2(ctx);

    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-a'), 'RECORD_DEFINITION_OUTDATED', {
      currentVersionId: V2,
    });
    const v2Request = await createAs(ctx, 'user-a', { ...leave, note: 'Back Monday' }, { definitionVersionId: V2 });
    expect(v2Request).toMatchObject({ version: 2, created: true });
    expect(ctx.read('requests', v2Request.requestId)).toMatchObject({ definitionVersionId: V2, version: 2 });

    // The V1 request keeps validating against V1, so it cannot gain V2's optional key.
    await expectRejectedWithoutWrites(
      ctx,
      () => updateAs(ctx, 'user-a', v1Request.requestId, 1, { ...leave, note: 'x' }),
      'RECORD_FIELD_UNKNOWN',
      { field: 'note' },
    );
    expect(await getAs(ctx, 'user-a', v1Request.requestId)).toMatchObject({ version: 1, versionId: V1, values: leave });
  });

  it('stores a blank optional value as absent, on create and on update', async () => {
    const ctx = fixtureContext();
    await seedV2(ctx);
    const created = await createAs(
      ctx,
      'user-a',
      { ...leave, note: '   ' },
      { definitionVersionId: V2, operationId: 'blank-0001' },
    );
    expect(ctx.read('requests', created.requestId)?.values).toEqual(leave);

    const replay = await createAs(ctx, 'user-a', leave, { definitionVersionId: V2, operationId: 'blank-0001' });
    expect(replay).toEqual({ ...created, created: false });

    const writesBefore = ctx.writes.length;
    expect(await updateAs(ctx, 'user-a', created.requestId, 1, { ...leave, note: '' })).toEqual({ revision: 1 });
    expect(ctx.writes.length).toBe(writesBefore);
  });

  it('caps an application at 1000 requests', async () => {
    const ctx = fixtureContext();
    for (let index = 0; index < 1000; index += 1) {
      await ctx.db.insert('requests', requestDoc(`seed-${index}`, 'memberships:a2'));
    }
    await expectRejectedWithoutWrites(ctx, () => createAs(ctx, 'user-a'), 'RECORD_APPLICATION_FULL');
  });
});

function requestDoc(operationId: string, requesterMembershipId: string, values: Record<string, unknown> = leave) {
  return {
    applicationId: APP_1,
    organizationId: ORG_1,
    requesterMembershipId,
    definitionVersionId: V1,
    version: 1,
    policyPreset: 'requesterAndAssignedReviewer',
    state: 'draft',
    revision: 1,
    operationId,
    operationFingerprint: `fingerprint-${operationId}`,
    values,
    updatedAt: 1,
  };
}

async function seedV2(ctx: TestContext, preset: Preset = 'requesterAndAssignedReviewer'): Promise<void> {
  ctx.seed('applicationDefinitionVersions', versionRow(V2, APP_1, ORG_1, 2, leaveDefinition(preset, true)));
  await ctx.db.patch('applicationDefinitions:1', { currentVersionId: V2, latestVersion: 2 });
}

describe('editing and deleting a draft', () => {
  it('replaces values with the expected revision and keeps the revision for an unchanged save', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    expect(await updateAs(ctx, 'user-a', requestId, 1, { ...leave, days: 2 })).toEqual({ revision: 2 });
    expect(ctx.read('requests', requestId)).toMatchObject({ revision: 2, values: { ...leave, days: 2 } });

    const writesBefore = ctx.writes.length;
    expect(await updateAs(ctx, 'user-a', requestId, 2, { ...leave, days: 2 })).toEqual({ revision: 2 });
    expect(ctx.writes.length).toBe(writesBefore);
  });

  it('rejects a stale revision with the current revision and writes nothing', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    await updateAs(ctx, 'user-a', requestId, 1, { ...leave, days: 2 });
    await expectRejectedWithoutWrites(
      ctx,
      () => updateAs(ctx, 'user-a', requestId, 1, { ...leave, days: 4 }),
      'RECORD_REVISION_CONFLICT',
      { currentRevision: 2 },
    );
    await expectRejectedWithoutWrites(ctx, () => removeAs(ctx, 'user-a', requestId, 1), 'RECORD_REVISION_CONFLICT', {
      currentRevision: 2,
    });
  });

  it('rejects state, reviewer and invalid values in an update without a partial write', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    for (const values of [
      { ...leave, state: 'approved' },
      { ...leave, reviewer: 'memberships:b' },
      { ...leave, days: 2, endDate: '2026-03-01' },
      { ...leave, days: 2, reason: '' },
    ]) {
      const before = snapshot(ctx);
      await expect(updateAs(ctx, 'user-a', requestId, 1, values)).rejects.toBeInstanceOf(ConvexError);
      expect(snapshot(ctx)).toBe(before);
    }
  });

  it('hides other people’s drafts from update and delete behind the same not-found code', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    await expectRejectedWithoutWrites(ctx, () => updateAs(ctx, 'user-a2', requestId, 1, leave), 'RECORD_NOT_FOUND');
    await expectRejectedWithoutWrites(ctx, () => removeAs(ctx, 'user-b', requestId, 1), 'RECORD_NOT_FOUND');
    await expectRejectedWithoutWrites(ctx, () => removeAs(ctx, 'user-r', requestId, 1), 'RECORD_NOT_FOUND');
    await expectRejectedWithoutWrites(ctx, () => removeAs(ctx, 'user-z', requestId, 1), 'APPLICATION_ACCESS_DENIED');
    signIn('user-a');
    await expectRejectedWithoutWrites(
      ctx,
      () => invokeHandler(remove, ctx, { applicationId: APP_2, requestId, expectedRevision: 1 }),
      'RECORD_NOT_FOUND',
    );
    await expectRejectedWithoutWrites(ctx, () => removeAs(ctx, 'user-a', 'requests:missing', 1), 'RECORD_NOT_FOUND');
  });

  it('stops edits after submitRequests is revoked but keeps the draft readable', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    await ctx.db.patch('memberships:a', { grants: [] });
    await expectRejectedWithoutWrites(ctx, () => updateAs(ctx, 'user-a', requestId, 1, leave), 'PERMISSION_DENIED');
    expect(await getAs(ctx, 'user-a', requestId)).toMatchObject({ canEdit: false });
  });

  it('deletes with the expected revision', async () => {
    const ctx = fixtureContext();
    const { requestId } = await createAs(ctx, 'user-a');
    await removeAs(ctx, 'user-a', requestId, 1);
    expect(ctx.rows('requests')).toEqual([]);
    expect(await getAs(ctx, 'user-a', requestId)).toBeNull();
  });
});

describe('reading requests', () => {
  it('shows the requester only their own requests and returns null for anyone else’s', async () => {
    const ctx = fixtureContext();
    const mine = await createAs(ctx, 'user-a');
    await createAs(ctx, 'user-a2');
    expect(await getAs(ctx, 'user-a', mine.requestId)).toMatchObject({
      _id: mine.requestId,
      version: 1,
      revision: 1,
      state: 'draft',
      values: leave,
      requester: { membershipId: 'memberships:a', isMe: true },
      canEdit: true,
    });
    const view = await getAs(ctx, 'user-a', mine.requestId);
    expect(view).not.toHaveProperty('organizationId');
    expect(view).not.toHaveProperty('policyPreset');

    for (const user of ['user-a2', 'user-b', 'user-r', 'user-c']) {
      expect(await getAs(ctx, user, mine.requestId), user).toBeNull();
    }
    expect(await getAs(ctx, 'user-a', mine.requestId, APP_2)).toBeNull();
    signIn('user-z');
    await expectCode(
      invokeHandler(get, ctx, { applicationId: APP_1, requestId: mine.requestId }),
      'APPLICATION_ACCESS_DENIED',
    );

    const page = await listAs(ctx, 'user-a');
    expect(page).toMatchObject({ total: 1, scope: 'own' });
    expect(page.items.map((item) => item._id)).toEqual([mine.requestId]);
    expect(await listAs(ctx, 'user-b')).toMatchObject({ total: 0, items: [] });
    expect(await listAs(ctx, 'user-r')).toMatchObject({ total: 0, items: [], scope: 'application' });
  });

  it('lets readApplicationRecords read every request only under the readers preset, per pinned version', async () => {
    const ctx = fixtureContext({ app1Preset: 'requesterAssignedReviewerAndReaders' });
    const first = await createAs(ctx, 'user-a');
    await createAs(ctx, 'user-a2');
    const readerView = await getAs(ctx, 'user-r', first.requestId);
    expect(readerView).toMatchObject({ requester: { membershipId: 'memberships:a', isMe: false }, canEdit: false });
    expect(await listAs(ctx, 'user-r')).toMatchObject({ total: 2, scope: 'application' });
    expect(await listAs(ctx, 'user-b')).toMatchObject({ total: 0 });

    // V2 switches to the narrower preset: V1 requests keep their readers, V2 requests do not get them.
    await seedV2(ctx, 'requesterAndAssignedReviewer');
    const v2 = await createAs(ctx, 'user-a', leave, { definitionVersionId: V2 });
    expect(await getAs(ctx, 'user-r', v2.requestId)).toBeNull();
    const readable = await listAs(ctx, 'user-r');
    expect(readable.total).toBe(2);
    expect(readable.items.map((item) => item._id)).not.toContain(v2.requestId);
  });

  it('keeps a second organization apart even when it holds the same grants', async () => {
    const ctx = fixtureContext();
    await createAs(ctx, 'user-a');
    const foreign = await createAs(ctx, 'user-z', leave, { applicationId: APP_Z, definitionVersionId: V_Z });
    expect(await listAs(ctx, 'user-z', {}, APP_Z)).toMatchObject({ total: 1, scope: 'application' });
    expect(await getAs(ctx, 'user-a', foreign.requestId)).toBeNull();
    signIn('user-a');
    await expectCode(invokeHandler(list, ctx, { applicationId: APP_Z }), 'APPLICATION_ACCESS_DENIED');
  });

  it('filters before paging, so every authorized request appears exactly once across pages', async () => {
    const ctx = fixtureContext();
    for (let index = 1; index <= 25; index += 1) {
      const day = String(index).padStart(2, '0');
      await createAs(ctx, 'user-a', { ...leave, startDate: `2026-05-${day}`, endDate: `2026-05-${day}`, days: index });
      // Another member's requests sit between A's rows and must never fill A's pages.
      await createAs(ctx, 'user-a2', { ...leave, days: index });
    }
    const seen: string[] = [];
    let total = 0;
    for (let page = 1; page <= 3; page += 1) {
      const result = await listAs(ctx, 'user-a', { page, pageSize: 10, sort: { field: 'days', direction: 'asc' } });
      total = result.total;
      seen.push(...result.items.map((item) => String(item.values.days)));
    }
    expect(total).toBe(25);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, index) => String(index + 1)));

    const clamped = await listAs(ctx, 'user-a', { page: 9, pageSize: 10 });
    expect(clamped).toMatchObject({ page: 3, pageCount: 3 });
    expect(clamped.items).toHaveLength(5);

    const filtered = await listAs(ctx, 'user-a', {
      filters: [{ field: 'startDate', operator: '$gte', value: '2026-05-21' }],
      sort: { field: 'days', direction: 'desc' },
      pageSize: 2,
    });
    expect(filtered).toMatchObject({ total: 5, pageCount: 3 });
    expect(filtered.items.map((item) => item.values.days)).toEqual([25, 24]);
  });

  it('validates filters against the current published version', async () => {
    const ctx = fixtureContext();
    signIn('user-a');
    await expectCode(
      invokeHandler(list, ctx, { applicationId: APP_1, filters: [{ field: 'note', operator: '$notEmpty' }] }),
      'RECORD_QUERY_FIELD_UNKNOWN',
    );
    await expectCode(
      invokeHandler(list, ctx, {
        applicationId: APP_1,
        filters: [{ field: 'startDate', operator: '$gte', value: '2026-02-30' }],
      }),
      'RECORD_QUERY_VALUE_INVALID',
    );
    await expectCode(invokeHandler(list, ctx, { applicationId: APP_1, pageSize: 101 }), 'RECORD_QUERY_PAGE_INVALID');
    await seedV2(ctx);
    expect(await listAs(ctx, 'user-a', { filters: [{ field: 'note', operator: '$empty' }] })).toMatchObject({
      total: 0,
    });
  });

  it('refuses to browse more than 1000 readable requests instead of truncating', async () => {
    const ctx = fixtureContext();
    for (let index = 0; index < 1001; index += 1) {
      await ctx.db.insert('requests', requestDoc(`bulk-${index}`, 'memberships:a'));
    }
    signIn('user-a');
    await expectCode(invokeHandler(list, ctx, { applicationId: APP_1 }), 'RECORD_BROWSE_LIMIT_EXCEEDED');
  });
});

describe('fixture cleanup', () => {
  it('removes requests with their organization and leaves other organizations intact', async () => {
    const ctx = fixtureContext();
    await createAs(ctx, 'user-a');
    await createAs(ctx, 'user-a2');
    await createAs(ctx, 'user-z', leave, { applicationId: APP_Z, definitionVersionId: V_Z });
    const removed = await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-1' });
    expect(removed).toMatchObject({ organizations: 1, applications: 2, requests: 2 });
    expect(ctx.rows('requests').map((row) => row.applicationId)).toEqual([APP_Z]);
  });
});
