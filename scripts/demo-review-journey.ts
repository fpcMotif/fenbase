#!/usr/bin/env bun

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Definition } from '../convex/definitionModel';
import type { Capability } from '../convex/membershipValidators';
import {
  keyboardActivate,
  keyboardDate,
  keyboardFocus,
  keyboardInput,
  outcomeOf,
  readPrivate,
  runInternal,
  tableRows,
} from './demo-request-journey';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';
import { leaveDefinition } from './leave-definition';

// Issue #17 verifier: submit, approve, reject and withdraw against an isolated local Convex backend. Modes:
//   red      the backend phase only, written to results-red.json (run before the commands exist)
//   backend  the backend phase only, written to results.json
//   full     the backend phase, two real browser sessions per language, and a backend and Vite restart
// Results are normalized (ids, times and the run id are labelled), so two runs of one mode write identical files.

type Mode = 'red' | 'backend' | 'full';
type Locale = 'en-US' | 'zh-CN';
type ActorKey = 'A' | 'B' | 'V' | 'C' | 'U' | 'I' | 'Z';
type OrganizationKey = 'one' | 'two';
type Row = Record<string, unknown>;
type Check = { id: string; expected: unknown; actual: unknown; pass: boolean };
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
type Transition = { requestId: Id<'requests'>; state: string; revision: number; eventId: string; replayed: boolean };
type Command = 'submit' | 'approve' | 'reject' | 'withdraw';
type Settled = { ok: boolean; value?: Transition; outcome?: string };

const artifactsDir = join('dist', 'review-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const viewport = { width: 1280, height: 900 };
const backendBinary = join(
  process.env.HOME ?? '',
  '.cache/convex/binaries/precompiled-2026-09-28-5c7cb5b/convex-local-backend',
);
const RACE_ROUNDS = 20;
const STALE_ATTEMPTS = 5;

const actorPlan: Array<Pick<Actor, 'key' | 'plan'>> = [
  { key: 'A', plan: [{ organization: 'one', capabilities: ['submitRequests'], status: 'active' }] },
  {
    key: 'B',
    plan: [{ organization: 'one', capabilities: ['submitRequests', 'reviewRequests'], status: 'active' }],
  },
  { key: 'V', plan: [{ organization: 'one', capabilities: ['reviewRequests'], status: 'active' }] },
  { key: 'C', plan: [{ organization: 'one', capabilities: ['configureApplication'], status: 'active' }] },
  { key: 'U', plan: [{ organization: 'one', capabilities: ['submitRequests'], status: 'active' }] },
  { key: 'I', plan: [{ organization: 'one', capabilities: ['reviewRequests'], status: 'inactive' }] },
  {
    key: 'Z',
    plan: [
      {
        organization: 'two',
        capabilities: ['submitRequests', 'reviewRequests', 'readApplicationRecords', 'configureApplication'],
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
    save: 'Save draft',
    submit: 'Submit for review',
    withdraw: 'Withdraw',
    withdrawOk: 'Withdraw',
    approve: 'Approve',
    reject: 'Reject',
    mine: 'My requests',
    assigned: 'Assigned to me',
    inboxPending: 'Waiting for me',
    inboxCompleted: 'Decided by me',
    inboxCancelled: 'Withdrawn by requester',
    inboxEmpty: 'Nothing is waiting for your review.',
    openRow: 'Open request',
    labels: { startDate: 'Start date', endDate: 'End date', days: 'Days', reason: 'Reason' },
    created: (revision: number) => `Draft created · revision ${revision}`,
    submitted: (revision: number) => `Request submitted · revision ${revision}`,
    withdrawn: (revision: number) => `Request withdrawn · revision ${revision}`,
    decided: { approve: 'Request approved', reject: 'Request rejected' },
    states: { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' },
    staleTitle: 'This request changed since you opened it',
    showLatest: 'Show latest',
    history: 'History',
    events: {
      submit: (actor: string) => `${actor} submitted the request`,
      approve: (actor: string) => `${actor} approved the request`,
      reject: (actor: string) => `${actor} rejected the request`,
      withdraw: (actor: string) => `${actor} withdrew the request`,
    },
    me: 'Me',
    member: (ref: string) => `Member ${ref}`,
    savedNotSubmitted: (revision: number) => `Draft saved · revision ${revision}. It was not submitted:`,
    reviewerUnavailable:
      'The reviewer of this form version can no longer review requests. Ask an administrator, or create a new request.',
    dates: { first: '2026-06-01', second: '2026-06-08', unavailable: '2026-08-03' },
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    requestsTab: '申请',
    newRequest: '新建申请',
    save: '保存草稿',
    submit: '提交审批',
    withdraw: '撤 回',
    withdrawOk: '撤 回',
    approve: '批 准',
    reject: '驳 回',
    mine: '我的申请',
    assigned: '待我审批',
    inboxPending: '等待我处理',
    inboxCompleted: '我已处理',
    inboxCancelled: '申请人已撤回',
    inboxEmpty: '没有等待你审批的申请。',
    openRow: '打开申请',
    labels: { startDate: '开始日期', endDate: '结束日期', days: '天数', reason: '原因' },
    created: (revision: number) => `草稿已创建 · 修订 ${revision}`,
    submitted: (revision: number) => `申请已提交 · 修订 ${revision}`,
    withdrawn: (revision: number) => `申请已撤回 · 修订 ${revision}`,
    decided: { approve: '申请已批准', reject: '申请已驳回' },
    states: { pending: '待审批', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回' },
    staleTitle: '此申请在你打开后已变化',
    showLatest: '显示最新内容',
    history: '处理记录',
    events: {
      submit: (actor: string) => `${actor}提交了申请`,
      approve: (actor: string) => `${actor}批准了申请`,
      reject: (actor: string) => `${actor}驳回了申请`,
      withdraw: (actor: string) => `${actor}撤回了申请`,
    },
    me: '我',
    member: (ref: string) => `成员 ${ref}`,
    savedNotSubmitted: (revision: number) => `草稿已保存 · 修订 ${revision}，但未提交：`,
    reviewerUnavailable: '此表单版本的审批人已无法审批申请。请联系管理员，或新建申请。',
    dates: { first: '2026-07-01', second: '2026-07-08', unavailable: '2026-09-07' },
  },
} as const;

const looseMutation = (name: string) => makeFunctionReference<'mutation', Record<string, unknown>, unknown>(name);
const looseQuery = (name: string) => makeFunctionReference<'query', Record<string, unknown>, unknown>(name);

function portOf(url: string): string {
  return new URL(url).port;
}

function listeningPid(port: string): number | undefined {
  try {
    const output = execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pid = Number(output.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function commandOf(pid: number): string {
  return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
}

async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function answers(url: string): Promise<boolean> {
  return fetch(url).then(
    (response) => response.status < 500,
    () => false,
  );
}

// Stops the process listening on `port` after checking its command line names the expected program.
async function stopListener(port: string, mustInclude: string): Promise<string> {
  const pid = listeningPid(port);
  assert(pid, `Nothing listens on port ${port}`);
  const command = commandOf(pid);
  assert(command.includes(mustInclude), `Port ${port} is not served by ${mustInclude}`);
  process.kill(pid, 'SIGTERM');
  await waitFor(`port ${port} to close`, () => listeningPid(port) === undefined);
  return command;
}

function memberRef(membershipId: string): string {
  return membershipId.slice(-6);
}

async function main(): Promise<void> {
  const requestedMode = process.env.REVIEW_JOURNEY_MODE?.trim() ?? 'full';
  assert(['red', 'backend', 'full'].includes(requestedMode), 'REVIEW_JOURNEY_MODE is red, backend or full');
  const mode = requestedMode as Mode;
  const dir = process.env.REVIEW_DIR?.trim();
  assert(dir, 'Set REVIEW_DIR to the isolated target directory');
  const envFile = join(dir, 'target.env');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Review journey requires an isolated local target');
  }
  const runId = readPrivate(dir, 'run-id');
  const password = readPrivate(dir, 'password');
  mkdirSync(artifactsDir, { recursive: true });
  const organizationKeys: Record<OrganizationKey, string> = {
    one: `fixture-rv17-one-${runId}`,
    two: `fixture-rv17-two-${runId}`,
  };

  const actors = actorPlan.map<Actor>((plan) => ({
    ...plan,
    email: `rv17-${plan.key.toLowerCase()}-${runId}@example.test`,
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
  const appOne = (): Id<'applications'> => membership('C').applicationId;

  const labels = new Map<string, string>();
  const memberReferences = new Map<string, string>();
  const timeKeys = new Set([
    'updatedAt',
    'publishedAt',
    '_creationTime',
    'operationFingerprint',
    'submittedAt',
    'decidedAt',
    'createdAt',
    'completedAt',
    'at',
  ]);
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const labelled = labels.get(value);
      if (labelled) return labelled;
      // The UI names other members by the last six characters of their membership id.
      let text = value.replaceAll(runId, '<run>');
      for (const [reference, label] of memberReferences) text = text.replaceAll(reference, label);
      return text;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key.replaceAll(runId, '<run>'), timeKeys.has(key) ? `<${key}>` : normalize(entry)]),
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

  const fixtureApplications = new Set<unknown>();
  const rowsOf = (table: 'requests' | 'reviewTasks' | 'requestEvents') =>
    tableRows(envFile, table)
      .filter((row) => fixtureApplications.has(row.applicationId))
      .sort((left, right) => String(left._id).localeCompare(String(right._id)));
  const reviewState = () => JSON.stringify([rowsOf('requests'), rowsOf('reviewTasks'), rowsOf('requestEvents')]);
  const requestRow = (requestId: string) => rowsOf('requests').find((row) => row._id === requestId);
  const taskOf = (requestId: string) => rowsOf('reviewTasks').filter((row) => row.requestId === requestId);
  const eventsOf = (requestId: string) =>
    rowsOf('requestEvents')
      .filter((row) => row.requestId === requestId)
      .sort((left, right) => Number(left.revision) - Number(right.revision));

  const deny = async (id: string, expected: string, operation: () => Promise<unknown>): Promise<void> => {
    const before = reviewState();
    let actual = 'succeeded';
    try {
      await operation();
    } catch (error) {
      actual = outcomeOf(error);
    }
    check(
      id,
      { outcome: expected, stateUnchanged: true },
      { outcome: actual, stateUnchanged: before === reviewState() },
    );
  };

  let operationCounter = 0;
  const operationId = (label: string) => {
    operationCounter += 1;
    return `rv17-${label}-${operationCounter}-${runId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  };

  const publishDefinition = async (definition: Definition) => {
    const applicationId = appOne();
    const state = await client('C').query(api.applicationDefinitions.getBuilderState, { applicationId });
    const saved = await client('C').mutation(api.applicationDefinitions.saveDraft, {
      applicationId,
      expectedRevision: state.head?.revision ?? 0,
      definition,
    });
    return client('C').mutation(api.applicationDefinitions.publish, {
      applicationId,
      expectedRevision: saved.revision,
    });
  };

  const leave = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Family visit' };
  let currentVersionId = '' as Id<'applicationDefinitionVersions'>;
  let requestCounter = 0;
  const draft = async (key: ActorKey, label: string, versionId = currentVersionId) => {
    requestCounter += 1;
    const created = (await client(key).mutation(looseMutation('requests:create'), {
      applicationId: appOne(),
      definitionVersionId: versionId,
      operationId: operationId(`create-${label}`),
      values: { ...leave, days: 1 + (requestCounter % 300) },
    })) as { requestId: Id<'requests'> };
    labels.set(created.requestId, `<request:${label}>`);
    return created.requestId;
  };
  const command = (
    key: ActorKey,
    name: Command,
    requestId: string,
    expectedRevision: number,
    opId = operationId(name),
  ) =>
    client(key).mutation(
      looseMutation(`requestReviews:${name}`),
      { applicationId: appOne(), requestId, expectedRevision, operationId: opId },
      { skipQueue: true },
    ) as Promise<Transition>;
  const settle = async (promise: Promise<Transition>): Promise<Settled> =>
    promise.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, outcome: outcomeOf(error) }),
    );
  const outcome = async (promise: Promise<unknown>) =>
    promise.then(
      (value) => value,
      (error: unknown) => outcomeOf(error),
    );
  const setMember = (key: ActorKey, status: 'active' | 'inactive', capabilities?: Capability[]) => {
    const entry = actor(key).plan[0];
    runInternal(envFile, 'fixtures:upsertMember', {
      organizationKey: organizationKeys[entry.organization],
      organizationName: `Review fixture ${entry.organization}`,
      authUserId: actor(key).authUserId,
      capabilities: capabilities ?? entry.capabilities,
      status,
    });
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
        const signup = await target.auth.signUp.email({ name: `RV17 ${target.key}`, email: target.email, password });
        assert(!signup.error, `Sign-up failed for actor ${target.key}`);
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      }
      const viewer = await target.client.query(api.users.getViewer, {});
      target.authUserId = viewer.id;
      labels.set(viewer.id, `<authUser:${target.key}>`);
      for (const entry of target.plan) {
        const organizationKey = organizationKeys[entry.organization];
        const seeded = runInternal<Membership>(envFile, 'fixtures:upsertMember', {
          organizationKey,
          organizationName: `Review fixture ${entry.organization}`,
          authUserId: viewer.id,
          capabilities: entry.capabilities,
          status: entry.status,
        });
        seededOrganizations.add(organizationKey);
        fixtureApplications.add(seeded.applicationId);
        target.memberships[entry.organization] = seeded;
        labels.set(seeded.membershipId, `<membership:${target.key}>`);
        memberReferences.set(memberRef(seeded.membershipId), `<ref:${target.key}>`);
        labels.set(seeded.applicationId, `<application:${entry.organization}>`);
        labels.set(seeded.organizationId, `<organization:${entry.organization}>`);
      }
    }

    const v1Definition: Definition = {
      ...leaveDefinition(membership('B').membershipId),
      listColumns: ['requester', 'startDate', 'endDate', 'days'],
    };
    const v1 = await publishDefinition(v1Definition);
    labels.set(v1.versionId, '<version:1>');
    currentVersionId = v1.versionId;

    // RUN-01: submit writes the pending state, one task assigned from the pinned version and one event together.
    const run1 = await draft('A', 'run1');
    const submitOperation = operationId('submit-run1');
    const submitted = await settle(command('A', 'submit', run1, 1, submitOperation));
    if (submitted.ok) labels.set(submitted.value.eventId, '<event:run1:submit>');
    check(
      'RUN-01.submit-returns-pending',
      { ok: true, state: 'pending', revision: 2, replayed: false },
      submitted.ok
        ? {
            ok: true,
            state: submitted.value.state,
            revision: submitted.value.revision,
            replayed: submitted.value.replayed,
          }
        : { ok: false, outcome: submitted.outcome },
    );
    check(
      'RUN-01.persisted-request-task-and-event',
      {
        request: { state: 'pending', revision: 2, reviewer: membership('B').membershipId, version: 1 },
        tasks: [{ status: 'pending', reviewer: membership('B').membershipId, version: 1, versionId: v1.versionId }],
        events: [{ command: 'submit', from: 'draft', to: 'pending', revision: 2, actor: membership('A').membershipId }],
      },
      {
        request: {
          state: requestRow(run1)?.state,
          revision: requestRow(run1)?.revision,
          reviewer: requestRow(run1)?.reviewerMembershipId,
          version: requestRow(run1)?.version,
        },
        tasks: taskOf(run1).map((task) => ({
          status: task.status,
          reviewer: task.reviewerMembershipId,
          version: task.version,
          versionId: task.definitionVersionId,
        })),
        events: eventsOf(run1).map((event) => ({
          command: event.command,
          from: event.fromState,
          to: event.toState,
          revision: event.revision,
          actor: event.actorMembershipId,
        })),
      },
    );
    const beforeReplay = reviewState();
    const replay = await settle(command('A', 'submit', run1, 1, submitOperation));
    check(
      'RUN-01.duplicate-submit-returns-original-without-writes',
      { replayed: true, sameEvent: true, unchanged: true },
      {
        replayed: replay.ok ? replay.value.replayed : replay.outcome,
        sameEvent: replay.ok && submitted.ok && replay.value.eventId === submitted.value.eventId,
        unchanged: beforeReplay === reviewState(),
      },
    );

    // AUTH-01: every caller other than the assigned reviewer or the requester is denied without a state change.
    const anonymous = new ConvexHttpClient(convexUrl);
    const commandArgs = { applicationId: appOne(), requestId: run1, expectedRevision: 2 };
    await deny('AUTH-01.approve.anonymous', 'Unauthenticated', () =>
      anonymous.mutation(looseMutation('requestReviews:approve'), { ...commandArgs, operationId: operationId('anon') }),
    );
    await deny('AUTH-01.approve.unrelated-employee', 'RECORD_NOT_FOUND', () => command('U', 'approve', run1, 2));
    await deny('AUTH-01.approve.reviewer-of-another-version', 'RECORD_NOT_FOUND', () =>
      command('V', 'approve', run1, 2),
    );
    await deny('AUTH-01.approve.inactive-member', 'APPLICATION_ACCESS_DENIED', () => command('I', 'approve', run1, 2));
    await deny('AUTH-01.approve.second-organization', 'APPLICATION_ACCESS_DENIED', () =>
      command('Z', 'approve', run1, 2),
    );
    await deny('AUTH-01.approve.requester-self-review', 'REQUEST_SELF_REVIEW', () => command('A', 'approve', run1, 2));
    await deny('AUTH-01.withdraw.reviewer', 'PERMISSION_DENIED', () => command('B', 'withdraw', run1, 2));
    await deny('AUTH-01.withdraw.unrelated-employee', 'RECORD_NOT_FOUND', () => command('U', 'withdraw', run1, 2));
    await deny('AUTH-01.approve.malformed-operation-id', 'RECORD_OPERATION_ID_INVALID', () =>
      command('B', 'approve', run1, 2, 'no'),
    );
    await deny('AUTH-01.approve.stale-revision', 'RECORD_REVISION_CONFLICT', () => command('B', 'approve', run1, 1));
    const selfDraft = await draft('B', 'self-review');
    await deny('AUTH-01.submit.reviewer-is-requester', 'REQUEST_SELF_REVIEW', () =>
      command('B', 'submit', selfDraft, 1),
    );
    check(
      'AUTH-01.inbox-and-reads',
      {
        reviewerInbox: [run1],
        otherReviewerInbox: [],
        requesterInbox: 'PERMISSION_DENIED',
        unrelatedGet: null,
        foreignGet: 'APPLICATION_ACCESS_DENIED',
        unrelatedHistory: null,
      },
      {
        reviewerInbox: await outcome(
          client('B')
            .query(api.requestReviews.inbox, { applicationId: appOne(), status: 'pending' })
            .then((value) => value.items.map((item) => item._id)),
        ),
        otherReviewerInbox: await outcome(
          client('V')
            .query(api.requestReviews.inbox, { applicationId: appOne(), status: 'pending' })
            .then((value) => value.items.map((item) => item._id)),
        ),
        requesterInbox: await outcome(
          client('A').query(api.requestReviews.inbox, { applicationId: appOne(), status: 'pending' }),
        ),
        unrelatedGet: await outcome(
          client('U').query(looseQuery('requests:get'), { applicationId: appOne(), requestId: run1 }),
        ),
        foreignGet: await outcome(
          client('Z').query(looseQuery('requests:get'), { applicationId: appOne(), requestId: run1 }),
        ),
        unrelatedHistory: await outcome(
          client('U').query(looseQuery('requestReviews:history'), { applicationId: appOne(), requestId: run1 }),
        ),
      },
    );

    // BYPASS-01: generic edits and forged arguments cannot change state, requester, reviewer or version.
    const requestArgs = { applicationId: appOne(), requestId: run1, expectedRevision: 2 };
    await deny('BYPASS-01.update-pending', 'REQUEST_STATE_CONFLICT', () =>
      client('A').mutation(looseMutation('requests:update'), { ...requestArgs, values: { ...leave, days: 9 } }),
    );
    await deny('BYPASS-01.remove-pending', 'REQUEST_STATE_CONFLICT', () =>
      client('A').mutation(looseMutation('requests:remove'), requestArgs),
    );
    for (const [name, value] of [
      ['state', 'approved'],
      ['reviewerMembershipId', membership('V').membershipId],
      ['requesterMembershipId', membership('U').membershipId],
      ['version', 2],
      ['definitionVersionId', v1.versionId],
    ] as const) {
      await deny(`BYPASS-01.submit-forged-argument.${name}`, 'ArgumentValidationError', () =>
        client('A').mutation(looseMutation('requestReviews:submit'), {
          ...requestArgs,
          operationId: operationId('forged'),
          [name]: value,
        }),
      );
    }
    await deny('BYPASS-01.draft-values-cannot-set-state', 'RECORD_FIELD_SERVER_OWNED', () =>
      client('B').mutation(looseMutation('requests:update'), {
        applicationId: appOne(),
        requestId: selfDraft,
        expectedRevision: 1,
        values: { ...leave, state: 'approved' },
      }),
    );

    // RUN-02: the reviewer approves one request and rejects another; terminal states accept nothing more.
    const run2 = await draft('A', 'run2');
    await command('A', 'submit', run2, 1);
    const approveOperation = operationId('approve-run1');
    const approved = await settle(command('B', 'approve', run1, 2, approveOperation));
    const rejected = await settle(command('B', 'reject', run2, 2));
    check(
      'RUN-02.decisions',
      { approved: 'approved', rejected: 'rejected' },
      {
        approved: approved.ok ? approved.value.state : approved.outcome,
        rejected: rejected.ok ? rejected.value.state : rejected.outcome,
      },
    );
    const replayedDecision = await settle(command('B', 'approve', run1, 2, approveOperation));
    check(
      'RUN-02.repeated-decision-returns-original',
      { replayed: true, sameEvent: true },
      {
        replayed: replayedDecision.ok ? replayedDecision.value.replayed : replayedDecision.outcome,
        sameEvent: replayedDecision.ok && approved.ok && replayedDecision.value.eventId === approved.value.eventId,
      },
    );
    await deny('RUN-02.reused-operation-id-for-reject', 'RECORD_OPERATION_CONFLICT', () =>
      command('B', 'reject', run1, 2, approveOperation),
    );
    // A replay checks the actor's current access first, so a reviewer who lost access cannot replay the decision.
    setMember('B', 'active', ['submitRequests']);
    await deny('RUN-02.replay-after-losing-reviewRequests', 'RECORD_NOT_FOUND', () =>
      command('B', 'approve', run1, 2, approveOperation),
    );
    setMember('B', 'inactive');
    await deny('RUN-02.replay-by-inactive-reviewer', 'APPLICATION_ACCESS_DENIED', () =>
      command('B', 'approve', run1, 2, approveOperation),
    );
    setMember('B', 'active');
    const restoredReplay = await settle(command('B', 'approve', run1, 2, approveOperation));
    check(
      'RUN-02.replay-after-access-restored-returns-original',
      { replayed: true, sameEvent: true },
      {
        replayed: restoredReplay.ok ? restoredReplay.value.replayed : restoredReplay.outcome,
        sameEvent: restoredReplay.ok && approved.ok && restoredReplay.value.eventId === approved.value.eventId,
      },
    );
    for (const [name, key] of [
      ['approve', 'B'],
      ['reject', 'B'],
      ['withdraw', 'A'],
    ] as const) {
      await deny(`RUN-02.terminal-refuses-${name}`, 'REQUEST_STATE_CONFLICT', () => command(key, name, run1, 3));
    }
    await deny('RUN-02.terminal-refuses-generic-remove', 'REQUEST_STATE_CONFLICT', () =>
      client('A').mutation(looseMutation('requests:remove'), { ...requestArgs, expectedRevision: 3 }),
    );
    type EventView = { command: string; toState: string; revision: number; actor: { membershipId: string } };
    const historyOf = async (key: ActorKey, requestId: string) =>
      (
        (await client(key).query(looseQuery('requestReviews:history'), { applicationId: appOne(), requestId })) as {
          events: EventView[];
        } | null
      )?.events.map((event) => [event.command, event.toState, event.revision, event.actor.membershipId]);
    check(
      'RUN-02.history-attributes-each-transition',
      {
        requester: [
          ['submit', 'pending', 2, membership('A').membershipId],
          ['approve', 'approved', 3, membership('B').membershipId],
        ],
        reviewer: [
          ['submit', 'pending', 2, membership('A').membershipId],
          ['reject', 'rejected', 3, membership('B').membershipId],
        ],
        tasks: [
          ['completed', 'approved'],
          ['completed', 'rejected'],
        ],
      },
      {
        requester: await historyOf('A', run1),
        reviewer: await historyOf('B', run2),
        tasks: [...taskOf(run1), ...taskOf(run2)].map((task) => [task.status, task.outcome]),
      },
    );

    // VERSION-01: V2 names reviewer V; V1 requests keep reviewer B, even when submitted after V2.
    const v1Pending = await draft('A', 'v1-pending');
    await command('A', 'submit', v1Pending, 1);
    const v1Draft = await draft('A', 'v1-draft');
    const v2 = await publishDefinition({ ...v1Definition, reviewerMembershipId: membership('V').membershipId });
    labels.set(v2.versionId, '<version:2>');
    currentVersionId = v2.versionId;
    const lateSubmit = await settle(command('A', 'submit', v1Draft, 1));
    const v2Request = await draft('A', 'v2');
    await command('A', 'submit', v2Request, 1);
    check(
      'VERSION-01.v1-requests-keep-reviewer-b',
      {
        lateSubmit: 'pending',
        v1Pending: { version: 1, reviewer: membership('B').membershipId },
        v1Draft: { version: 1, reviewer: membership('B').membershipId },
        v2: { version: 2, reviewer: membership('V').membershipId },
        vInbox: [v2Request],
      },
      {
        lateSubmit: lateSubmit.ok ? lateSubmit.value.state : lateSubmit.outcome,
        v1Pending: { version: requestRow(v1Pending)?.version, reviewer: requestRow(v1Pending)?.reviewerMembershipId },
        v1Draft: { version: requestRow(v1Draft)?.version, reviewer: requestRow(v1Draft)?.reviewerMembershipId },
        v2: { version: requestRow(v2Request)?.version, reviewer: requestRow(v2Request)?.reviewerMembershipId },
        vInbox: (
          await client('V').query(api.requestReviews.inbox, { applicationId: appOne(), status: 'pending' })
        ).items.map((item) => item._id),
      },
    );
    await deny('VERSION-01.v2-reviewer-cannot-decide-v1', 'RECORD_NOT_FOUND', () =>
      command('V', 'approve', v1Pending, 2),
    );
    setMember('B', 'inactive');
    await deny('VERSION-01.inactive-b-denied', 'APPLICATION_ACCESS_DENIED', () =>
      command('B', 'approve', v1Pending, 2),
    );
    check(
      'VERSION-01.task-stays-pending-while-b-inactive',
      ['pending'],
      taskOf(v1Pending).map((task) => task.status),
    );
    setMember('B', 'active');
    const afterReactivation = await settle(command('B', 'approve', v1Pending, 2));
    const v2Decision = await settle(command('V', 'reject', v2Request, 2));
    check(
      'VERSION-01.each-pinned-reviewer-decides-own-version',
      { v1: 'approved', v2: 'rejected' },
      {
        v1: afterReactivation.ok ? afterReactivation.value.state : afterReactivation.outcome,
        v2: v2Decision.ok ? v2Decision.value.state : v2Decision.outcome,
      },
    );
    await command('B', 'approve', v1Draft, 2);

    // RACE-01: concurrent duplicates and opposing commands on real Convex reconcile to one effect. New requests use V2,
    // so V is their reviewer.
    const race = { duplicateSubmitOneEffect: 0, opposingOneWinner: 0, withdrawRaceOneWinner: 0 };
    const loserCodes = new Set<string>();
    const raceLog: unknown[] = [];
    for (let round = 1; round <= RACE_ROUNDS; round += 1) {
      const opposed = await draft('A', `race-${round}-opposed`);
      const sameId = operationId(`race-${round}-submit`);
      const duplicates = await Promise.all([
        settle(command('A', 'submit', opposed, 1, sameId)),
        settle(command('A', 'submit', opposed, 1, sameId)),
      ]);
      const ok = duplicates.flatMap((entry) => (entry.ok ? [entry.value] : []));
      if (
        ok.length === 2 &&
        ok[0].eventId === ok[1].eventId &&
        ok.filter((entry) => entry.replayed).length === 1 &&
        eventsOf(opposed).length === 1 &&
        taskOf(opposed).length === 1
      ) {
        race.duplicateSubmitOneEffect += 1;
      }

      const decisions = await Promise.all([
        settle(command('V', 'approve', opposed, 2)),
        settle(command('V', 'reject', opposed, 2)),
      ]);
      const winners = decisions.flatMap((entry) => (entry.ok ? [entry.value] : []));
      decisions.forEach((entry) => {
        if (!entry.ok) loserCodes.add(entry.outcome);
      });
      const opposedRow = requestRow(opposed);
      const opposedTask = taskOf(opposed);
      if (
        winners.length === 1 &&
        opposedRow?.state === winners[0].state &&
        opposedRow.revision === 3 &&
        eventsOf(opposed).length === 2 &&
        opposedTask.length === 1 &&
        opposedTask[0].status === 'completed' &&
        opposedTask[0].outcome === winners[0].state
      ) {
        race.opposingOneWinner += 1;
      }

      const contested = await draft('A', `race-${round}-withdraw`);
      await command('A', 'submit', contested, 1);
      const contest = await Promise.all([
        settle(command('V', 'approve', contested, 2)),
        settle(command('A', 'withdraw', contested, 2)),
      ]);
      const contestWinners = contest.flatMap((entry) => (entry.ok ? [entry.value] : []));
      contest.forEach((entry) => {
        if (!entry.ok) loserCodes.add(entry.outcome);
      });
      const contestedRow = requestRow(contested);
      const contestedTask = taskOf(contested);
      if (
        contestWinners.length === 1 &&
        contestedRow?.state === contestWinners[0].state &&
        eventsOf(contested).length === 2 &&
        contestedTask.length === 1 &&
        contestedTask[0].status === (contestWinners[0].state === 'withdrawn' ? 'cancelled' : 'completed')
      ) {
        race.withdrawRaceOneWinner += 1;
      }
      raceLog.push({
        round,
        opposedWinner: winners.map((entry) => entry.state),
        contestedWinner: contestWinners.map((entry) => entry.state),
      });
    }
    evidence.raceLog = raceLog;
    check(
      'RACE-01.each-race-has-one-effect',
      {
        duplicateSubmitOneEffect: RACE_ROUNDS,
        opposingOneWinner: RACE_ROUNDS,
        withdrawRaceOneWinner: RACE_ROUNDS,
        loserCodes: ['REQUEST_STATE_CONFLICT'],
      },
      { ...race, loserCodes: [...loserCodes].sort() },
    );

    if (mode === 'full') {
      browser = await chromium.launch({ channel: 'chrome' });
      const activeBrowser = browser;
      const openSession = async (key: ActorKey, locale: Locale, name: string) => {
        const context = await activeBrowser.newContext({
          locale,
          viewport,
          recordVideo: { dir: artifactsDir, size: viewport },
        });
        const page = await context.newPage();
        await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
        page.setDefaultTimeout(20_000);
        const errors: string[] = [];
        const consoleLines: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          consoleLines.push(`${message.type()}: ${message.text()}`);
          if (message.type() === 'error' && !/\[CONVEX M\(requestReviews:/.test(message.text())) {
            errors.push(message.text());
          }
        });
        const text = texts[locale];
        await page.goto(appUrl);
        await keyboardInput(page, page.getByLabel(text.email, { exact: true }), actor(key).email);
        await keyboardInput(page, page.getByLabel(text.password, { exact: true }), password);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: text.signOut }).waitFor();
        return { context, page, errors, consoleLines, name, locale };
      };
      type Session = Awaited<ReturnType<typeof openSession>>;
      const closeSession = async (session: Session) => {
        writeFileSync(join(artifactsDir, `${session.name}-console.log`), `${session.consoleLines.join('\n')}\n`);
        const video = session.page.video();
        await session.context.close();
        if (video) renameSync(await video.path(), join(artifactsDir, `${session.name}.webm`));
      };
      const capture = async (session: Session, step: string) => {
        await session.page.locator('button.ant-btn-loading').first().waitFor({ state: 'hidden' });
        await session.page.screenshot({
          path: join(artifactsDir, `${session.name}-${step}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      };
      const openRequests = async (page: Page, locale: Locale) => {
        const target = page.getByRole('tab', { name: texts[locale].requestsTab });
        await target.waitFor();
        await keyboardFocus(page, page.getByRole('tab', { selected: true }));
        for (let presses = 0; presses < 5; presses += 1) {
          if (await target.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: `${texts[locale].requestsTab} · Leave requests` }).waitFor();
      };
      const chooseRadio = async (page: Page, name: string) => {
        const radio = page.getByRole('radio', { name, exact: true });
        if (await radio.isChecked()) return;
        // Segmented options are visually hidden radio inputs; Tab passes the group itself, then lands on the checked one.
        const group = radio.locator('xpath=ancestor::*[@role="radiogroup"][1]');
        await group.waitFor();
        for (let presses = 0; presses < 250; presses += 1) {
          const inside = await group.evaluate(
            (element) => element !== document.activeElement && element.contains(document.activeElement),
          );
          if (inside) break;
          await page.keyboard.press('Tab');
        }
        for (let presses = 0; presses < 4 && !(await radio.isChecked()); presses += 1) {
          await page.keyboard.press('ArrowRight');
        }
        assert(await radio.isChecked(), `Keyboard could not select ${name}`);
      };
      const waitUntilDialogOpenedAndFocused = (page: Page) =>
        page.waitForFunction(() => Boolean(document.activeElement?.closest('.ant-modal-wrap')));
      const rowWith = (page: Page, value: string) => page.getByRole('row').filter({ hasText: value });
      const dialogOf = (page: Page) => page.getByRole('dialog');
      const button = (scope: Page | Locator, name: string) => scope.getByRole('button', { name, exact: true });
      const fillAndCreate = async (session: Session, startDate: string, reason: string) => {
        const { page, locale } = session;
        const text = texts[locale];
        const dialog = dialogOf(page);
        await keyboardActivate(page, button(page, text.newRequest));
        await keyboardDate(
          page,
          dialog.getByLabel(text.labels.startDate, { exact: true }),
          startDate.replaceAll('-', ''),
        );
        await keyboardDate(
          page,
          dialog.getByLabel(text.labels.endDate, { exact: true }),
          startDate.replaceAll('-', ''),
        );
        await keyboardInput(page, dialog.getByLabel(text.labels.days, { exact: true }), '1');
        await keyboardInput(page, dialog.getByLabel(text.labels.reason, { exact: true }), reason);
        await keyboardActivate(page, button(dialog, text.save));
        await page.locator('output').getByText(text.created(1), { exact: true }).waitFor();
        await rowWith(page, startDate).waitFor();
      };
      const openRow = async (page: Page, locale: Locale, startDate: string) => {
        await keyboardActivate(page, rowWith(page, startDate).getByRole('button', { name: texts[locale].openRow }));
        await dialogOf(page).waitFor();
      };
      const requestByDate = (startDate: string) =>
        rowsOf('requests').find(
          (row) =>
            row.requesterMembershipId === membership('A').membershipId &&
            (row.values as Row | undefined)?.startDate === startDate,
        );
      const historyLines = async (page: Page, locale: Locale) =>
        dialogOf(page)
          .getByRole('region', { name: texts[locale].history })
          .locator('.ant-timeline-item-content > div:first-child')
          .allInnerTexts();

      for (const locale of ['en-US', 'zh-CN'] as const) {
        const text = texts[locale];
        const decision: 'approve' | 'reject' = locale === 'en-US' ? 'approve' : 'reject';
        const decidedState = decision === 'approve' ? 'approved' : 'rejected';
        const tag = locale === 'en-US' ? 'en' : 'zh';
        const [requester, reviewer] = await Promise.all([
          openSession('A', locale, `${locale}-requester`),
          openSession('V', locale, `${locale}-reviewer`),
        ]);
        const aRef = memberRef(membership('A').membershipId);
        try {
          await Promise.all([openRequests(requester.page, locale), openRequests(reviewer.page, locale)]);
          await chooseRadio(reviewer.page, text.assigned);
          await chooseRadio(reviewer.page, text.inboxPending);
          await reviewer.page.getByText(text.inboxEmpty, { exact: true }).waitFor();
          await capture(reviewer, '1-inbox-empty');

          // The requester saves and submits a draft; the reviewer's inbox updates without a reload.
          await fillAndCreate(requester, text.dates.first, `Trip ${tag}`);
          await openRow(requester.page, locale, text.dates.first);
          await keyboardActivate(requester.page, button(dialogOf(requester.page), text.submit));
          await requester.page.locator('output').getByText(text.submitted(2), { exact: true }).waitFor();
          const first = requestByDate(text.dates.first);
          const firstId = String(first?._id);
          labels.set(firstId, `<request:ui-${tag}-first>`);
          must(
            `ui.${tag}.submit-persists-pending-task-and-event`,
            { state: 'pending', reviewer: membership('V').membershipId, tasks: ['pending'], events: ['submit'] },
            {
              state: first?.state,
              reviewer: first?.reviewerMembershipId,
              tasks: taskOf(firstId).map((task) => task.status),
              events: eventsOf(firstId).map((event) => event.command),
            },
          );
          await rowWith(requester.page, text.dates.first).getByText(text.states.pending, { exact: true }).waitFor();
          await capture(requester, '2-submitted');
          await rowWith(reviewer.page, text.dates.first).waitFor();
          must(
            `ui.${tag}.inbox-receives-submission-live`,
            { requester: text.member(aRef), state: text.states.pending },
            {
              requester: await rowWith(reviewer.page, text.dates.first).locator('td').first().innerText(),
              state: await rowWith(reviewer.page, text.dates.first)
                .getByText(text.states.pending, { exact: true })
                .innerText(),
            },
          );
          await capture(reviewer, '2-inbox-live');

          // A second request is withdrawn while the reviewer has it open: the stale approval is refused.
          await fillAndCreate(requester, text.dates.second, `Course ${tag}`);
          await openRow(requester.page, locale, text.dates.second);
          await keyboardActivate(requester.page, button(dialogOf(requester.page), text.submit));
          await requester.page.locator('output').getByText(text.submitted(2), { exact: true }).waitFor();
          const secondId = String(requestByDate(text.dates.second)?._id);
          labels.set(secondId, `<request:ui-${tag}-second>`);
          await rowWith(reviewer.page, text.dates.second).waitFor();
          await openRow(reviewer.page, locale, text.dates.second);
          const reviewDialog = dialogOf(reviewer.page);
          await button(reviewDialog, text.approve).waitFor();

          await openRow(requester.page, locale, text.dates.second);
          await keyboardActivate(requester.page, button(dialogOf(requester.page), text.withdraw));
          await keyboardActivate(
            requester.page,
            requester.page.locator('.ant-popconfirm').getByRole('button', { name: text.withdrawOk, exact: true }),
          );
          await requester.page.locator('output').getByText(text.withdrawn(3), { exact: true }).waitFor();

          let settled = 0;
          for (let attempt = 1; attempt <= STALE_ATTEMPTS; attempt += 1) {
            const refused = reviewer.page.waitForEvent('console', (message) =>
              message.text().includes('REQUEST_STATE_CONFLICT'),
            );
            await keyboardActivate(reviewer.page, button(reviewDialog, text.approve));
            await refused;
            await reviewDialog.locator('button.ant-btn-loading').waitFor({ state: 'hidden' });
            const ready = await button(reviewDialog, text.approve)
              .waitFor({ timeout: 2_000 })
              .then(
                () => true,
                () => false,
              );
            if (ready) settled += 1;
          }
          const stale = reviewer.page.getByRole('alert').filter({ hasText: text.staleTitle });
          await stale.waitFor();
          const focusedInsideAlert = await reviewer.page.evaluate(() =>
            Boolean(document.activeElement?.querySelector('[role="alert"]')),
          );
          must(
            `ui.${tag}.stale-approval-refused-after-withdraw`,
            {
              focusedInsideAlert: true,
              settled: STALE_ATTEMPTS,
              state: 'withdrawn',
              events: ['submit', 'withdraw'],
              task: ['cancelled'],
            },
            {
              focusedInsideAlert,
              settled,
              state: requestRow(secondId)?.state,
              events: eventsOf(secondId).map((event) => event.command),
              task: taskOf(secondId).map((task) => task.status),
            },
          );
          await capture(reviewer, '3-stale-refused');
          await keyboardActivate(reviewer.page, button(reviewDialog, text.showLatest));
          await button(reviewDialog, text.approve).waitFor({ state: 'detached' });
          must(
            `ui.${tag}.show-latest-hides-decision-and-shows-history`,
            [text.events.submit(text.member(aRef)), text.events.withdraw(text.member(aRef))],
            await historyLines(reviewer.page, locale),
          );
          await reviewer.page.keyboard.press('Escape');
          await reviewDialog.waitFor({ state: 'hidden' });

          // The reviewer decides the first request; the requester's list follows without a reload.
          await openRow(reviewer.page, locale, text.dates.first);
          must(
            `ui.${tag}.reviewer-sees-read-only-values`,
            { reason: `Trip ${tag}`, disabled: true },
            {
              reason: await reviewDialog.getByLabel(text.labels.reason, { exact: true }).inputValue(),
              disabled: await reviewDialog.getByLabel(text.labels.reason, { exact: true }).isDisabled(),
            },
          );
          await capture(reviewer, '4-review-open');
          await keyboardActivate(reviewer.page, button(reviewDialog, text[decision]));
          await reviewer.page
            .locator('output')
            .getByText(`${text.decided[decision]} · ${locale === 'en-US' ? 'revision' : '修订'} 3`, { exact: true })
            .waitFor();
          await rowWith(requester.page, text.dates.first)
            .getByText(text.states[decidedState], { exact: true })
            .waitFor();
          must(
            `ui.${tag}.decision-persisted-and-live-for-requester`,
            { state: decidedState, task: [['completed', decidedState]], events: ['submit', decision] },
            {
              state: requestRow(firstId)?.state,
              task: taskOf(firstId).map((task) => [task.status, task.outcome]),
              events: eventsOf(firstId).map((event) => event.command),
            },
          );
          await capture(requester, '3-decided-live');

          // Reload both sessions: the history and the reviewer's completed list come back from the backend.
          await Promise.all([requester.page.reload(), reviewer.page.reload()]);
          await Promise.all([openRequests(requester.page, locale), openRequests(reviewer.page, locale)]);
          await openRow(requester.page, locale, text.dates.first);
          await dialogOf(requester.page).getByRole('region', { name: text.history }).waitFor();
          must(
            `ui.${tag}.history-after-reload`,
            {
              lines: [
                text.events.submit(text.me),
                text.events[decision](text.member(memberRef(membership('V').membershipId))),
              ],
              actions: 0,
            },
            {
              lines: await historyLines(requester.page, locale),
              actions:
                (await button(dialogOf(requester.page), text.submit).count()) +
                (await button(dialogOf(requester.page), text.withdraw).count()),
            },
          );
          await capture(requester, '4-history-after-reload');
          await chooseRadio(reviewer.page, text.assigned);
          await chooseRadio(reviewer.page, text.inboxCompleted);
          await rowWith(reviewer.page, text.dates.first)
            .getByText(text.states[decidedState], { exact: true })
            .waitFor();
          await capture(reviewer, '5-completed-after-reload');

          await chooseRadio(reviewer.page, text.inboxCancelled);
          await rowWith(reviewer.page, text.dates.second).getByText(text.states.withdrawn, { exact: true }).waitFor();
          await openRow(reviewer.page, locale, text.dates.second);
          await dialogOf(reviewer.page).getByRole('region', { name: text.history }).waitFor();
          must(
            `ui.${tag}.reviewer-reopens-withdrawn-request`,
            {
              lines: [text.events.submit(text.member(aRef)), text.events.withdraw(text.member(aRef))],
              actions: 0,
            },
            {
              lines: await historyLines(reviewer.page, locale),
              actions:
                (await button(dialogOf(reviewer.page), text.approve).count()) +
                (await button(dialogOf(reviewer.page), text.reject).count()),
            },
          );
          await capture(reviewer, '6-withdrawn-reopened');
          await waitUntilDialogOpenedAndFocused(reviewer.page);
          await reviewer.page.keyboard.press('Escape');
          await dialogOf(reviewer.page).waitFor({ state: 'hidden' });
          must(
            `ui.${tag}.no-page-errors`,
            { requester: [], reviewer: [] },
            {
              requester: requester.errors,
              reviewer: reviewer.errors,
            },
          );
        } catch (error) {
          await Promise.all(
            [requester, reviewer].map((session) =>
              session.page
                .screenshot({ path: join(artifactsDir, `${session.name}-failure.png`), fullPage: true })
                .catch(() => undefined),
            ),
          );
          throw error;
        } finally {
          await Promise.all([closeSession(requester), closeSession(reviewer)]);
        }
      }

      const requester = await openSession('A', 'en-US', 'en-US-requester-unavailable-reviewer');
      try {
        const text = texts['en-US'];
        const { page } = requester;
        await openRequests(page, 'en-US');
        await fillAndCreate(requester, text.dates.unavailable, 'Reviewer away');
        const unavailableId = String(requestByDate(text.dates.unavailable)?._id);
        labels.set(unavailableId, '<request:ui-unavailable-reviewer>');
        setMember('V', 'inactive');
        await openRow(page, 'en-US', text.dates.unavailable);
        const dialog = dialogOf(page);
        const persisted = () => ({
          state: requestRow(unavailableId)?.state,
          revision: requestRow(unavailableId)?.revision,
          tasks: taskOf(unavailableId),
          events: eventsOf(unavailableId),
        });

        await keyboardActivate(page, button(dialog, text.submit));
        const unchanged = dialog.getByRole('alert').filter({ hasText: text.reviewerUnavailable });
        await unchanged.waitFor();
        must(
          'ui.en.refused-submit-without-edits-reports-only-the-reason',
          { alert: text.reviewerUnavailable, state: 'draft', revision: 1, tasks: [], events: [] },
          { alert: await unchanged.innerText(), ...persisted() },
        );

        await keyboardInput(page, dialog.getByLabel(text.labels.reason, { exact: true }), 'Reviewer away, edited');
        await keyboardActivate(page, button(dialog, text.submit));
        const saved = dialog.getByRole('alert').filter({ hasText: text.savedNotSubmitted(2) });
        await saved.waitFor();
        must(
          'ui.en.refused-submit-after-edits-reports-the-saved-draft',
          {
            alert: `${text.savedNotSubmitted(2)} ${text.reviewerUnavailable}`,
            state: 'draft',
            revision: 2,
            tasks: [],
            events: [],
          },
          { alert: await saved.innerText(), ...persisted() },
        );
        await capture(requester, '1-saved-not-submitted');

        setMember('V', 'active');
        await keyboardActivate(page, button(dialog, text.submit));
        await page.locator('output').getByText(text.submitted(3), { exact: true }).waitFor();
        must(
          'ui.en.submit-after-refusal-succeeds',
          { state: 'pending', revision: 3, tasks: ['pending'], events: ['submit'], errors: [] },
          {
            state: requestRow(unavailableId)?.state,
            revision: requestRow(unavailableId)?.revision,
            tasks: taskOf(unavailableId).map((task) => task.status),
            events: eventsOf(unavailableId).map((event) => event.command),
            errors: requester.errors,
          },
        );
      } catch (error) {
        await requester.page
          .screenshot({ path: join(artifactsDir, `${requester.name}-failure.png`), fullPage: true })
          .catch(() => undefined);
        throw error;
      } finally {
        setMember('V', 'active');
        await closeSession(requester);
      }

      // RESTART: a pending task and the decisions survive stopping the backend and Vite.
      const survivor = await draft('A', 'restart-pending');
      await command('A', 'submit', survivor, 1);
      const before = reviewState();
      const backendCommand = await stopListener(portOf(convexUrl), dir);
      await stopListener(portOf(appUrl), 'vite');
      check(
        'RESTART.processes-stopped',
        { backend: true, vite: true },
        {
          backend: listeningPid(portOf(convexUrl)) === undefined,
          vite: listeningPid(portOf(appUrl)) === undefined,
        },
      );
      evidence.restartBackendCommandNamesDir = backendCommand.includes(dir);
      rmSync(join('node_modules', '.vite', 'deps'), { recursive: true, force: true });
      const backendLog = openSync(join(dir, 'backend.log'), 'a');
      spawn(
        backendBinary,
        [
          '--interface',
          '127.0.0.1',
          '--port',
          portOf(convexUrl),
          '--site-proxy-port',
          portOf(siteUrl),
          '--instance-name',
          readPrivate(dir, 'instance-name'),
          '--instance-secret',
          readPrivate(dir, 'instance-secret'),
          '--local-storage',
          join(dir, 'files'),
          '--disable-beacon',
          join(dir, 'backend.sqlite3'),
        ],
        { detached: true, stdio: ['ignore', backendLog, backendLog] },
      ).unref();
      const viteLog = openSync(join(dir, 'vite.log'), 'a');
      spawn('bun', ['run', 'demo:dev', '--host', '127.0.0.1', '--port', portOf(appUrl), '--strictPort'], {
        detached: true,
        stdio: ['ignore', viteLog, viteLog],
        env: { ...process.env, VITE_CONVEX_URL: convexUrl, VITE_CONVEX_SITE_URL: siteUrl },
      }).unref();
      await waitFor('backend to answer', () => answers(`${convexUrl}/version`));
      await waitFor('Vite to answer', () => answers(appUrl));
      check('RESTART.rows-identical-after-restart', true, before === reviewState());
      for (const key of ['A', 'V'] as const) {
        actor(key).client = await signInAndCreateConvexClient(actor(key).auth, convexUrl, actor(key).email, password);
      }
      check(
        'RESTART.pending-task-survives',
        { state: 'pending', task: ['pending'], inInbox: true },
        {
          state: requestRow(survivor)?.state,
          task: taskOf(survivor).map((task) => task.status),
          inInbox: (
            await client('V').query(api.requestReviews.inbox, { applicationId: appOne(), status: 'pending' })
          ).items.some((item) => item._id === survivor),
        },
      );
      const afterRestart = await openSession('V', 'en-US', 'en-US-reviewer-after-restart');
      try {
        await openRequests(afterRestart.page, 'en-US');
        await chooseRadio(afterRestart.page, texts['en-US'].assigned);
        const survivorDate = leave.startDate;
        await rowWith(afterRestart.page, survivorDate).first().waitFor();
        await keyboardActivate(
          afterRestart.page,
          rowWith(afterRestart.page, survivorDate).first().getByRole('button', { name: texts['en-US'].openRow }),
        );
        await keyboardActivate(afterRestart.page, button(dialogOf(afterRestart.page), texts['en-US'].approve));
        await afterRestart.page.locator('output').getByText('Request approved · revision 3', { exact: true }).waitFor();
        await capture(afterRestart, '1-approved-after-restart');
        must(
          'RESTART.decision-after-restart-persists',
          { state: 'approved', task: ['completed'], events: ['submit', 'approve'], errors: [] },
          {
            state: requestRow(survivor)?.state,
            task: taskOf(survivor).map((task) => task.status),
            events: eventsOf(survivor).map((event) => event.command),
            errors: afterRestart.errors,
          },
        );
      } finally {
        await closeSession(afterRestart);
      }
    }

    // Invariants over every fixture row.
    const requests = rowsOf('requests');
    const tasks = rowsOf('reviewTasks');
    const events = rowsOf('requestEvents');
    const terminal = new Set(['approved', 'rejected', 'withdrawn']);
    const violations: string[] = [];
    for (const row of requests) {
      const ownTasks = tasks.filter((task) => task.requestId === row._id);
      const ownEvents = events.filter((event) => event.requestId === row._id);
      const id = String(row._id);
      if (row.state === 'draft' && (ownTasks.length > 0 || ownEvents.length > 0)) violations.push(`draft ${id}`);
      if (row.state !== 'draft' && (ownTasks.length !== 1 || ownEvents.length < 1)) violations.push(`open ${id}`);
      const lastRevision = Math.max(0, ...ownEvents.map((event) => Number(event.revision)));
      if (row.state !== 'draft' && Number(row.revision) !== lastRevision) violations.push(`revision ${id}`);
    }
    for (const task of tasks) {
      const row = requests.find((entry) => entry._id === task.requestId);
      const id = String(task._id);
      if (task.status === 'pending' && row?.state !== 'pending') violations.push(`task ${id}`);
      if (task.status !== 'pending' && !terminal.has(String(row?.state))) violations.push(`task ${id}`);
    }
    check('INVARIANTS.requests-tasks-events-agree', { violations: [] }, { violations });
  } catch (error) {
    failure = error;
  } finally {
    await browser?.close();
  }

  // REPLAY-01: cleanup removes every fixture row, so the verifier can run again from scratch.
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
    'REPLAY-01.cleanup-removes-fixture-rows',
    { requests: 0, reviewTasks: 0, requestEvents: 0, memberships: 0, applications: 0 },
    {
      requests: rowsOf('requests').length,
      reviewTasks: rowsOf('reviewTasks').length,
      requestEvents: rowsOf('requestEvents').length,
      memberships: tableRows(envFile, 'memberships').filter((row) => fixtureApplications.has(row.applicationId)).length,
      applications: tableRows(envFile, 'applications').filter((row) => fixtureApplications.has(row._id)).length,
    },
  );

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    mode,
    target: { convexUrl, siteUrl, appUrl },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    error: failure === undefined ? null : normalize(errorMessage(failure)),
    checks,
    cleanup: normalize(cleanup),
  };
  const resultsName = mode === 'red' ? 'results-red.json' : `results-${mode}.json`;
  writeFileSync(join(artifactsDir, resultsName), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(artifactsDir, `evidence-${mode}.json`),
    `${JSON.stringify(
      {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        ...evidence,
        retained: {
          betterAuthUsers: tableRows(envFile, 'user', 'betterAuth').length,
          betterAuthSessions: tableRows(envFile, 'session', 'betterAuth').length,
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Review journey (${mode}): ${report.summary.passed}/${report.summary.checks} checks passed.`);
  if (failure !== undefined || failed.length > 0) {
    if (failure !== undefined) console.error(`Review journey failed: ${errorMessage(failure)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Review journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
