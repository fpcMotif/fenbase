import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeOrganization } from '../fixtures';
import { create, get, remove, update } from '../requests';
import { approve, history, inbox, reject, submit, withdraw } from '../requestReviews';
import { invokeHandler, type TestContext } from './helpers';
import { APP_1, ORG_1, V1, V2, fixtureContext, leave, rejectionData, seedV2 } from './requestFixture';

const auth = vi.hoisted(() => ({ currentUser: null as string | null }));

vi.mock('../auth', () => ({
  requireUser: async () => {
    if (auth.currentUser === null) throw new ConvexError('Unauthenticated');
    return auth.currentUser;
  },
}));

function signIn(authUserId: string | null): void {
  auth.currentUser = authUserId;
}

async function expectCode(operation: Promise<unknown>, code: string, extra: Record<string, unknown> = {}) {
  expect(await rejectionData(operation)).toMatchObject({ code, ...extra });
}

beforeEach(() => signIn(null));

let operationCounter = 0;
function nextOperationId(): string {
  operationCounter += 1;
  return `rv-${String(operationCounter).padStart(6, '0')}`;
}

type Created = { requestId: string; revision: number };
type Transition = { requestId: string; state: string; revision: number; eventId: string; replayed: boolean };
const commands = { submit, approve, reject, withdraw };
type Command = keyof typeof commands;

async function draftAs(ctx: TestContext, user: string, options: { definitionVersionId?: string } = {}) {
  signIn(user);
  return (await invokeHandler(create, ctx, {
    applicationId: APP_1,
    definitionVersionId: options.definitionVersionId ?? V1,
    operationId: nextOperationId(),
    values: leave,
  })) as Created;
}

function run(
  ctx: TestContext,
  command: Command,
  user: string | null,
  requestId: string,
  expectedRevision: number,
  operationId = nextOperationId(),
) {
  signIn(user);
  return invokeHandler(commands[command], ctx, {
    applicationId: APP_1,
    requestId,
    expectedRevision,
    operationId,
  }) as Promise<Transition>;
}

describe('submitting a draft', () => {
  it('moves the draft to pending and writes one review task assigned from the pinned version and one event', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-a');

    const result = await run(ctx, 'submit', 'user-a', requestId, 1, 'submit-0001');

    expect(result).toMatchObject({ requestId, state: 'pending', revision: 2, replayed: false });
    expect(ctx.read('requests', requestId)).toMatchObject({
      state: 'pending',
      revision: 2,
      reviewerMembershipId: 'memberships:b',
    });
    expect(ctx.rows('reviewTasks')).toEqual([
      expect.objectContaining({
        requestId,
        applicationId: APP_1,
        organizationId: ORG_1,
        requesterMembershipId: 'memberships:a',
        reviewerMembershipId: 'memberships:b',
        definitionVersionId: V1,
        version: 1,
        status: 'pending',
      }),
    ]);
    expect(ctx.rows('requestEvents')).toEqual([
      expect.objectContaining({
        _id: result.eventId,
        requestId,
        actorMembershipId: 'memberships:a',
        command: 'submit',
        fromState: 'draft',
        toState: 'pending',
        revision: 2,
        definitionVersionId: V1,
        operationId: 'submit-0001',
      }),
    ]);
  });
});

function snapshot(ctx: TestContext): string {
  return JSON.stringify([ctx.rows('requests'), ctx.rows('reviewTasks'), ctx.rows('requestEvents')]);
}

async function expectDenied(
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

async function pendingRequest(ctx: TestContext, user = 'user-a') {
  const { requestId } = await draftAs(ctx, user);
  const submitted = await run(ctx, 'submit', user, requestId, 1);
  return { requestId, revision: submitted.revision };
}

describe('submit denials', () => {
  it('leaves a draft without a task or event when the pinned reviewer cannot review', async () => {
    for (const change of [{ status: 'inactive' }, { grants: ['submitRequests'] }]) {
      const ctx = fixtureContext();
      const { requestId } = await draftAs(ctx, 'user-a');
      await ctx.db.patch('memberships:b', change);
      await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 1), 'REQUEST_REVIEWER_UNAVAILABLE');
      expect(ctx.read('requests', requestId)).toMatchObject({ state: 'draft', revision: 1 });
    }
  });

  it('refuses to submit a request whose pinned reviewer is the requester', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-b');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-b', requestId, 1), 'REQUEST_SELF_REVIEW');
  });

  it('checks the stored values against the pinned version again', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-a');
    await ctx.db.patch(requestId, { values: { ...leave, days: 0 } });
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 1), 'RECORD_NUMBER_OUT_OF_RANGE', {
      field: 'days',
    });
  });

  it('denies anonymous, unrelated, foreign-organization, inactive and grantless callers', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-a');
    signIn(null);
    await expect(run(ctx, 'submit', null, requestId, 1)).rejects.toThrow('Unauthenticated');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a2', requestId, 1), 'RECORD_NOT_FOUND');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-b', requestId, 1), 'RECORD_NOT_FOUND');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-z', requestId, 1), 'APPLICATION_ACCESS_DENIED');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-i', requestId, 1), 'APPLICATION_ACCESS_DENIED');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-nobody', requestId, 1), 'APPLICATION_ACCESS_DENIED');
    await ctx.db.patch('memberships:a', { grants: [] });
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 1), 'PERMISSION_DENIED');
  });

  it('rejects a malformed operation id, a stale revision and a second submit', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 1, 'bad id'), 'RECORD_OPERATION_ID_INVALID');
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 7), 'RECORD_REVISION_CONFLICT', {
      currentRevision: 1,
    });
    await run(ctx, 'submit', 'user-a', requestId, 1);
    await expectDenied(ctx, () => run(ctx, 'submit', 'user-a', requestId, 2), 'REQUEST_STATE_CONFLICT', {
      currentState: 'pending',
      currentRevision: 2,
    });
    expect(ctx.rows('reviewTasks')).toHaveLength(1);
  });
});

describe('deciding and withdrawing', () => {
  it.each<[Command, string, string, string]>([
    ['approve', 'user-b', 'approved', 'completed'],
    ['reject', 'user-b', 'rejected', 'completed'],
    ['withdraw', 'user-a', 'withdrawn', 'cancelled'],
  ])(
    '%s moves pending to a terminal state, closes the task and appends an event',
    async (command, user, state, status) => {
      const ctx = fixtureContext();
      const { requestId, revision } = await pendingRequest(ctx);

      const result = await run(ctx, command, user, requestId, revision);

      expect(result).toMatchObject({ requestId, state, revision: 3, replayed: false });
      expect(ctx.read('requests', requestId)).toMatchObject({ state, revision: 3 });
      expect(ctx.read('requests', requestId)?.decidedAt).toEqual(expect.any(Number));
      expect(ctx.rows('reviewTasks')).toEqual([expect.objectContaining({ status, outcome: state })]);
      const events = ctx.rows('requestEvents');
      expect(events.map((event) => [event.command, event.fromState, event.toState, event.revision])).toEqual([
        ['submit', 'draft', 'pending', 2],
        [command, 'pending', state, 3],
      ]);
      for (const next of ['approve', 'reject', 'withdraw'] as const) {
        const actor = next === 'withdraw' ? 'user-a' : 'user-b';
        await expectDenied(ctx, () => run(ctx, next, actor, requestId, 3), 'REQUEST_STATE_CONFLICT', {
          currentState: state,
        });
      }
    },
  );

  it('lets only the assigned reviewer decide, and never the requester', async () => {
    const ctx = fixtureContext({ app1Preset: 'requesterAssignedReviewerAndReaders' });
    const { requestId, revision } = await pendingRequest(ctx);
    for (const command of ['approve', 'reject'] as const) {
      await expectDenied(ctx, () => run(ctx, command, 'user-a', requestId, revision), 'REQUEST_SELF_REVIEW');
      await expectDenied(ctx, () => run(ctx, command, 'user-v', requestId, revision), 'RECORD_NOT_FOUND');
      await expectDenied(ctx, () => run(ctx, command, 'user-a2', requestId, revision), 'RECORD_NOT_FOUND');
      await expectDenied(ctx, () => run(ctx, command, 'user-r', requestId, revision), 'PERMISSION_DENIED');
      await expectDenied(ctx, () => run(ctx, command, 'user-z', requestId, revision), 'APPLICATION_ACCESS_DENIED');
      signIn(null);
      await expect(run(ctx, command, null, requestId, revision)).rejects.toThrow('Unauthenticated');
    }
    await expectDenied(ctx, () => run(ctx, 'withdraw', 'user-b', requestId, revision), 'PERMISSION_DENIED');
    await expectDenied(ctx, () => run(ctx, 'withdraw', 'user-r', requestId, revision), 'PERMISSION_DENIED');
  });

  it('denies a reviewer who became inactive or lost reviewRequests and keeps the task pending', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    await ctx.db.patch('memberships:b', { status: 'inactive' });
    await expectDenied(ctx, () => run(ctx, 'approve', 'user-b', requestId, revision), 'APPLICATION_ACCESS_DENIED');
    await ctx.db.patch('memberships:b', { status: 'active', grants: ['submitRequests'] });
    await expectDenied(ctx, () => run(ctx, 'approve', 'user-b', requestId, revision), 'RECORD_NOT_FOUND');
    expect(ctx.rows('reviewTasks')).toEqual([expect.objectContaining({ status: 'pending' })]);

    // The requester can still withdraw the stranded request.
    expect(await run(ctx, 'withdraw', 'user-a', requestId, revision)).toMatchObject({ state: 'withdrawn' });
  });

  it('denies withdraw after the requester loses submitRequests', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    await ctx.db.patch('memberships:a', { grants: [] });
    await expectDenied(ctx, () => run(ctx, 'withdraw', 'user-a', requestId, revision), 'PERMISSION_DENIED');
    expect(await run(ctx, 'approve', 'user-b', requestId, revision)).toMatchObject({ state: 'approved' });
  });

  it('rejects a stale expected revision with the current one', async () => {
    const ctx = fixtureContext();
    const { requestId } = await pendingRequest(ctx);
    await expectDenied(ctx, () => run(ctx, 'approve', 'user-b', requestId, 1), 'RECORD_REVISION_CONFLICT', {
      currentRevision: 2,
    });
  });
});

describe('operation ids', () => {
  it('returns the original result for a repeated command without a second task, decision or event', async () => {
    const ctx = fixtureContext();
    const { requestId } = await draftAs(ctx, 'user-a');
    const first = await run(ctx, 'submit', 'user-a', requestId, 1, 'submit-same');
    const writesBefore = ctx.writes.length;
    expect(await run(ctx, 'submit', 'user-a', requestId, 1, 'submit-same')).toEqual({ ...first, replayed: true });
    expect(ctx.writes.length).toBe(writesBefore);

    const decided = await run(ctx, 'approve', 'user-b', requestId, 2, 'decide-same');
    expect(await run(ctx, 'approve', 'user-b', requestId, 2, 'decide-same')).toEqual({ ...decided, replayed: true });
    expect(ctx.rows('reviewTasks')).toHaveLength(1);
    expect(ctx.rows('requestEvents')).toHaveLength(2);
  });

  it('fails when an operation id is reused for another command, request or revision', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    await run(ctx, 'reject', 'user-b', requestId, revision, 'decide-once');
    await expectDenied(
      ctx,
      () => run(ctx, 'approve', 'user-b', requestId, revision, 'decide-once'),
      'RECORD_OPERATION_CONFLICT',
    );
    const other = await pendingRequest(ctx);
    await expectDenied(
      ctx,
      () => run(ctx, 'reject', 'user-b', other.requestId, other.revision, 'decide-once'),
      'RECORD_OPERATION_CONFLICT',
    );
    // The id is scoped to the actor, so another member may use the same text.
    expect(await run(ctx, 'withdraw', 'user-a', other.requestId, other.revision, 'decide-once')).toMatchObject({
      state: 'withdrawn',
    });
  });
});

describe('generic edits cannot bypass the commands', () => {
  it('refuses to update or delete a pending or terminal request', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    signIn('user-a');
    await expectDenied(
      ctx,
      () => invokeHandler(update, ctx, { applicationId: APP_1, requestId, expectedRevision: revision, values: leave }),
      'REQUEST_STATE_CONFLICT',
      { currentState: 'pending' },
    );
    await expectDenied(
      ctx,
      () => invokeHandler(remove, ctx, { applicationId: APP_1, requestId, expectedRevision: revision }),
      'REQUEST_STATE_CONFLICT',
    );
    await run(ctx, 'approve', 'user-b', requestId, revision);
    signIn('user-a');
    await expectDenied(
      ctx,
      () => invokeHandler(remove, ctx, { applicationId: APP_1, requestId, expectedRevision: 3 }),
      'REQUEST_STATE_CONFLICT',
      { currentState: 'approved' },
    );
  });

  it('accepts only the documented command arguments, so state, requester, reviewer and version cannot be sent', () => {
    for (const registered of [submit, approve, reject, withdraw]) {
      const exportArgs = Reflect.get(registered, 'exportArgs') as () => string;
      const parsed = JSON.parse(exportArgs()) as { value: Record<string, unknown> };
      expect(Object.keys(parsed.value).sort()).toEqual([
        'applicationId',
        'expectedRevision',
        'operationId',
        'requestId',
      ]);
    }
  });
});

describe('pinned reviewer', () => {
  it('keeps a V1 request with reviewer B after V2 names reviewer V, and assigns V2 requests to V', async () => {
    const ctx = fixtureContext();
    const v1 = await draftAs(ctx, 'user-a');
    const v1Pending = await pendingRequest(ctx, 'user-a2');
    await seedV2(ctx, 'requesterAndAssignedReviewer', 'memberships:v');

    // An old V1 draft is still submitted to V1's reviewer, without RECORD_DEFINITION_OUTDATED.
    expect(await run(ctx, 'submit', 'user-a', v1.requestId, 1)).toMatchObject({ state: 'pending' });
    expect(ctx.read('requests', v1.requestId)).toMatchObject({ version: 1, reviewerMembershipId: 'memberships:b' });
    expect(ctx.read('requests', v1Pending.requestId)).toMatchObject({ reviewerMembershipId: 'memberships:b' });

    const v2 = await draftAs(ctx, 'user-a', { definitionVersionId: V2 });
    await run(ctx, 'submit', 'user-a', v2.requestId, 1);
    expect(ctx.read('requests', v2.requestId)).toMatchObject({ version: 2, reviewerMembershipId: 'memberships:v' });

    await expectDenied(ctx, () => run(ctx, 'approve', 'user-v', v1.requestId, 2), 'RECORD_NOT_FOUND');
    expect(await run(ctx, 'approve', 'user-v', v2.requestId, 2)).toMatchObject({ state: 'approved' });

    await ctx.db.patch('memberships:b', { status: 'inactive' });
    await expectDenied(ctx, () => run(ctx, 'approve', 'user-b', v1.requestId, 2), 'APPLICATION_ACCESS_DENIED');
    expect(ctx.read('requests', v1.requestId)).toMatchObject({
      state: 'pending',
      reviewerMembershipId: 'memberships:b',
    });
  });
});

type View = {
  _id: string;
  state: string;
  reviewer: { membershipId: string; isMe: boolean } | null;
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canDecide: boolean;
};

function getAs(ctx: TestContext, user: string, requestId: string) {
  signIn(user);
  return invokeHandler(get, ctx, { applicationId: APP_1, requestId }) as Promise<View | null>;
}

function inboxAs(ctx: TestContext, user: string, status: 'pending' | 'completed' | 'cancelled' = 'pending') {
  signIn(user);
  return invokeHandler(inbox, ctx, { applicationId: APP_1, status }) as Promise<{ items: View[]; truncated: boolean }>;
}

type HistoryEvent = { command: string; toState: string; actor: { membershipId: string; isMe: boolean } };

function historyAs(ctx: TestContext, user: string, requestId: string) {
  signIn(user);
  return invokeHandler(history, ctx, { applicationId: APP_1, requestId }) as Promise<{
    events: HistoryEvent[];
    truncated: boolean;
  } | null>;
}

describe('reading reviews', () => {
  it('shows the assigned reviewer submitted requests only, with the actions each side may take', async () => {
    const ctx = fixtureContext();
    const draft = await draftAs(ctx, 'user-a');
    const { requestId } = await pendingRequest(ctx, 'user-a2');

    expect(await getAs(ctx, 'user-b', draft.requestId)).toBeNull();
    expect(await getAs(ctx, 'user-b', requestId)).toMatchObject({
      state: 'pending',
      reviewer: { membershipId: 'memberships:b', isMe: true },
      canEdit: false,
      canSubmit: false,
      canWithdraw: false,
      canDecide: true,
    });
    expect(await getAs(ctx, 'user-a2', requestId)).toMatchObject({
      reviewer: { membershipId: 'memberships:b', isMe: false },
      canEdit: false,
      canWithdraw: true,
      canDecide: false,
    });
    expect(await getAs(ctx, 'user-a', draft.requestId)).toMatchObject({
      canEdit: true,
      canSubmit: true,
      reviewer: null,
    });
    expect(await getAs(ctx, 'user-v', requestId)).toBeNull();

    const pending = await inboxAs(ctx, 'user-b');
    expect(pending.items.map((item) => item._id)).toEqual([requestId]);
    expect(pending.truncated).toBe(false);
    expect((await inboxAs(ctx, 'user-v')).items).toEqual([]);
    await expectCode(inboxAs(ctx, 'user-a'), 'PERMISSION_DENIED');
    await expectCode(inboxAs(ctx, 'user-z'), 'APPLICATION_ACCESS_DENIED');

    await run(ctx, 'approve', 'user-b', requestId, 2);
    expect((await inboxAs(ctx, 'user-b')).items).toEqual([]);
    expect((await inboxAs(ctx, 'user-b', 'completed')).items).toEqual([
      expect.objectContaining({ _id: requestId, state: 'approved', canDecide: false }),
    ]);
  });

  it('bounds the inbox to 100 rows and reads only the reviewer’s tasks', async () => {
    const ctx = fixtureContext();
    for (let index = 0; index < 101; index += 1) await pendingRequest(ctx, index % 2 === 0 ? 'user-a' : 'user-a2');
    ctx.indexReads.length = 0;
    const result = await inboxAs(ctx, 'user-b');
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(ctx.indexReads).toEqual([
      expect.objectContaining({ table: 'memberships' }),
      { table: 'reviewTasks', index: 'by_reviewer_status', rows: 101 },
    ]);
  });

  it('records an attributable history visible to the requester and reviewer only', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    await run(ctx, 'reject', 'user-b', requestId, revision);

    const result = await historyAs(ctx, 'user-a', requestId);
    expect(result?.events.map((event) => [event.command, event.toState, event.actor])).toEqual([
      ['submit', 'pending', { membershipId: 'memberships:a', isMe: true }],
      ['reject', 'rejected', { membershipId: 'memberships:b', isMe: false }],
    ]);
    expect(result?.truncated).toBe(false);
    expect(await historyAs(ctx, 'user-a2', requestId)).toBeNull();
    expect((await historyAs(ctx, 'user-b', requestId))?.events).toHaveLength(2);
  });

  it('bounds the history to 100 events and says when older ones are left out', async () => {
    const ctx = fixtureContext();
    const { requestId } = await pendingRequest(ctx);
    const [submitted] = ctx.rows('requestEvents');
    const { _id: _ignored, _creationTime: _time, ...event } = submitted;
    for (let index = 0; index < 100; index += 1) await ctx.db.insert('requestEvents', event);

    ctx.indexReads.length = 0;
    const result = await historyAs(ctx, 'user-a', requestId);
    expect(result?.events).toHaveLength(100);
    expect(result?.truncated).toBe(true);
    expect(ctx.indexReads).toContainEqual({ table: 'requestEvents', index: 'by_request', rows: 101 });
  });
});

describe('fixture cleanup', () => {
  it('removes review tasks and events with their organization', async () => {
    const ctx = fixtureContext();
    const { requestId, revision } = await pendingRequest(ctx);
    await run(ctx, 'approve', 'user-b', requestId, revision);
    await pendingRequest(ctx, 'user-a2');
    const removed = await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-1' });
    expect(removed).toMatchObject({ requests: 2, reviewTasks: 2, requestEvents: 3 });
    expect(ctx.rows('reviewTasks')).toEqual([]);
    expect(ctx.rows('requestEvents')).toEqual([]);
  });
});
