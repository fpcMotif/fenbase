import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuilderState, getPublishedVersion, publish, saveDraft } from '../applicationDefinitions';
import { removeOrganization } from '../fixtures';
import { createContext, invokeHandler, type TestContext, type TestDoc } from './helpers.support';

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

function fixtureContext(versions: TestDoc[] = []): TestContext {
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
      membership('b', 'user-b', ['submitRequests', 'reviewRequests']),
      membership('c', 'user-c', ['submitRequests', 'reviewRequests']),
      membership('d', 'user-d', ['configureApplication']),
      membership('e', 'user-e', ['configureApplication']),
      membership('i', 'user-i', ['reviewRequests'], { status: 'inactive' }),
      membership('b2', 'user-b', ['reviewRequests', 'configureApplication'], { applicationId: APP_2 }),
      membership('z', 'user-z', ['configureApplication', 'reviewRequests'], {
        applicationId: APP_Z,
        organizationId: ORG_2,
      }),
    ],
    applicationDefinitionVersions: versions,
  });
}

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

type DefinitionInput = {
  fields: unknown[];
  listColumns: string[];
  dateRules: Array<{ startKey: string; endKey: string }>;
  policyPreset: string;
  reviewerMembershipId: string;
};

function leave(overrides: Partial<DefinitionInput> = {}): DefinitionInput {
  return {
    fields: leaveFields,
    listColumns: ['startDate', 'endDate', 'days', 'reason'],
    dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
    policyPreset: 'requesterAndAssignedReviewer',
    reviewerMembershipId: 'memberships:b',
    ...overrides,
  };
}

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

async function expectCode(
  operation: Promise<unknown>,
  code: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const error = await rejection(operation);
  expect(error, `expected ${code}`).toBeInstanceOf(ConvexError);
  expect(errorData(error)).toMatchObject({ code, ...extra });
}

function save(ctx: TestContext, user: string, expectedRevision: number, definition: unknown, applicationId = APP_1) {
  signIn(user);
  return invokeHandler(saveDraft, ctx, { applicationId, expectedRevision, definition });
}

function publishAs(ctx: TestContext, user: string, expectedRevision: number, applicationId = APP_1) {
  signIn(user);
  return invokeHandler(publish, ctx, { applicationId, expectedRevision });
}

function snapshotTables(ctx: TestContext) {
  return JSON.stringify({
    heads: ctx.rows('applicationDefinitions'),
    versions: ctx.rows('applicationDefinitionVersions'),
  });
}

async function expectRejectedWithoutWrites(
  ctx: TestContext,
  operation: () => Promise<unknown>,
  code: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const before = snapshotTables(ctx);
  const writesBefore = ctx.writes.length;
  await expectCode(operation(), code, extra);
  expect(ctx.writes.slice(writesBefore)).toEqual([]);
  expect(snapshotTables(ctx)).toBe(before);
}

function head(ctx: TestContext): TestDoc {
  const [row] = ctx.rows('applicationDefinitions').filter((doc) => doc.applicationId === APP_1);
  expect(row).toBeDefined();
  return row;
}

beforeEach(() => signIn(null));

describe('definition authorization', () => {
  it('rejects saves and publishes by members without configureApplication before any write', async () => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-a', 0, leave()), 'PERMISSION_DENIED');
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-b', 0, leave()), 'PERMISSION_DENIED');
    await save(ctx, 'user-d', 0, leave());
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-a', 1), 'PERMISSION_DENIED');
  });

  it('rejects outsiders, inactive members and anonymous callers with the shared denial', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-z', 1, leave()), 'APPLICATION_ACCESS_DENIED');
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-z', 1), 'APPLICATION_ACCESS_DENIED');
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-i', 1), 'APPLICATION_ACCESS_DENIED');
    signIn(null);
    await expect(invokeHandler(publish, ctx, { applicationId: APP_1, expectedRevision: 1 })).rejects.toThrow(
      'Unauthenticated',
    );
  });

  it('limits the builder state to configureApplication and published versions to active members', async () => {
    const ctx = fixtureContext();
    signIn('user-a');
    await expectCode(invokeHandler(getBuilderState, ctx, { applicationId: APP_1 }), 'PERMISSION_DENIED');
    signIn('user-z');
    await expectCode(invokeHandler(getBuilderState, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
    signIn('user-z');
    await expectCode(invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
    signIn('user-a');
    await expectCode(invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1 }), 'DEFINITION_NOT_FOUND');
  });
});

describe('definition validation', () => {
  it.each<[string, DefinitionInput, string, Record<string, unknown>]>([
    [
      'an unknown field type',
      leave({
        fields: [...leaveFields, { type: 'json', key: 'payload', label: { enUS: 'P', zhCN: '载' }, required: false }],
      }),
      'DEFINITION_FIELD_TYPE_UNKNOWN',
      { field: 'payload' },
    ],
    [
      'a duplicate key',
      leave({ fields: [...leaveFields, leaveFields[3]] }),
      'DEFINITION_FIELD_KEY_DUPLICATE',
      { field: 'reason' },
    ],
    [
      'an invalid key',
      leave({ fields: [...leaveFields, { ...noteField, key: '9lives' }] }),
      'DEFINITION_FIELD_KEY_INVALID',
      { field: '9lives' },
    ],
    [
      'a reserved key',
      leave({ fields: [...leaveFields, { ...noteField, key: 'requesterMembershipId' }] }),
      'DEFINITION_FIELD_KEY_RESERVED',
      { field: 'requesterMembershipId' },
    ],
    ['no fields', leave({ fields: [], listColumns: [], dateRules: [] }), 'DEFINITION_FIELD_COUNT_INVALID', {}],
    [
      'an empty English label',
      leave({ fields: [...leaveFields, { ...noteField, label: { enUS: ' ', zhCN: '备注' } }] }),
      'DEFINITION_FIELD_LABEL_INVALID',
      { field: 'note' },
    ],
    [
      'a text field longer than the platform limit',
      leave({ fields: [...leaveFields, { ...noteField, maxLength: 4001 }] }),
      'DEFINITION_FIELD_BOUNDS_INVALID',
      { field: 'note' },
    ],
    [
      'a list column for a missing field',
      leave({ listColumns: ['startDate', 'note'] }),
      'DEFINITION_LIST_COLUMNS_INVALID',
      { field: 'note' },
    ],
    [
      'a date rule on a number field',
      leave({ dateRules: [{ startKey: 'days', endKey: 'endDate' }] }),
      'DEFINITION_DATE_RULE_INVALID',
      { field: 'days' },
    ],
    [
      'a second date rule, which the builder could not show or keep',
      leave({
        fields: [
          ...leaveFields,
          { type: 'date', key: 'returnDate', label: { enUS: 'Return', zhCN: '返回' }, required: false },
        ],
        dateRules: [
          { startKey: 'startDate', endKey: 'endDate' },
          { startKey: 'startDate', endKey: 'returnDate' },
        ],
      }),
      'DEFINITION_DATE_RULE_INVALID',
      {},
    ],
    ['an unknown policy preset', leave({ policyPreset: 'everyone' }), 'DEFINITION_POLICY_INVALID', {}],
  ])('rejects %s without a write', async (_label, definition, code, extra) => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-d', 0, definition), code, extra);
  });

  it.each([
    ['a reviewer from another application in the same organization', 'memberships:b2'],
    ['a reviewer from another organization', 'memberships:z'],
    ['an inactive reviewer', 'memberships:i'],
    ['a member without reviewRequests', 'memberships:a'],
    ['a deleted membership', 'memberships:gone'],
  ])('rejects %s as the reviewer without a write', async (_label, reviewerMembershipId) => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(
      ctx,
      () => save(ctx, 'user-d', 0, leave({ reviewerMembershipId })),
      'DEFINITION_REVIEWER_INVALID',
    );
  });
});

describe('builder state limits', () => {
  it('opens for an application with more than 100 members and flags the truncated reviewer list', async () => {
    const ctx = fixtureContext();
    for (let index = 0; index < 100; index += 1) {
      await ctx.db.insert('memberships', membership(`bulk${index}`, `bulk-${index}`, ['reviewRequests']));
    }
    signIn('user-d');
    const state = await invokeHandler(getBuilderState, ctx, { applicationId: APP_1 });
    expect(state).toMatchObject({ reviewerCandidatesTruncated: true, versionsTruncated: false });
    expect((state as { reviewerCandidates: unknown[] }).reviewerCandidates.length).toBeLessThanOrEqual(100);
  });

  it('returns the newest 100 versions and flags that older ones exist', async () => {
    const ctx = fixtureContext(
      Array.from({ length: 101 }, (_, index) => ({
        _id: `applicationDefinitionVersions:v${index + 1}`,
        _creationTime: index + 1,
        applicationId: APP_1,
        organizationId: ORG_1,
        version: index + 1,
        definition: leave(),
        sourceRevision: index + 1,
        publishedAt: index + 1,
        publishedByMembershipId: 'memberships:d',
      })),
    );
    signIn('user-d');
    const state = (await invokeHandler(getBuilderState, ctx, { applicationId: APP_1 })) as {
      versions: Array<{ version: number }>;
      versionsTruncated: boolean;
      reviewerCandidatesTruncated: boolean;
    };
    expect(state.versionsTruncated).toBe(true);
    expect(state.reviewerCandidatesTruncated).toBe(false);
    expect(state.versions).toHaveLength(100);
    expect(state.versions[0].version).toBe(101);
    expect(state.versions.at(-1)?.version).toBe(2);
  });
});

describe('definition lifecycle', () => {
  it('saves a draft, rejects stale revisions and publishes exactly once per change', async () => {
    const ctx = fixtureContext();
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-d', 0), 'DEFINITION_NOT_FOUND');
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-d', 3, leave()), 'DEFINITION_REVISION_CONFLICT', {
      currentRevision: 0,
    });

    expect(await save(ctx, 'user-d', 0, leave())).toEqual({ revision: 1 });
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-e', 0, leave()), 'DEFINITION_REVISION_CONFLICT', {
      currentRevision: 1,
    });
    expect(await save(ctx, 'user-e', 1, leave({ listColumns: ['startDate', 'endDate', 'days'] }))).toEqual({
      revision: 2,
    });
    await expectRejectedWithoutWrites(ctx, () => save(ctx, 'user-d', 1, leave()), 'DEFINITION_REVISION_CONFLICT', {
      currentRevision: 2,
    });
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-d', 1), 'DEFINITION_REVISION_CONFLICT', {
      currentRevision: 2,
    });

    const writesBefore = ctx.writes.length;
    expect(await save(ctx, 'user-d', 2, leave({ listColumns: ['startDate', 'endDate', 'days'] }))).toEqual({
      revision: 2,
    });
    expect(ctx.writes.length).toBe(writesBefore);

    const published = await publishAs(ctx, 'user-d', 2);
    expect(published).toMatchObject({ version: 1, revision: 3 });
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-d', 3), 'DEFINITION_NOTHING_TO_PUBLISH');
    expect(ctx.rows('applicationDefinitionVersions')).toHaveLength(1);
  });

  it('stores labels without surrounding whitespace, so padding cannot slip past the length limit', async () => {
    const ctx = fixtureContext();
    const padded = { ...noteField, label: { enUS: ` ${'x'.repeat(120)}${' '.repeat(5000)}`, zhCN: '\t备注 ' } };
    await save(ctx, 'user-d', 0, leave({ fields: [...leaveFields, padded] }));
    const [, , , , stored] = (head(ctx).draft as DefinitionInput).fields as Array<{ label: unknown }>;
    expect(stored.label).toEqual({ enUS: 'x'.repeat(120), zhCN: '备注' });

    const writesBefore = ctx.writes.length;
    expect(await save(ctx, 'user-d', 1, leave({ fields: [...leaveFields, padded] }))).toEqual({ revision: 1 });
    expect(ctx.writes.length).toBe(writesBefore);
  });

  it('refuses to publish a draft that was edited back to the current version', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    await publishAs(ctx, 'user-d', 1);
    await save(ctx, 'user-d', 2, leave({ reviewerMembershipId: 'memberships:c' }));
    expect(await save(ctx, 'user-d', 3, leave())).toEqual({ revision: 4 });

    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-d', 4), 'DEFINITION_NOTHING_TO_PUBLISH');
    expect(ctx.rows('applicationDefinitionVersions')).toHaveLength(1);
  });

  it('publishes V2 with a new optional field and reviewer while V1 stays byte-for-byte unchanged', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    const v1 = await publishAs(ctx, 'user-d', 1);
    expect(v1).toMatchObject({ version: 1, revision: 2 });
    const [v1Row] = ctx.rows('applicationDefinitionVersions');
    const v1Snapshot = JSON.stringify(v1Row);
    expect(v1Row).toMatchObject({
      applicationId: APP_1,
      organizationId: ORG_1,
      version: 1,
      sourceRevision: 1,
      publishedByMembershipId: 'memberships:d',
      definition: leave(),
    });

    const v2Definition = leave({
      fields: [...leaveFields, noteField],
      listColumns: ['startDate', 'endDate', 'days', 'reason', 'note'],
      reviewerMembershipId: 'memberships:c',
    });
    expect(await save(ctx, 'user-e', 2, v2Definition)).toEqual({ revision: 3 });
    expect(JSON.stringify(ctx.rows('applicationDefinitionVersions')[0])).toBe(v1Snapshot);
    signIn('user-a');
    expect(await invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1 })).toMatchObject({
      version: 1,
      definition: leave(),
    });

    const v2 = await publishAs(ctx, 'user-e', 3);
    expect(v2).toMatchObject({ version: 2, revision: 4 });
    const versions = ctx.rows('applicationDefinitionVersions');
    expect(versions).toHaveLength(2);
    expect(JSON.stringify(versions.find((row) => row.version === 1))).toBe(v1Snapshot);
    expect(versions.find((row) => row.version === 2)).toMatchObject({
      applicationId: APP_1,
      sourceRevision: 3,
      publishedByMembershipId: 'memberships:e',
      definition: v2Definition,
    });
    expect(head(ctx)).toMatchObject({
      applicationId: APP_1,
      latestVersion: 2,
      revision: 4,
      publishedRevision: 4,
      currentVersionId: versions.find((row) => row.version === 2)?._id,
    });

    signIn('user-a');
    expect(await invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1 })).toMatchObject({
      version: 2,
      isCurrent: true,
      definition: v2Definition,
    });
    expect(await invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1, versionId: v1Row._id })).toMatchObject(
      { version: 1, isCurrent: false, definition: leave() },
    );

    signIn('user-d');
    const state = await invokeHandler(getBuilderState, ctx, { applicationId: APP_1 });
    expect(state).toMatchObject({
      head: {
        revision: 4,
        publishedRevision: 4,
        latestVersion: 2,
        currentVersion: { version: 2 },
        draft: v2Definition,
      },
      reviewerCandidates: [
        { membershipId: 'memberships:b', isSelf: false },
        { membershipId: 'memberships:c', isSelf: false },
      ],
      publishedKeys: [
        { key: 'startDate', type: 'date' },
        { key: 'endDate', type: 'date' },
        { key: 'days', type: 'number' },
        { key: 'reason', type: 'text' },
        { key: 'note', type: 'text' },
      ],
    });
    expect(state).toHaveProperty('versions', [
      expect.objectContaining({ version: 2, publishedByMembershipId: 'memberships:e' }),
      expect.objectContaining({ version: 1, publishedByMembershipId: 'memberships:d' }),
    ]);

    const versionWrites = ctx.writes.filter((write) => write.table === 'applicationDefinitionVersions');
    expect(versionWrites.map((write) => write.operation)).toEqual(['insert', 'insert']);
  });

  it('leaves the pointer and prior versions unchanged when the reviewer becomes ineligible before publish', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    await publishAs(ctx, 'user-d', 1);
    await save(ctx, 'user-d', 2, leave({ reviewerMembershipId: 'memberships:c' }));
    await ctx.db.patch('memberships:c', { grants: ['submitRequests'] });

    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-d', 3), 'DEFINITION_REVIEWER_INVALID');
    expect(head(ctx)).toMatchObject({ latestVersion: 1, revision: 3, publishedRevision: 2 });
  });

  it('refuses to drop or retype a published key', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    await publishAs(ctx, 'user-d', 1);
    await expectRejectedWithoutWrites(
      ctx,
      () => save(ctx, 'user-d', 2, leave({ fields: leaveFields.slice(1), listColumns: ['endDate'], dateRules: [] })),
      'DEFINITION_FIELD_REMOVED',
      { field: 'startDate' },
    );
    await expectRejectedWithoutWrites(
      ctx,
      () =>
        save(
          ctx,
          'user-d',
          2,
          leave({ fields: [...leaveFields.slice(0, 2), { ...leaveFields[3], key: 'days' }, leaveFields[3]] }),
        ),
      'DEFINITION_FIELD_TYPE_CHANGED',
      { field: 'days' },
    );
  });

  it('lets only one of two builders publish from the same revision', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    const winner = await publishAs(ctx, 'user-d', 1);
    expect(winner).toMatchObject({ version: 1 });
    await expectRejectedWithoutWrites(ctx, () => publishAs(ctx, 'user-e', 1), 'DEFINITION_REVISION_CONFLICT', {
      currentRevision: 2,
    });
    expect(ctx.rows('applicationDefinitionVersions')).toHaveLength(1);
  });

  it('is removed with its fixture organization, leaving other organizations’ definitions intact', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    await publishAs(ctx, 'user-d', 1);
    await save(ctx, 'user-d', 2, leave({ reviewerMembershipId: 'memberships:c' }));
    await publishAs(ctx, 'user-d', 3);
    await save(ctx, 'user-z', 0, leave({ reviewerMembershipId: 'memberships:z' }), APP_Z);
    await publishAs(ctx, 'user-z', 1, APP_Z);

    const removed = await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-1' });

    expect(removed).toMatchObject({ organizations: 1, applications: 2, definitions: 1, definitionVersions: 2 });
    expect(ctx.rows('applicationDefinitions').map((row) => row.applicationId)).toEqual([APP_Z]);
    expect(ctx.rows('applicationDefinitionVersions').map((row) => row.applicationId)).toEqual([APP_Z]);
  });

  it('keeps each application’s definition and versions apart', async () => {
    const ctx = fixtureContext();
    await save(ctx, 'user-d', 0, leave());
    const v1 = await publishAs(ctx, 'user-d', 1);
    await save(ctx, 'user-b', 0, leave({ reviewerMembershipId: 'memberships:b2' }), APP_2);
    const other = await publishAs(ctx, 'user-b', 1, APP_2);

    signIn('user-b');
    const versionId = (other as { versionId: string }).versionId;
    await expectCode(
      invokeHandler(getPublishedVersion, ctx, { applicationId: APP_1, versionId }),
      'DEFINITION_VERSION_NOT_FOUND',
    );
    expect(
      await invokeHandler(getPublishedVersion, ctx, {
        applicationId: APP_1,
        versionId: (v1 as { versionId: string }).versionId,
      }),
    ).toMatchObject({ version: 1 });
  });
});
