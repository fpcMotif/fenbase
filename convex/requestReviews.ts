import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import {
  assertCanReviewRequests,
  canSubmitRequests,
  isEligibleReviewer,
  requireApplicationPrincipal,
  type ApplicationPrincipal,
} from './membershipModel';
import {
  assertValidValues,
  canRead,
  isOwn,
  notFound,
  pinnedDefinition,
  requestError,
  requestViewValidator,
  sha256Hex,
  stateConflict,
  toView,
} from './requests';
import {
  OPERATION_ID_PATTERN,
  normalizeRequestValues,
  requestStateValidator,
  reviewCommandValidator,
  reviewTaskStatusValidator,
  type RequestState,
  type ReviewCommand,
} from './requestValues';

// The review transitions of a request: submit, approve, reject and withdraw. Each command checks the caller, the
// expected state and revision, then patches the request, opens or closes its review task and appends one event in a
// single mutation, so Convex commits all of it or none of it.

const MAX_INBOX_ITEMS = 100;
const MAX_HISTORY_EVENTS = 100;

const TRANSITIONS: Record<ReviewCommand, { from: RequestState; to: RequestState }> = {
  submit: { from: 'draft', to: 'pending' },
  approve: { from: 'pending', to: 'approved' },
  reject: { from: 'pending', to: 'rejected' },
  withdraw: { from: 'pending', to: 'withdrawn' },
};

const commandArgs = {
  applicationId: v.id('applications'),
  requestId: v.id('requests'),
  expectedRevision: v.number(),
  operationId: v.string(),
};

const transitionResult = v.object({
  requestId: v.id('requests'),
  state: requestStateValidator,
  revision: v.number(),
  eventId: v.id('requestEvents'),
  replayed: v.boolean(),
});

type CommandArgs = {
  applicationId: Id<'applications'>;
  requestId: Id<'requests'>;
  expectedRevision: number;
  operationId: string;
};

function permissionDenied(message: string) {
  return new ConvexError({ code: 'PERMISSION_DENIED', message });
}

function selfReview() {
  return requestError('REQUEST_SELF_REVIEW', 'A requester cannot review their own request');
}

function authorize(principal: ApplicationPrincipal, row: Doc<'requests'>, command: ReviewCommand): void {
  if (command === 'submit' || command === 'withdraw') {
    if (!isOwn(principal, row) || !canSubmitRequests(principal)) {
      throw permissionDenied('Only the requester can submit or withdraw this request');
    }
    return;
  }
  if (isOwn(principal, row)) throw selfReview();
  if (row.reviewerMembershipId !== principal.membershipId) {
    throw permissionDenied('Only the assigned reviewer can decide this request');
  }
  assertCanReviewRequests(principal);
}

async function findTask(ctx: MutationCtx, requestId: Id<'requests'>) {
  return ctx.db
    .query('reviewTasks')
    .withIndex('by_request', (q) => q.eq('requestId', requestId))
    .unique();
}

// Copies the reviewer from the pinned version, never the current head, after checking the values against that version
// again.
async function openReview(ctx: MutationCtx, principal: ApplicationPrincipal, row: Doc<'requests'>, now: number) {
  const definition = await pinnedDefinition(ctx, row);
  assertValidValues(definition, normalizeRequestValues(row.values));
  const reviewerMembershipId = definition.reviewerMembershipId;
  if (reviewerMembershipId === principal.membershipId) throw selfReview();
  if (!(await isEligibleReviewer(ctx, row.applicationId, reviewerMembershipId))) {
    throw requestError('REQUEST_REVIEWER_UNAVAILABLE', 'The reviewer of this form version cannot review requests');
  }
  if (await findTask(ctx, row._id)) throw new Error(`Invariant: draft request ${row._id} already has a review task`);
  await ctx.db.insert('reviewTasks', {
    requestId: row._id,
    applicationId: row.applicationId,
    organizationId: row.organizationId,
    requesterMembershipId: row.requesterMembershipId,
    reviewerMembershipId,
    definitionVersionId: row.definitionVersionId,
    version: row.version,
    status: 'pending',
    createdAt: now,
  });
  return reviewerMembershipId;
}

async function closeReview(ctx: MutationCtx, row: Doc<'requests'>, outcome: RequestState, now: number) {
  const task = await findTask(ctx, row._id);
  if (!task || task.status !== 'pending') throw new Error(`Invariant: pending request ${row._id} has no pending task`);
  await ctx.db.patch(task._id, {
    status: outcome === 'withdrawn' ? 'cancelled' : 'completed',
    outcome,
    completedAt: now,
  });
}

async function runCommand(ctx: MutationCtx, args: CommandArgs, command: ReviewCommand) {
  const principal = await requireApplicationPrincipal(ctx, args.applicationId);
  if (!OPERATION_ID_PATTERN.test(args.operationId)) {
    throw requestError('RECORD_OPERATION_ID_INVALID', 'Use 8 to 64 letters, digits, hyphens or underscores');
  }
  const operationFingerprint = await sha256Hex({
    command,
    applicationId: args.applicationId,
    requestId: args.requestId,
    expectedRevision: args.expectedRevision,
  });
  const previous = await ctx.db
    .query('requestEvents')
    .withIndex('by_actor_operation', (q) =>
      q.eq('actorMembershipId', principal.membershipId).eq('operationId', args.operationId),
    )
    .first();
  if (previous) {
    if (previous.operationFingerprint !== operationFingerprint) {
      throw requestError('RECORD_OPERATION_CONFLICT', 'This operation id was already used for a different command');
    }
    return {
      requestId: previous.requestId,
      state: previous.toState,
      revision: previous.revision,
      eventId: previous._id,
      replayed: true,
    };
  }

  const row = await ctx.db.get(args.requestId);
  if (!row || !canRead(principal, row)) throw notFound();
  authorize(principal, row, command);
  const { from, to } = TRANSITIONS[command];
  if (row.state !== from) throw stateConflict(row);
  if (row.revision !== args.expectedRevision) {
    throw new ConvexError({
      code: 'RECORD_REVISION_CONFLICT',
      message: 'The request changed since you loaded it',
      currentRevision: row.revision,
    });
  }

  const now = Date.now();
  const revision = row.revision + 1;
  if (command === 'submit') {
    const reviewerMembershipId = await openReview(ctx, principal, row, now);
    await ctx.db.patch(row._id, { state: to, revision, reviewerMembershipId, submittedAt: now, updatedAt: now });
  } else {
    await closeReview(ctx, row, to, now);
    await ctx.db.patch(row._id, { state: to, revision, decidedAt: now, updatedAt: now });
  }
  const eventId = await ctx.db.insert('requestEvents', {
    requestId: row._id,
    applicationId: row.applicationId,
    organizationId: row.organizationId,
    actorMembershipId: principal.membershipId,
    command,
    fromState: from,
    toState: to,
    revision,
    definitionVersionId: row.definitionVersionId,
    operationId: args.operationId,
    operationFingerprint,
    at: now,
  });
  return { requestId: row._id, state: to, revision, eventId, replayed: false };
}

export const submit = mutation({
  args: commandArgs,
  returns: transitionResult,
  handler: (ctx, args) => runCommand(ctx, args, 'submit'),
});

export const approve = mutation({
  args: commandArgs,
  returns: transitionResult,
  handler: (ctx, args) => runCommand(ctx, args, 'approve'),
});

export const reject = mutation({
  args: commandArgs,
  returns: transitionResult,
  handler: (ctx, args) => runCommand(ctx, args, 'reject'),
});

export const withdraw = mutation({
  args: commandArgs,
  returns: transitionResult,
  handler: (ctx, args) => runCommand(ctx, args, 'withdraw'),
});

export const inbox = query({
  args: { applicationId: v.id('applications'), status: reviewTaskStatusValidator },
  returns: v.object({ items: v.array(requestViewValidator), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    assertCanReviewRequests(principal);
    const tasks = await ctx.db
      .query('reviewTasks')
      .withIndex('by_reviewer_status', (q) =>
        q.eq('reviewerMembershipId', principal.membershipId).eq('status', args.status),
      )
      .order('desc')
      .take(MAX_INBOX_ITEMS + 1);
    const items = [];
    for (const task of tasks.slice(0, MAX_INBOX_ITEMS)) {
      const row = await ctx.db.get(task.requestId);
      if (row && canRead(principal, row)) items.push(toView(principal, row));
    }
    return { items, truncated: tasks.length > MAX_INBOX_ITEMS };
  },
});

const eventViewValidator = v.object({
  _id: v.id('requestEvents'),
  command: reviewCommandValidator,
  fromState: requestStateValidator,
  toState: requestStateValidator,
  revision: v.number(),
  at: v.number(),
  actor: v.object({ membershipId: v.id('memberships'), isMe: v.boolean() }),
});

export const history = query({
  args: { applicationId: v.id('applications'), requestId: v.id('requests') },
  returns: v.union(v.array(eventViewValidator), v.null()),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const row = await ctx.db.get(args.requestId);
    if (!row || !canRead(principal, row)) return null;
    const events = await ctx.db
      .query('requestEvents')
      .withIndex('by_request', (q) => q.eq('requestId', row._id))
      .take(MAX_HISTORY_EVENTS);
    return events.map((event) => ({
      _id: event._id,
      command: event.command,
      fromState: event.fromState,
      toState: event.toState,
      revision: event.revision,
      at: event.at,
      actor: { membershipId: event.actorMembershipId, isMe: event.actorMembershipId === principal.membershipId },
    }));
  },
});
