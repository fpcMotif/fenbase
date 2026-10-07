import { ConvexError } from 'convex/values';
import { createContext, type TestContext, type TestDoc } from './helpers';

export const ORG_1 = 'organizations:1';
export const ORG_2 = 'organizations:2';
export const APP_1 = 'applications:1';
export const APP_2 = 'applications:2';
export const APP_Z = 'applications:z';
export const V1 = 'applicationDefinitionVersions:v1';
export const V2 = 'applicationDefinitionVersions:v2';
export const V_APP_2 = 'applicationDefinitionVersions:app2';
export const V_Z = 'applicationDefinitionVersions:z';

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

export type Preset = 'requesterAndAssignedReviewer' | 'requesterAssignedReviewerAndReaders';

export function leaveDefinition(
  preset: Preset = 'requesterAndAssignedReviewer',
  withNote = false,
  reviewerMembershipId = 'memberships:b',
) {
  return {
    fields: withNote ? [...leaveFields, noteField] : leaveFields,
    listColumns: withNote ? ['requester', 'startDate', 'days', 'note'] : ['requester', 'startDate', 'days'],
    dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
    policyPreset: preset,
    reviewerMembershipId,
  };
}

export function membership(
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

export function versionRow(
  id: string,
  applicationId: string,
  organizationId: string,
  version: number,
  definition: unknown,
) {
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

// Membership b submits and reviews and is V1's reviewer; membership v only reviews and is the reviewer of a later V2.
export function fixtureContext(options: { app1Preset?: Preset; app1Published?: boolean } = {}): TestContext {
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
      membership('v', 'user-v', ['reviewRequests']),
      membership('c', 'user-c', ['configureApplication']),
      membership('r', 'user-r', ['readApplicationRecords']),
      membership('n', 'user-n', []),
      membership('i', 'user-i', ['submitRequests'], { status: 'inactive' }),
      membership('a-app2', 'user-a', ['submitRequests'], { applicationId: APP_2 }),
      membership('b-app2', 'user-b', ['reviewRequests'], { applicationId: APP_2 }),
      membership('z', 'user-z', ['submitRequests', 'readApplicationRecords', 'reviewRequests'], {
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
      versionRow(
        V_APP_2,
        APP_2,
        ORG_1,
        1,
        leaveDefinition('requesterAndAssignedReviewer', false, 'memberships:b-app2'),
      ),
      versionRow(V_Z, APP_Z, ORG_2, 1, leaveDefinition('requesterAssignedReviewerAndReaders', false, 'memberships:z')),
    ],
  });
}

export const leave = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Family visit' };

export async function seedV2(
  ctx: TestContext,
  preset: Preset = 'requesterAndAssignedReviewer',
  reviewerMembershipId = 'memberships:b',
): Promise<void> {
  ctx.seed(
    'applicationDefinitionVersions',
    versionRow(V2, APP_1, ORG_1, 2, leaveDefinition(preset, true, reviewerMembershipId)),
  );
  await ctx.db.patch('applicationDefinitions:1', { currentVersionId: V2, latestVersion: 2 });
}

export function requestDoc(
  operationId: string,
  requesterMembershipId: string,
  values: Record<string, unknown> = leave,
) {
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

// The Convex bundler also loads this directory, so this file must not import vitest. Await the result and assert on it.
export async function rejectionData(operation: Promise<unknown>): Promise<Record<string, unknown> | string> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ConvexError)) return `expected a ConvexError, got ${String(error)}`;
  const data: unknown = error.data;
  return typeof data === 'object' && data !== null ? { ...data } : `unexpected error data ${String(data)}`;
}
