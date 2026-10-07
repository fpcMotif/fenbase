#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Definition } from '../convex/definitionModel';
import type { Capability } from '../convex/membershipValidators';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';
import { leaveDefinition } from './leave-definition';

type Locale = 'en-US' | 'zh-CN';
type ActorKey = 'A' | 'B' | 'C' | 'R' | 'I' | 'Z';
type OrganizationKey = 'one' | 'two' | 'readers';
type Row = Record<string, unknown>;
type Check = { id: string; expected: unknown; actual: unknown; pass: boolean };
type SeedResult = {
  organizationId: Id<'organizations'>;
  applicationId: Id<'applications'>;
  membershipId: Id<'memberships'>;
};
type Membership = {
  organizationId: Id<'organizations'>;
  applicationId: Id<'applications'>;
  membershipId: Id<'memberships'>;
};
type Actor = {
  key: ActorKey;
  plan: Array<{ organization: OrganizationKey; capabilities: Capability[]; status: 'active' | 'inactive' }>;
  email: string;
  auth: ReturnType<typeof createDemoAuthClient>;
  client?: ConvexHttpClient;
  authUserId?: string;
  memberships: Partial<Record<OrganizationKey, Membership>>;
};

const artifactsDir = join('dist', 'request-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const viewport = { width: 1280, height: 900 };

const actorPlan: Array<Pick<Actor, 'key' | 'plan'>> = [
  {
    key: 'A',
    plan: [
      { organization: 'one', capabilities: ['submitRequests'], status: 'active' },
      { organization: 'readers', capabilities: ['submitRequests'], status: 'active' },
    ],
  },
  {
    key: 'B',
    plan: [
      { organization: 'one', capabilities: ['submitRequests', 'reviewRequests'], status: 'active' },
      { organization: 'readers', capabilities: ['submitRequests', 'reviewRequests'], status: 'active' },
    ],
  },
  {
    key: 'C',
    plan: [
      { organization: 'one', capabilities: ['configureApplication'], status: 'active' },
      { organization: 'readers', capabilities: ['configureApplication'], status: 'active' },
    ],
  },
  {
    key: 'R',
    plan: [
      { organization: 'one', capabilities: ['readApplicationRecords'], status: 'active' },
      { organization: 'readers', capabilities: ['readApplicationRecords'], status: 'active' },
    ],
  },
  { key: 'I', plan: [{ organization: 'one', capabilities: ['submitRequests'], status: 'inactive' }] },
  {
    key: 'Z',
    plan: [
      {
        organization: 'two',
        capabilities: ['submitRequests', 'readApplicationRecords', 'configureApplication', 'reviewRequests'],
        status: 'active',
      },
    ],
  },
];

const texts = {
  'en-US': {
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    requestsTab: 'Requests',
    newRequest: 'New request',
    empty: 'No requests yet.',
    save: 'Save draft',
    labels: {
      startDate: 'Start date',
      endDate: 'End date',
      days: 'Days',
      reason: 'Reason',
      note: 'Note',
      contact: 'Contact',
    },
    versionTag: (version: number) => `Version ${version}`,
    created: (revision: number) => `Draft created · revision ${revision}`,
    saved: (revision: number) => `Draft saved · revision ${revision}`,
    deleted: 'Draft request deleted',
    rangeError: 'End date must not be earlier than the start of the date range.',
    openRow: 'Open request',
    deleteRow: 'Delete request',
    deleteOk: 'Delete',
    conflictTitle: 'This request changed since you opened it',
    keepMine: 'Keep my changes',
    outdatedTitle: 'A newer version of this form was published',
    loadNewVersion: 'Load new version',
    versionColumn: 'Version',
    me: 'Me',
    missing: '—',
    filterFrom: 'Start date on or after',
    filterTo: 'End date on or before',
    clearFilter: 'Clear dates',
    noMatches: 'No requests match these dates.',
    date: (value: string) => value.replaceAll('-', ''),
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    requestsTab: '申请',
    newRequest: '新建申请',
    empty: '暂无申请。',
    save: '保存草稿',
    labels: {
      startDate: '开始日期',
      endDate: '结束日期',
      days: '天数',
      reason: '原因',
      note: '备注',
      contact: '联系方式',
    },
    versionTag: (version: number) => `版本 ${version}`,
    created: (revision: number) => `草稿已创建 · 修订 ${revision}`,
    saved: (revision: number) => `草稿已保存 · 修订 ${revision}`,
    deleted: '申请草稿已删除',
    rangeError: '结束日期 不能早于日期范围的开始日期。',
    openRow: '打开申请',
    deleteRow: '删除申请',
    deleteOk: '删 除',
    conflictTitle: '此申请在你打开后已被修改',
    keepMine: '保留我的修改',
    outdatedTitle: '此表单已发布新版本',
    loadNewVersion: '加载新版本',
    versionColumn: '版本',
    me: '我',
    missing: '—',
    filterFrom: '开始日期不早于',
    filterTo: '结束日期不晚于',
    clearFilter: '清除日期',
    noMatches: '没有符合这些日期的申请。',
    date: (value: string) => value.replaceAll('-', ''),
  },
} as const;

const looseMutation = (name: string) => makeFunctionReference<'mutation', Record<string, unknown>, unknown>(name);
const looseQuery = (name: string) => makeFunctionReference<'query', Record<string, unknown>, unknown>(name);

export function readPrivate(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8').trim();
}

export function convexCli(envFile: string, args: string[]): string {
  return execFileSync('node_modules/.bin/convex', [...args.slice(0, 1), '--env-file', envFile, ...args.slice(1)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function runInternal<T>(envFile: string, name: string, args: Record<string, unknown>): T {
  return JSON.parse(convexCli(envFile, ['run', name, JSON.stringify(args)])) as T;
}

export function tableRows(envFile: string, table: string, component?: string): Row[] {
  let output: string;
  try {
    output = convexCli(envFile, [
      'data',
      table,
      '--format',
      'jsonLines',
      '--limit',
      '10000',
      ...(component ? ['--component', component] : []),
    ]);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Row);
}

export function outcomeOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === 'string') return data;
    if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') return data.code;
  }
  const message = errorMessage(error);
  if (message.includes('ArgumentValidationError')) return 'ArgumentValidationError';
  if (message.includes('Could not find public function')) return 'FunctionNotFound';
  if (message.includes('Unauthenticated')) return 'Unauthenticated';
  return `unexpected: ${message.split('\n')[0]}`;
}

export async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  for (let presses = 0; presses < 250; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard could not reach the requested control');
}

export async function keyboardActivate(page: Page, target: Locator): Promise<void> {
  await keyboardFocus(page, target);
  await page.keyboard.press('Enter');
}

export async function keyboardInput(page: Page, target: Locator, value: string): Promise<void> {
  await keyboardFocus(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  if (value === '') await page.keyboard.press('Backspace');
  else await page.keyboard.insertText(value);
}

// A native date input takes digits per segment in the operating system's date order, not the page locale's; Tab lands
// on its first segment. The recorded runs used a year-month-day system order.
export async function keyboardDate(page: Page, target: Locator, digits: string): Promise<void> {
  await keyboardFocus(page, target);
  await page.keyboard.type(digits);
}

// The operation id of a `requests:create` mutation the page sent over the Convex WebSocket, if this frame is one.
function sentCreateOperationId(payload: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  if (Reflect.get(message, 'type') !== 'Mutation') return undefined;
  const udfPath: unknown = Reflect.get(message, 'udfPath');
  if (typeof udfPath !== 'string' || !/^requests(\.js)?:create$/.test(udfPath)) return undefined;
  const args: unknown = Reflect.get(message, 'args');
  const first: unknown = Array.isArray(args) ? args[0] : undefined;
  if (typeof first !== 'object' || first === null) return undefined;
  const operationId: unknown = Reflect.get(first, 'operationId');
  return typeof operationId === 'string' ? operationId : undefined;
}

async function main(): Promise<void> {
  const mode = process.env.REQUEST_JOURNEY_MODE === 'red' ? 'red' : 'green';
  const dir = process.env.REQUEST_DIR?.trim();
  assert(dir, 'Set REQUEST_DIR to the isolated target directory');
  const envFile = join(dir, 'target.env');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Request journey requires an isolated local target');
  }
  const runId = readPrivate(dir, 'run-id');
  const password = readPrivate(dir, 'password');
  mkdirSync(artifactsDir, { recursive: true });
  const organizationKeys: Record<OrganizationKey, string> = {
    one: `fixture-req16-one-${runId}`,
    two: `fixture-req16-two-${runId}`,
    readers: `fixture-req16-readers-${runId}`,
  };

  const actors = actorPlan.map<Actor>((plan) => ({
    ...plan,
    email: `r16-${plan.key.toLowerCase()}-${runId}@example.test`,
    auth: createDemoAuthClient(siteUrl),
    memberships: {},
  }));
  const actor = (key: ActorKey): Actor => {
    const found = actors.find((candidate) => candidate.key === key);
    assert(found, `Unknown actor ${key}`);
    return found;
  };
  const client = (key: ActorKey): ConvexHttpClient => {
    const found = actor(key).client;
    assert(found, `Actor ${key} is not signed in`);
    return found;
  };
  const membership = (key: ActorKey, organization: OrganizationKey = 'one'): Membership => {
    const found = actor(key).memberships[organization];
    assert(found, `Actor ${key} has no membership in ${organization}`);
    return found;
  };
  const app = (organization: OrganizationKey): Id<'applications'> =>
    (organization === 'two' ? membership('Z', 'two') : membership('C', organization)).applicationId;

  const labels = new Map<string, string>();
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') return labels.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [
            key,
            ['updatedAt', 'publishedAt', '_creationTime', 'operationFingerprint'].includes(key)
              ? `<${key}>`
              : normalize(entry),
          ]),
      );
    }
    return value;
  };

  const checks: Check[] = [];
  const check = (id: string, expected: unknown, actual: unknown): boolean => {
    const normalizedExpected = normalize(expected);
    const normalizedActual = normalize(actual);
    const pass = JSON.stringify(normalizedExpected) === JSON.stringify(normalizedActual);
    checks.push({ id, expected: normalizedExpected, actual: normalizedActual, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`);
    return pass;
  };
  const must = (id: string, expected: unknown, actual: unknown): void => {
    assert(check(id, expected, actual), `Check failed: ${id}`);
  };

  const seededApplications: Partial<Record<OrganizationKey, Id<'applications'>>> = {};
  const fixtureApplications = () => new Set<unknown>(Object.values(seededApplications));
  const requestRows = (applicationId?: Id<'applications'>) =>
    tableRows(envFile, 'requests')
      .filter((row) =>
        applicationId ? row.applicationId === applicationId : fixtureApplications().has(row.applicationId),
      )
      .sort((left, right) => Number(left._creationTime) - Number(right._creationTime));

  const deny = async (id: string, expected: string, operation: () => Promise<unknown>): Promise<void> => {
    const before = JSON.stringify(requestRows());
    let actual = 'succeeded';
    try {
      await operation();
    } catch (error) {
      actual = outcomeOf(error);
    }
    const unchanged = before === JSON.stringify(requestRows());
    check(id, { outcome: expected, stateUnchanged: true }, { outcome: actual, stateUnchanged: unchanged });
  };

  const publishDefinition = async (key: ActorKey, organization: OrganizationKey, definition: Definition) => {
    const applicationId = app(organization);
    const state = await client(key).query(api.applicationDefinitions.getBuilderState, { applicationId });
    const saved = await client(key).mutation(api.applicationDefinitions.saveDraft, {
      applicationId,
      expectedRevision: state.head?.revision ?? 0,
      definition,
    });
    return client(key).mutation(api.applicationDefinitions.publish, {
      applicationId,
      expectedRevision: saved.revision,
    });
  };

  let operationCounter = 0;
  const operationId = (label: string) => {
    operationCounter += 1;
    return `r16-${label}-${operationCounter}-${runId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  };

  const seededOrganizations = new Set<string>();
  const cleanup: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  let browser: Browser | undefined;
  let failure: unknown;

  try {
    // Real Better Auth identities and fixture memberships.
    for (const target of actors) {
      try {
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      } catch {
        const signup = await target.auth.signUp.email({ name: `R16 ${target.key}`, email: target.email, password });
        assert(!signup.error, `Sign-up failed for actor ${target.key}`);
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      }
      const viewer = await target.client.query(api.users.getViewer, {});
      target.authUserId = viewer.id;
      labels.set(viewer.id, `<authUser:${target.key}>`);
      for (const entry of target.plan) {
        const organizationKey = organizationKeys[entry.organization];
        const seeded = runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
          organizationKey,
          organizationName: `Request fixture ${entry.organization}`,
          authUserId: viewer.id,
          capabilities: entry.capabilities,
          status: entry.status,
        });
        seededOrganizations.add(organizationKey);
        seededApplications[entry.organization] = seeded.applicationId;
        target.memberships[entry.organization] = seeded;
        labels.set(seeded.membershipId, `<membership:${target.key}:${entry.organization}>`);
        labels.set(seeded.applicationId, `<application:${entry.organization}>`);
        labels.set(seeded.organizationId, `<organization:${entry.organization}>`);
      }
    }

    // Published definitions: V1 in application one, the readers preset in the readers application, and Z's own.
    const v1Definition: Definition = {
      ...leaveDefinition(membership('B').membershipId),
      listColumns: ['requester', 'startDate', 'endDate', 'days'],
    };
    const published = await Promise.all([
      publishDefinition('C', 'one', v1Definition),
      publishDefinition('C', 'readers', {
        ...leaveDefinition(membership('B', 'readers').membershipId),
        policyPreset: 'requesterAssignedReviewerAndReaders',
      }),
      publishDefinition('Z', 'two', leaveDefinition(membership('Z', 'two').membershipId)),
    ]).catch((error: unknown) => {
      check('setup.definitions-published', 'published', outcomeOf(error));
      return null;
    });
    const [v1, readersV1, zV1] = published ?? [];
    if (v1) labels.set(v1.versionId, '<version:one:1>');
    if (readersV1) labels.set(readersV1.versionId, '<version:readers:1>');
    if (zV1) labels.set(zV1.versionId, '<version:two:1>');
    const v1Id = v1?.versionId ?? ('applicationDefinitionVersions' as Id<'applicationDefinitionVersions'>);

    const leave = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Family visit' };
    const createArgs = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      applicationId: app('one'),
      definitionVersionId: v1Id,
      operationId: operationId('deny'),
      values,
      ...extra,
    });
    const createAs = (key: ActorKey, args: Record<string, unknown>) =>
      client(key).mutation(looseMutation('requests:create'), args);

    // Phase 1: forged identity, missing grants and invalid values leave the request table untouched.
    const anonymous = new ConvexHttpClient(convexUrl);
    await deny('http.create.anonymous', 'Unauthenticated', () =>
      anonymous.mutation(looseMutation('requests:create'), createArgs(leave)),
    );
    await deny('http.create.inactive-member', 'APPLICATION_ACCESS_DENIED', () => createAs('I', createArgs(leave)));
    await deny('http.create.second-organization', 'APPLICATION_ACCESS_DENIED', () => createAs('Z', createArgs(leave)));
    await deny('http.create.without-submit-grant', 'PERMISSION_DENIED', () => createAs('C', createArgs(leave)));
    await deny('http.create.reader-without-submit-grant', 'PERMISSION_DENIED', () => createAs('R', createArgs(leave)));
    for (const [name, value] of [
      ['organizationId', membership('Z', 'two').organizationId],
      ['requesterMembershipId', membership('B').membershipId],
      ['state', 'approved'],
      ['reviewerMembershipId', membership('B').membershipId],
      ['version', 2],
    ] as const) {
      await deny(`http.create.forged-argument.${name}`, 'ArgumentValidationError', () =>
        createAs('A', createArgs(leave, { [name]: value })),
      );
    }
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['server-owned-state', { ...leave, state: 'approved' }, 'RECORD_FIELD_SERVER_OWNED'],
      [
        'reviewer-assignment',
        { ...leave, reviewerMembershipId: membership('B').membershipId },
        'RECORD_FIELD_SERVER_OWNED',
      ],
      ['forged-requester', { ...leave, requester: membership('B').membershipId }, 'RECORD_FIELD_SERVER_OWNED'],
      ['decision-history', { ...leave, approvedBy: 'B' }, 'RECORD_FIELD_UNKNOWN'],
      ['missing-required', { startDate: leave.startDate, endDate: leave.endDate, days: 3 }, 'RECORD_FIELD_REQUIRED'],
      ['mistyped-number', { ...leave, days: '3' }, 'RECORD_FIELD_TYPE_INVALID'],
      ['oversized-text', { ...leave, reason: 'x'.repeat(1001) }, 'RECORD_TEXT_TOO_LONG'],
      ['number-out-of-range', { ...leave, days: 400 }, 'RECORD_NUMBER_OUT_OF_RANGE'],
      ['fractional-days', { ...leave, days: 1.5 }, 'RECORD_NUMBER_NOT_INTEGER'],
      ['impossible-date', { ...leave, startDate: '2026-02-30' }, 'RECORD_DATE_INVALID'],
      ['datetime-instead-of-date', { ...leave, startDate: '2026-03-02T00:00:00Z' }, 'RECORD_DATE_INVALID'],
      ['reversed-range', { ...leave, endDate: '2026-03-01' }, 'RECORD_DATE_RANGE_INVALID'],
      ['optional-key-from-a-later-version', { ...leave, note: 'x' }, 'RECORD_FIELD_UNKNOWN'],
    ];
    for (const [name, values, code] of invalid) {
      await deny(`http.create.${name}`, code, () => createAs('A', createArgs(values)));
    }
    await deny('http.create.object-value', 'ArgumentValidationError', () =>
      createAs('A', createArgs({ ...leave, days: { value: 3 } })),
    );
    await deny('http.create.malformed-operation-id', 'RECORD_OPERATION_ID_INVALID', () =>
      createAs('A', createArgs(leave, { operationId: 'no' })),
    );
    await deny('http.create.version-of-another-organization', 'RECORD_DEFINITION_OUTDATED', () =>
      createAs('A', createArgs(leave, { definitionVersionId: zV1?.versionId ?? v1Id })),
    );
    check('http.no-request-rows-after-denials', [], requestRows());

    // Phase 2: create, duplicate protection, revisions and isolation through direct calls.
    const firstOperation = operationId('first');
    let firstId: Id<'requests'> | undefined;
    try {
      const first = (await createAs('A', createArgs(leave, { operationId: firstOperation }))) as {
        requestId: Id<'requests'>;
        created: boolean;
        revision: number;
        version: number;
      };
      firstId = first.requestId;
      labels.set(first.requestId, '<request:first>');
      check(
        'http.create.valid',
        { created: true, revision: 1, version: 1 },
        {
          created: first.created,
          revision: first.revision,
          version: first.version,
        },
      );
      const [row] = requestRows(app('one'));
      check(
        'persist.create.server-owned-fields',
        {
          applicationId: app('one'),
          organizationId: membership('A').organizationId,
          requesterMembershipId: membership('A').membershipId,
          definitionVersionId: v1Id,
          version: 1,
          policyPreset: 'requesterAndAssignedReviewer',
          state: 'draft',
          revision: 1,
          operationId: firstOperation,
          values: leave,
        },
        {
          applicationId: row?.applicationId,
          organizationId: row?.organizationId,
          requesterMembershipId: row?.requesterMembershipId,
          definitionVersionId: row?.definitionVersionId,
          version: row?.version,
          policyPreset: row?.policyPreset,
          state: row?.state,
          revision: row?.revision,
          operationId: row?.operationId,
          values: row?.values,
        },
      );
      const before = JSON.stringify(requestRows());
      const replay = await createAs(
        'A',
        createArgs(
          { reason: leave.reason, days: leave.days, endDate: leave.endDate, startDate: leave.startDate },
          {
            operationId: firstOperation,
          },
        ),
      );
      check(
        'http.create.replay-returns-original-without-write',
        { result: { created: false, requestId: first.requestId, revision: 1, version: 1 }, unchanged: true },
        { result: replay, unchanged: before === JSON.stringify(requestRows()) },
      );
    } catch (error) {
      check('http.create.valid', { created: true }, outcomeOf(error));
    }
    await deny('http.create.reused-operation-id-with-new-values', 'RECORD_OPERATION_CONFLICT', () =>
      createAs('A', createArgs({ ...leave, days: 2 }, { operationId: firstOperation })),
    );

    const requestId = firstId ?? ('requests' as Id<'requests'>);
    const updateArgs = (
      expectedRevision: number,
      values: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      applicationId: app('one'),
      requestId,
      expectedRevision,
      values,
      ...extra,
    });
    await deny('http.update.other-member', 'RECORD_NOT_FOUND', () =>
      client('B').mutation(looseMutation('requests:update'), updateArgs(1, leave)),
    );
    await deny('http.remove.other-member', 'RECORD_NOT_FOUND', () =>
      client('B').mutation(looseMutation('requests:remove'), {
        applicationId: app('one'),
        requestId,
        expectedRevision: 1,
      }),
    );
    await deny('http.update.second-organization', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').mutation(looseMutation('requests:update'), updateArgs(1, leave)),
    );
    await deny('http.update.through-own-other-application', 'RECORD_NOT_FOUND', () =>
      client('A').mutation(looseMutation('requests:update'), {
        ...updateArgs(1, leave),
        applicationId: app('readers'),
      }),
    );
    await deny('http.update.set-state-argument', 'ArgumentValidationError', () =>
      client('A').mutation(looseMutation('requests:update'), updateArgs(1, leave, { state: 'approved' })),
    );
    await deny('http.update.assign-reviewer-value', 'RECORD_FIELD_SERVER_OWNED', () =>
      client('A').mutation(
        looseMutation('requests:update'),
        updateArgs(1, { ...leave, reviewerMembershipId: membership('B').membershipId }),
      ),
    );
    await deny('http.update.reversed-range-no-partial-write', 'RECORD_DATE_RANGE_INVALID', () =>
      client('A').mutation(
        looseMutation('requests:update'),
        updateArgs(1, { ...leave, days: 1, endDate: '2026-03-01' }),
      ),
    );
    const readOutcome = async (key: ActorKey, applicationId: Id<'applications'>) =>
      client(key)
        .query(looseQuery('requests:get'), { applicationId, requestId })
        .then(
          (value) => (value === null ? 'null' : 'visible'),
          (error: unknown) => outcomeOf(error),
        );
    const listTotal = async (key: ActorKey, applicationId: Id<'applications'>) =>
      client(key)
        .query(looseQuery('requests:list'), { applicationId })
        .then(
          (value) => (value as { total: number }).total,
          (error: unknown) => outcomeOf(error),
        );
    const listScope = async (key: ActorKey, applicationId: Id<'applications'>) =>
      client(key)
        .query(looseQuery('requests:list'), { applicationId })
        .then(
          (value) => (value as { scope: string }).scope,
          (error: unknown) => outcomeOf(error),
        );
    const requestCount = (applicationId: Id<'applications'>) =>
      tableRows(envFile, 'requestCounts').find((row) => row.applicationId === applicationId)?.count ?? 0;
    check(
      'http.read.isolation',
      {
        A: 'visible',
        B: 'null',
        C: 'null',
        R: 'null',
        Z: 'APPLICATION_ACCESS_DENIED',
        listB: 0,
        listR: 0,
        listA: 1,
        scopeR: 'own',
      },
      {
        scopeR: await listScope('R', app('one')),
        A: await readOutcome('A', app('one')),
        B: await readOutcome('B', app('one')),
        C: await readOutcome('C', app('one')),
        R: await readOutcome('R', app('one')),
        Z: await readOutcome('Z', app('one')),
        listB: await listTotal('B', app('one')),
        listR: await listTotal('R', app('one')),
        listA: await listTotal('A', app('one')),
      },
    );

    try {
      const updated = await client('A').mutation(
        looseMutation('requests:update'),
        updateArgs(1, { ...leave, days: 2 }),
      );
      check('http.update.expected-revision', { revision: 2 }, updated);
    } catch (error) {
      check('http.update.expected-revision', { revision: 2 }, outcomeOf(error));
    }
    await deny('http.update.stale-revision', 'RECORD_REVISION_CONFLICT', () =>
      client('A').mutation(looseMutation('requests:update'), updateArgs(1, { ...leave, days: 4 })),
    );
    await deny('http.remove.stale-revision', 'RECORD_REVISION_CONFLICT', () =>
      client('A').mutation(looseMutation('requests:remove'), {
        applicationId: app('one'),
        requestId,
        expectedRevision: 1,
      }),
    );

    // The readers preset: drafts stay private, so neither R (the reader) nor B (the reviewer) sees A's draft.
    try {
      const readersRequest = (await createAs('A', {
        applicationId: app('readers'),
        definitionVersionId: readersV1?.versionId,
        operationId: operationId('readers'),
        values: leave,
      })) as { requestId: Id<'requests'> };
      labels.set(readersRequest.requestId, '<request:readers>');
      const readerView = (await client('R').query(looseQuery('requests:get'), {
        applicationId: app('readers'),
        requestId: readersRequest.requestId,
      })) as { requester: { isMe: boolean }; canEdit: boolean } | null;
      check(
        'http.preset.readers-application',
        {
          readerSees: null,
          readerTotal: 0,
          readerScope: 'own',
          reviewerTotal: 0,
          requesterTotal: 1,
          requesterScope: 'own',
          readerEdit: 'RECORD_NOT_FOUND',
        },
        {
          readerSees: readerView && { isMe: readerView.requester.isMe, canEdit: readerView.canEdit },
          readerScope: await listScope('R', app('readers')),
          readerTotal: await listTotal('R', app('readers')),
          reviewerTotal: await listTotal('B', app('readers')),
          requesterTotal: await listTotal('A', app('readers')),
          requesterScope: await listScope('A', app('readers')),
          readerEdit: await client('R')
            .mutation(looseMutation('requests:remove'), {
              applicationId: app('readers'),
              requestId: readersRequest.requestId,
              expectedRevision: 1,
            })
            .then(
              () => 'succeeded',
              (error: unknown) => outcomeOf(error),
            ),
        },
      );
    } catch (error) {
      check('http.preset.readers-application', 'visible', outcomeOf(error));
    }

    // Bounded pagination over 25 of A's requests, with B's requests interleaved in the same application.
    try {
      await client('A').mutation(looseMutation('requests:remove'), {
        applicationId: app('one'),
        requestId,
        expectedRevision: 2,
      });
      for (let index = 1; index <= 25; index += 1) {
        const day = String(index).padStart(2, '0');
        await createAs('A', {
          applicationId: app('one'),
          definitionVersionId: v1Id,
          operationId: operationId(`page-${index}`),
          values: {
            ...leave,
            startDate: `2026-05-${day}`,
            endDate: `2026-05-${day}`,
            days: index,
            reason: `Page ${index}`,
          },
        });
        if (index % 8 === 0) {
          await createAs('B', {
            applicationId: app('one'),
            definitionVersionId: v1Id,
            operationId: operationId(`b-${index}`),
            values: { ...leave, days: 100 + index, reason: `B ${index}` },
          });
        }
      }
      check(
        'persist.request-count-tracks-creates-and-deletes',
        { counter: 28, rows: 28 },
        { counter: requestCount(app('one')), rows: requestRows(app('one')).length },
      );
      type Page = {
        items: Array<{ _id: string; values: { days: number } }>;
        total: number;
        page: number;
        pageCount: number;
      };
      const listPage = (args: Record<string, unknown>) =>
        client('A').query(looseQuery('requests:list'), { applicationId: app('one'), ...args }) as Promise<Page>;
      const pages = [];
      for (let page = 1; page <= 3; page += 1) {
        pages.push(await listPage({ page, pageSize: 10, sort: { field: 'days', direction: 'asc' } }));
      }
      const ids = pages.flatMap((page) => page.items.map((item) => item._id));
      const clamped = await listPage({ page: 9, pageSize: 10, sort: { field: 'days', direction: 'asc' } });
      const filtered = await listPage({
        filters: [{ field: 'startDate', operator: '$gte', value: '2026-05-21' }],
        sort: { field: 'days', direction: 'desc' },
        pageSize: 100,
      });
      check(
        'http.list.filter-before-page-without-dropping-records',
        {
          total: 25,
          pageSizes: [10, 10, 5],
          unique: 25,
          days: Array.from({ length: 25 }, (_, index) => index + 1),
          clamped: { page: 3, pageCount: 3, items: 5 },
          filtered: { total: 5, days: [25, 24, 23, 22, 21] },
          bTotal: 3,
        },
        {
          total: pages[0]?.total,
          pageSizes: pages.map((page) => page.items.length),
          unique: new Set(ids).size,
          days: pages.flatMap((page) => page.items.map((item) => item.values.days)),
          clamped: { page: clamped.page, pageCount: clamped.pageCount, items: clamped.items.length },
          filtered: { total: filtered.total, days: filtered.items.map((item) => item.values.days) },
          bTotal: await listTotal('B', app('one')),
        },
      );
      await deny('http.list.page-size-over-100', 'RECORD_QUERY_PAGE_INVALID', () =>
        client('A').query(looseQuery('requests:list'), { applicationId: app('one'), pageSize: 101 }),
      );
      await deny('http.list.invalid-date-filter', 'RECORD_QUERY_VALUE_INVALID', () =>
        client('A').query(looseQuery('requests:list'), {
          applicationId: app('one'),
          filters: [{ field: 'startDate', operator: '$gte', value: '2026-02-30' }],
        }),
      );
      for (const row of requestRows(app('one'))) {
        const owner = row.requesterMembershipId === membership('A').membershipId ? 'A' : 'B';
        await client(owner).mutation(looseMutation('requests:remove'), {
          applicationId: app('one'),
          requestId: row._id,
          expectedRevision: row.revision,
        });
      }
      check(
        'http.list.seeded-requests-removed',
        { rows: 0, counter: 0 },
        { rows: requestRows(app('one')).length, counter: requestCount(app('one')) },
      );
    } catch (error) {
      check('http.list.filter-before-page-without-dropping-records', 'listed', outcomeOf(error));
    }

    if (mode === 'green') {
      // Phase 3: employee A in both languages, keyboard only, recorded.
      browser = await chromium.launch({ channel: 'chrome' });
      const noteField = {
        type: 'text',
        key: 'note',
        label: { enUS: 'Note', zhCN: '备注' },
        required: false,
        maxLength: 500,
      } as const;
      const v2Definition: Definition = {
        ...v1Definition,
        fields: [...v1Definition.fields, noteField],
        listColumns: [...v1Definition.listColumns, 'note'],
      };
      const v3Definition: Definition = {
        ...v2Definition,
        fields: [
          ...v2Definition.fields,
          {
            type: 'text',
            key: 'contact',
            label: { enUS: 'Contact', zhCN: '联系方式' },
            required: false,
            maxLength: 100,
          },
        ],
      };
      let v1RequestId: string | undefined;

      for (const locale of ['en-US', 'zh-CN'] as const) {
        const text = texts[locale];
        const context = await browser.newContext({
          locale,
          viewport,
          recordVideo: { dir: artifactsDir, size: viewport },
        });
        const page = await context.newPage();
        await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
        page.setDefaultTimeout(20_000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const createOperations: string[] = [];
        page.on('websocket', (socket) => {
          socket.on('framesent', ({ payload }) => {
            const sent = typeof payload === 'string' ? sentCreateOperationId(payload) : undefined;
            if (sent) createOperations.push(sent);
          });
        });
        const consoleLines: string[] = [];
        page.on('console', (message) => {
          consoleLines.push(
            `${message.type()}: ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`,
          );
          if (message.type() === 'error' && !/\[CONVEX M\(requests:/.test(message.text()))
            pageErrors.push(message.text());
        });
        const capture = async (step: string) => {
          await page.locator('button.ant-btn-loading').first().waitFor({ state: 'hidden' });
          await page.screenshot({
            path: join(artifactsDir, `${locale}-${step}.png`),
            fullPage: true,
            animations: 'disabled',
          });
        };
        const status = page.locator('output');
        const dialog = page.getByRole('dialog');
        const control = (key: keyof typeof text.labels) => dialog.getByLabel(text.labels[key], { exact: true });
        const openRequests = async () => {
          const target = page.getByRole('tab', { name: text.requestsTab });
          await target.waitFor();
          await keyboardFocus(page, page.getByRole('tab', { selected: true }));
          for (let presses = 0; presses < 5; presses += 1) {
            if (await target.evaluate((element) => element === document.activeElement)) break;
            await page.keyboard.press('ArrowRight');
          }
          await page.keyboard.press('Enter');
          await page.getByRole('button', { name: text.newRequest, exact: true }).waitFor();
        };
        const rowWith = (value: string) => page.getByRole('row').filter({ hasText: value });
        const save = async () => keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        const readDialog = async (keys: Array<keyof typeof text.labels>) => {
          const values: Record<string, string> = {};
          for (const key of keys) values[key] = await control(key).inputValue();
          return values;
        };
        const visibleLabels = async () => dialog.locator('.ant-form-item-label label').allInnerTexts();
        const requestsOf = () =>
          requestRows(app('one')).filter((row) => row.requesterMembershipId === membership('A').membershipId);

        try {
          await page.goto(appUrl);
          await keyboardInput(page, page.getByLabel(text.email, { exact: true }), actor('A').email);
          await keyboardInput(page, page.getByLabel(text.password, { exact: true }), password);
          await page.keyboard.press('Enter');
          await page.getByRole('button', { name: text.signOut }).waitFor();
          await openRequests();

          if (locale === 'en-US') {
            await page.getByText(text.empty, { exact: true }).waitFor();
            await capture('1-empty');
            await keyboardActivate(page, page.getByRole('button', { name: text.newRequest, exact: true }));
            await dialog.getByText(text.versionTag(1), { exact: true }).waitFor();
            await keyboardDate(page, control('startDate'), text.date('2026-03-02'));
            await keyboardDate(page, control('endDate'), text.date('2026-03-01'));
            await keyboardInput(page, control('days'), '3');
            await keyboardInput(page, control('reason'), 'Family visit');
            await save();
            const rangeError = dialog.getByText(text.rangeError, { exact: true });
            await rangeError.waitFor();
            must(
              'ui.en.reversed-range-shows-translated-error-without-write',
              { visible: true, rows: 0, endFocused: true },
              {
                visible: await rangeError.isVisible(),
                rows: requestsOf().length,
                endFocused: await control('endDate').evaluate((element) => element === document.activeElement),
              },
            );
            await capture('2-reversed-range');
            await keyboardDate(page, control('endDate'), text.date('2026-03-04'));
            await save();
            await status.getByText(text.created(1), { exact: true }).waitFor();
            const [created] = requestsOf();
            v1RequestId = String(created?._id);
            labels.set(v1RequestId, '<request:v1>');
            must(
              'ui.en.create-persisted',
              { values: leave, version: 1, revision: 1, state: 'draft', requester: membership('A').membershipId },
              {
                values: created?.values,
                version: created?.version,
                revision: created?.revision,
                state: created?.state,
                requester: created?.requesterMembershipId,
              },
            );
            await rowWith('2026-03-02').waitFor();
            must(
              'ui.en.focus-returns-to-new-request',
              true,
              await page
                .getByRole('button', { name: text.newRequest, exact: true })
                .evaluate((element) => element === document.activeElement),
            );
            await capture('3-created');

            await page.reload();
            await page.getByRole('button', { name: text.signOut }).waitFor();
            await openRequests();
            const row = rowWith('2026-03-02');
            await row.waitFor();
            must(
              'ui.en.list-after-reload',
              ['Me', '2026-03-02', '2026-03-04', '3', 'V1'],
              (await row.locator('td').allInnerTexts()).slice(0, 5),
            );
            await keyboardActivate(page, row.getByRole('button', { name: text.openRow }));
            await dialog.getByText(text.versionTag(1), { exact: true }).waitFor();
            must(
              'ui.en.reopen-after-reload-matches',
              { startDate: '2026-03-02', endDate: '2026-03-04', days: '3', reason: 'Family visit' },
              await readDialog(['startDate', 'endDate', 'days', 'reason']),
            );
            await keyboardInput(page, control('days'), '2');
            await keyboardInput(page, control('reason'), 'Family visit, shorter');
            await save();
            await status.getByText(text.saved(2), { exact: true }).waitFor();
            must(
              'ui.en.edit-persisted',
              { revision: 2, values: { ...leave, days: 2, reason: 'Family visit, shorter' } },
              { revision: requestsOf()[0]?.revision, values: requestsOf()[0]?.values },
            );

            // The list's date filter follows the configured date rule: start on or after, end on or before.
            const fromFilter = page.getByLabel(text.filterFrom, { exact: true });
            const toFilter = page.getByLabel(text.filterTo, { exact: true });
            const noMatches = page.getByText(text.noMatches, { exact: true });
            await keyboardDate(page, fromFilter, text.date('2026-03-03'));
            await noMatches.waitFor();
            const startAfterRequest = { rows: await rowWith('2026-03-02').count(), empty: await noMatches.isVisible() };
            await capture('3a-filtered-out');
            await keyboardDate(page, fromFilter, text.date('2026-03-02'));
            await rowWith('2026-03-02').waitFor();
            const startOnRequest = await rowWith('2026-03-02').count();
            await keyboardDate(page, toFilter, text.date('2026-03-03'));
            await noMatches.waitFor();
            const endBeforeRequest = await rowWith('2026-03-02').count();
            await keyboardActivate(page, page.getByRole('button', { name: text.clearFilter, exact: true }));
            await rowWith('2026-03-02').waitFor();
            must(
              'ui.en.date-filter-narrows-the-list-on-the-server',
              {
                startAfterRequest: { rows: 0, empty: true },
                startOnRequest: 1,
                endBeforeRequest: 0,
                cleared: { rows: 1, from: '', to: '' },
              },
              {
                startAfterRequest,
                startOnRequest,
                endBeforeRequest,
                cleared: {
                  rows: await rowWith('2026-03-02').count(),
                  from: await fromFilter.inputValue(),
                  to: await toFilter.inputValue(),
                },
              },
            );

            // Publish V2 with an optional Note field and column through the #15 builder operations.
            const v2 = await publishDefinition('C', 'one', v2Definition);
            labels.set(v2.versionId, '<version:one:2>');
            const noteHeader = page.getByRole('columnheader', { name: text.labels.note });
            await noteHeader.waitFor();
            must(
              'ui.en.v2-column-appears-and-v1-row-shows-missing',
              ['Me', '2026-03-02', '2026-03-04', '2', text.missing, 'V1'],
              (await rowWith('2026-03-02').locator('td').allInnerTexts()).slice(0, 6),
            );
            const openButton = rowWith('2026-03-02').getByRole('button', { name: text.openRow });
            await keyboardActivate(page, openButton);
            await dialog.getByText(text.versionTag(1), { exact: true }).waitFor();
            must(
              'ui.en.v1-request-reopens-with-v1-form',
              [text.labels.startDate, text.labels.endDate, text.labels.days, text.labels.reason],
              await visibleLabels(),
            );
            await capture('4-v1-reopened-after-v2');
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            must(
              'ui.en.escape-returns-focus-to-opener',
              true,
              await openButton.evaluate((element) => element === document.activeElement),
            );

            const operationsBeforeV2Form = createOperations.length;
            await keyboardActivate(page, page.getByRole('button', { name: text.newRequest, exact: true }));
            await dialog.getByText(text.versionTag(2), { exact: true }).waitFor();
            must(
              'ui.en.new-request-uses-v2-form',
              [text.labels.startDate, text.labels.endDate, text.labels.days, text.labels.reason, text.labels.note],
              await visibleLabels(),
            );
            await keyboardDate(page, control('startDate'), text.date('2026-04-06'));
            await keyboardDate(page, control('endDate'), text.date('2026-04-07'));
            await keyboardInput(page, control('days'), '2');
            await keyboardInput(page, control('reason'), 'Conference');
            await keyboardInput(page, control('note'), 'Back Wednesday');

            // A newer version lands while the form is open: the save is refused and the typed values carry over.
            const v3 = await publishDefinition('C', 'one', v3Definition);
            labels.set(v3.versionId, '<version:one:3>');
            await save();
            const outdated = page.getByRole('alert').filter({ hasText: text.outdatedTitle });
            await outdated.waitFor();
            must('ui.en.outdated-create-refused-without-write', 1, requestsOf().length);
            await capture('5-outdated');
            await keyboardActivate(page, dialog.getByRole('button', { name: text.loadNewVersion, exact: true }));
            await dialog.getByText(text.versionTag(3), { exact: true }).waitFor();
            must(
              'ui.en.load-new-version-keeps-values',
              {
                startDate: '2026-04-06',
                endDate: '2026-04-07',
                days: '2',
                reason: 'Conference',
                note: 'Back Wednesday',
                contact: '',
              },
              await readDialog(['startDate', 'endDate', 'days', 'reason', 'note', 'contact']),
            );
            await save();
            await status.getByText(text.created(1), { exact: true }).waitFor();
            const v3Row = requestsOf().find((entry) => entry.version === 3);
            must(
              'ui.en.v3-request-persisted',
              {
                version: 3,
                values: {
                  startDate: '2026-04-06',
                  endDate: '2026-04-07',
                  days: 2,
                  reason: 'Conference',
                  note: 'Back Wednesday',
                },
              },
              { version: v3Row?.version, values: v3Row?.values },
            );
            const attempts = createOperations.slice(operationsBeforeV2Form);
            must(
              'ui.en.load-new-version-sends-a-new-operation-id',
              { attempts: 2, distinct: true, storedIsLatest: true },
              {
                attempts: attempts.length,
                distinct: new Set(attempts).size === attempts.length,
                storedIsLatest: v3Row?.operationId === attempts.at(-1),
              },
            );
            await rowWith('2026-04-06').waitFor();
            await capture('6-v3-created');

            await keyboardActivate(page, rowWith('2026-04-06').getByRole('button', { name: text.deleteRow }));
            await keyboardActivate(
              page,
              page.locator('.ant-popconfirm').getByRole('button', { name: text.deleteOk, exact: true }),
            );
            await status.getByText(text.deleted, { exact: true }).waitFor();
            await rowWith('2026-04-06').waitFor({ state: 'detached' });
            must(
              'ui.en.delete-removed-row',
              [v1RequestId],
              requestsOf().map((entry) => String(entry._id)),
            );
            await capture('7-deleted');
          } else {
            const row = rowWith('2026-03-02');
            await row.waitFor();
            must(
              'ui.zh.localized-list',
              { headers: true, filters: true, cells: ['我', '2026-03-02', '2026-03-04', '2', text.missing, 'V1'] },
              {
                filters:
                  (await page.getByLabel(text.filterFrom, { exact: true }).count()) === 1 &&
                  (await page.getByLabel(text.filterTo, { exact: true }).count()) === 1,
                headers:
                  (await page.getByRole('columnheader', { name: text.labels.startDate }).count()) === 1 &&
                  (await page.getByRole('columnheader', { name: text.versionColumn, exact: true }).count()) === 1,
                cells: (await row.locator('td').allInnerTexts()).slice(0, 6),
              },
            );
            await capture('1-list');
            await keyboardActivate(page, row.getByRole('button', { name: text.openRow }));
            await dialog.getByText(text.versionTag(1), { exact: true }).waitFor();
            await keyboardInput(page, control('reason'), '我的未保存修改');

            // A second client saves first; the stale save is refused and the typed reason stays in the form.
            const current = requestsOf()[0];
            const other = (await client('A').mutation(api.requests.update, {
              applicationId: app('one'),
              requestId: current?._id as Id<'requests'>,
              expectedRevision: Number(current?.revision),
              values: { ...leave, days: 2, reason: 'Changed elsewhere' },
            })) as { revision: number };
            await save();
            const conflict = page.getByRole('alert').filter({ hasText: text.conflictTitle });
            await conflict.waitFor();
            const focusedInsideAlert = await page.evaluate(() =>
              Boolean(document.activeElement?.querySelector('[role="alert"]')),
            );
            must(
              'ui.zh.stale-edit-conflict-keeps-input',
              {
                focusedInsideAlert: true,
                reason: '我的未保存修改',
                persisted: 'Changed elsewhere',
                revision: other.revision,
              },
              {
                focusedInsideAlert,
                reason: await control('reason').inputValue(),
                persisted: (requestsOf()[0]?.values as Row | undefined)?.reason,
                revision: requestsOf()[0]?.revision,
              },
            );
            await capture('2-conflict');

            const rejectedAttempts = 20;
            let settled = 0;
            for (let attempt = 1; attempt <= rejectedAttempts; attempt += 1) {
              const ready = await dialog
                .getByRole('button', { name: text.save, exact: true })
                .waitFor({ timeout: 2_000 })
                .then(
                  () => true,
                  () => false,
                );
              if (!ready) break;
              settled += 1;
              if (attempt === rejectedAttempts) break;
              const rejected = page.waitForEvent('console', (message) =>
                message.text().includes('RECORD_REVISION_CONFLICT'),
              );
              await save();
              await rejected;
              await dialog.locator('button.ant-btn-loading').waitFor({ state: 'hidden' });
            }
            must(
              'ui.zh.save-button-settles-after-rejected-saves',
              { settled: rejectedAttempts, revision: other.revision, reason: '我的未保存修改' },
              { settled, revision: requestsOf()[0]?.revision, reason: await control('reason').inputValue() },
            );

            await keyboardActivate(page, dialog.getByRole('button', { name: text.keepMine, exact: true }));
            await save();
            await status.getByText(text.saved(other.revision + 1), { exact: true }).waitFor();
            must(
              'ui.zh.keep-my-changes-saves-over-latest',
              { revision: other.revision + 1, values: { ...leave, days: 2, reason: '我的未保存修改' } },
              { revision: requestsOf()[0]?.revision, values: requestsOf()[0]?.values },
            );
            await capture('3-kept-and-saved');

            await keyboardActivate(page, rowWith('2026-03-02').getByRole('button', { name: text.deleteRow }));
            await keyboardActivate(
              page,
              page.locator('.ant-popconfirm').getByRole('button', { name: text.deleteOk, exact: true }),
            );
            await status.getByText(text.deleted, { exact: true }).waitFor();
            await page.getByText(text.empty, { exact: true }).waitFor();
            must('ui.zh.delete-empties-list', 0, requestsOf().length);
            await capture('4-empty-again');
          }
          must(`ui.${locale}.no-page-errors`, [], pageErrors);
        } catch (error) {
          await page
            .screenshot({ path: join(artifactsDir, `${locale}-failure.png`), fullPage: true })
            .catch(() => undefined);
          throw error;
        } finally {
          writeFileSync(join(artifactsDir, `${locale}-console.log`), `${consoleLines.join('\n')}\n`);
          const video = page.video();
          await context.close();
          if (video) renameSync(await video.path(), join(artifactsDir, `${locale}-requests.webm`));
        }
      }
      evidence.persisted = normalize(requestRows());
      check(
        'http.after-browser.other-members-see-nothing-of-A',
        { B: 0, R: 0, Z: 'APPLICATION_ACCESS_DENIED' },
        {
          B: await listTotal('B', app('one')),
          R: await listTotal('R', app('one')),
          Z: await listTotal('Z', app('one')),
        },
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    await browser?.close();
  }

  const fixtureApplicationIds = fixtureApplications();
  for (const organizationKey of seededOrganizations) {
    try {
      cleanup[organizationKey] = runInternal(envFile, 'fixtures:removeOrganization', { organizationKey });
    } catch (error) {
      cleanup[organizationKey] = `failed: ${errorMessage(error)}`;
    }
  }
  for (const target of actors) {
    if (!target.client) continue;
    const result = await target.auth.signOut();
    cleanup[`signOut.${target.key}`] = result.error ? 'failed' : 'ok';
  }
  check(
    'cleanup.fixture-and-request-rows-removed',
    {
      organizations: 0,
      applications: 0,
      memberships: 0,
      definitions: 0,
      definitionVersions: 0,
      requests: 0,
      requestCounts: 0,
    },
    {
      requestCounts: tableRows(envFile, 'requestCounts').filter((row) => fixtureApplicationIds.has(row.applicationId))
        .length,
      organizations: tableRows(envFile, 'organizations').filter(
        (row) => typeof row.key === 'string' && seededOrganizations.has(row.key),
      ).length,
      applications: tableRows(envFile, 'applications').filter((row) => fixtureApplicationIds.has(row._id)).length,
      memberships: tableRows(envFile, 'memberships').filter((row) => fixtureApplicationIds.has(row.applicationId))
        .length,
      definitions: tableRows(envFile, 'applicationDefinitions').filter((row) =>
        fixtureApplicationIds.has(row.applicationId),
      ).length,
      definitionVersions: tableRows(envFile, 'applicationDefinitionVersions').filter((row) =>
        fixtureApplicationIds.has(row.applicationId),
      ).length,
      requests: tableRows(envFile, 'requests').filter((row) => fixtureApplicationIds.has(row.applicationId)).length,
    },
  );

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    mode,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    target: { convexUrl, siteUrl, appUrl },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    error: failure === undefined ? null : errorMessage(failure),
    checks,
    cleanup: normalize(cleanup),
    retained: {
      betterAuthUsers: tableRows(envFile, 'user', 'betterAuth').length,
      betterAuthSessions: tableRows(envFile, 'session', 'betterAuth').length,
    },
  };
  const resultsName = mode === 'red' ? 'results-red.json' : 'results.json';
  writeFileSync(join(artifactsDir, resultsName), `${JSON.stringify(report, null, 2)}\n`);
  if (evidence.persisted) {
    writeFileSync(join(artifactsDir, 'persisted-requests.json'), `${JSON.stringify(evidence.persisted, null, 2)}\n`);
  }
  console.log(`Request journey (${mode}): ${report.summary.passed}/${report.summary.checks} checks passed.`);
  if (failure !== undefined || failed.length > 0) {
    if (failure !== undefined) console.error(`Request journey failed: ${errorMessage(failure)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Request journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
