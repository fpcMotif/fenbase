import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { MAX_ATTACHMENT_EVENTS_PER_REQUEST, MAX_ATTACHMENTS_PER_REQUEST } from './attachmentModel';
import { canonicalJson, type Definition } from './definitionModel';
import {
  assertCanSubmitRequests,
  canReadAllRecords,
  canReviewRequests,
  canSubmitRequests,
  requireApplicationPrincipal,
  type ApplicationPrincipal,
} from './membershipModel';
import { queryRecords, validateRecordQuery, type RecordQueryField } from './recordQuery';
import {
  MAX_REQUESTS_PER_APPLICATION,
  OPERATION_ID_PATTERN,
  normalizeRequestValues,
  requestStateValidator,
  requestValuesValidator,
  requestValueValidator,
  validateRequestValues,
  type RequestErrorCode,
  type RequestIssue,
} from './requestValues';

// Draft requests pinned to a published definition version. The server owns identity, version, policy, state and
// revision; callers send only field values.

export function requestError(code: RequestErrorCode, message: string, extra: Omit<RequestIssue, 'code'> = {}) {
  return new ConvexError({ code, message, ...extra });
}

export function notFound() {
  return requestError('RECORD_NOT_FOUND', 'Request not found');
}

export function stateConflict(row: Doc<'requests'>) {
  return new ConvexError({
    code: 'REQUEST_STATE_CONFLICT',
    message: `The request is ${row.state}`,
    currentState: row.state,
    currentRevision: row.revision,
  });
}

export function revisionConflict(row: Doc<'requests'>) {
  return new ConvexError({
    code: 'RECORD_REVISION_CONFLICT',
    message: 'The request changed since you loaded it',
    currentRevision: row.revision,
  });
}

export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw requestError('RECORD_OPERATION_ID_INVALID', 'Use 8 to 64 letters, digits, hyphens or underscores');
  }
}

const memberReferenceValidator = v.object({ membershipId: v.id('memberships'), isMe: v.boolean() });

export const requestViewValidator = v.object({
  _id: v.id('requests'),
  _creationTime: v.number(),
  updatedAt: v.number(),
  version: v.number(),
  versionId: v.id('applicationDefinitionVersions'),
  revision: v.number(),
  state: requestStateValidator,
  values: requestValuesValidator,
  requester: memberReferenceValidator,
  reviewer: v.union(memberReferenceValidator, v.null()),
  submittedAt: v.union(v.number(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  canEdit: v.boolean(),
  canSubmit: v.boolean(),
  canWithdraw: v.boolean(),
  canDecide: v.boolean(),
});

const READERS_PRESET = 'requesterAssignedReviewerAndReaders';

export function isOwn(principal: ApplicationPrincipal, row: Doc<'requests'>): boolean {
  return row.applicationId === principal.applicationId && row.requesterMembershipId === principal.membershipId;
}

function isAssignedReviewer(principal: ApplicationPrincipal, row: Doc<'requests'>): boolean {
  return row.reviewerMembershipId === principal.membershipId && canReviewRequests(principal);
}

// Drafts stay private to the requester. A submitted request is also readable by its assigned reviewer while they hold
// reviewRequests, and by readApplicationRecords holders under the readers preset.
export function canRead(principal: ApplicationPrincipal, row: Doc<'requests'>): boolean {
  if (row.applicationId !== principal.applicationId) return false;
  if (row.requesterMembershipId === principal.membershipId) return true;
  if (row.state === 'draft') return false;
  if (isAssignedReviewer(principal, row)) return true;
  return row.policyPreset === READERS_PRESET && canReadAllRecords(principal);
}

// Stricter than reading the request: readers-preset holders and builders see the request but not its files.
export function canReadAttachments(principal: ApplicationPrincipal, row: Doc<'requests'>): boolean {
  return canRead(principal, row) && (isOwn(principal, row) || isAssignedReviewer(principal, row));
}

export function toView(principal: ApplicationPrincipal, row: Doc<'requests'>) {
  const isMe = row.requesterMembershipId === principal.membershipId;
  const ownsWithGrant = isMe && canSubmitRequests(principal);
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    updatedAt: row.updatedAt,
    version: row.version,
    versionId: row.definitionVersionId,
    revision: row.revision,
    state: row.state,
    values: row.values,
    requester: { membershipId: row.requesterMembershipId, isMe },
    reviewer: row.reviewerMembershipId
      ? { membershipId: row.reviewerMembershipId, isMe: row.reviewerMembershipId === principal.membershipId }
      : null,
    submittedAt: row.submittedAt ?? null,
    decidedAt: row.decidedAt ?? null,
    canEdit: ownsWithGrant && row.state === 'draft',
    canSubmit: ownsWithGrant && row.state === 'draft',
    canWithdraw: ownsWithGrant && row.state === 'pending',
    canDecide: !isMe && row.state === 'pending' && isAssignedReviewer(principal, row),
  };
}

async function findHead(ctx: QueryCtx | MutationCtx, applicationId: Id<'applications'>) {
  return ctx.db
    .query('applicationDefinitions')
    .withIndex('by_application', (q) => q.eq('applicationId', applicationId))
    .unique();
}

// One row per application keeps the request count, so the cap check reads one document instead of every request.
async function findCounter(ctx: MutationCtx, applicationId: Id<'applications'>) {
  return ctx.db
    .query('requestCounts')
    .withIndex('by_application', (q) => q.eq('applicationId', applicationId))
    .unique();
}

export async function pinnedDefinition(ctx: QueryCtx | MutationCtx, row: Doc<'requests'>): Promise<Definition> {
  const version = await ctx.db.get(row.definitionVersionId);
  if (!version || version.applicationId !== row.applicationId) throw notFound();
  return version.definition;
}

export function assertValidValues(definition: Definition, values: Record<string, unknown>): void {
  const issue = validateRequestValues(definition, values);
  if (issue) {
    const { code, ...extra } = issue;
    throw requestError(code, 'The request values are invalid', extra);
  }
}

export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(definitionVersionId: Id<'applicationDefinitionVersions'>, values: unknown) {
  return sha256Hex({ definitionVersionId, values });
}

// The access half of an edit: the caller's own request while they hold submitRequests. Replayable commands look up
// their replay between this and `assertEditable`, so a replay re-checks access but not the state it already changed.
export async function requireOwnRequest(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<'applications'>,
  requestId: Id<'requests'>,
) {
  const principal = await requireApplicationPrincipal(ctx, applicationId);
  const row = await ctx.db.get(requestId);
  if (!row || !isOwn(principal, row)) throw notFound();
  assertCanSubmitRequests(principal);
  return { principal, row };
}

export function assertEditable(row: Doc<'requests'>, expectedRevision: number): void {
  if (row.state !== 'draft') throw stateConflict(row);
  if (row.revision !== expectedRevision) throw revisionConflict(row);
}

async function requireEditable(
  ctx: MutationCtx,
  applicationId: Id<'applications'>,
  requestId: Id<'requests'>,
  expectedRevision: number,
) {
  const owned = await requireOwnRequest(ctx, applicationId, requestId);
  assertEditable(owned.row, expectedRevision);
  return owned;
}

export const create = mutation({
  args: {
    applicationId: v.id('applications'),
    definitionVersionId: v.id('applicationDefinitionVersions'),
    operationId: v.string(),
    values: requestValuesValidator,
  },
  returns: v.object({
    requestId: v.id('requests'),
    revision: v.number(),
    version: v.number(),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    assertCanSubmitRequests(principal);
    assertOperationId(args.operationId);

    const values = normalizeRequestValues(args.values);
    const previous = await ctx.db
      .query('requests')
      .withIndex('by_requester_operation', (q) =>
        q.eq('requesterMembershipId', principal.membershipId).eq('operationId', args.operationId),
      )
      .first();
    if (previous) {
      if (previous.operationFingerprint !== (await fingerprint(args.definitionVersionId, values))) {
        throw requestError('RECORD_OPERATION_CONFLICT', 'This operation id was already used for different values');
      }
      return { requestId: previous._id, revision: previous.revision, version: previous.version, created: false };
    }

    const head = await findHead(ctx, principal.applicationId);
    if (!head?.currentVersionId) {
      throw new ConvexError({ code: 'DEFINITION_NOT_FOUND', message: 'This application has no published definition' });
    }
    if (head.currentVersionId !== args.definitionVersionId) {
      throw new ConvexError({
        code: 'RECORD_DEFINITION_OUTDATED',
        message: 'A newer version of this form was published',
        currentVersionId: head.currentVersionId,
      });
    }
    const version = await ctx.db.get(head.currentVersionId);
    if (!version || version.applicationId !== principal.applicationId) {
      throw new ConvexError({ code: 'DEFINITION_VERSION_NOT_FOUND', message: 'Definition version not found' });
    }
    assertValidValues(version.definition, values);

    const counter = await findCounter(ctx, principal.applicationId);
    const count = counter?.count ?? 0;
    if (count >= MAX_REQUESTS_PER_APPLICATION) {
      throw requestError(
        'RECORD_APPLICATION_FULL',
        `An application holds at most ${MAX_REQUESTS_PER_APPLICATION} requests`,
      );
    }
    if (counter) await ctx.db.patch(counter._id, { count: count + 1 });
    else await ctx.db.insert('requestCounts', { applicationId: principal.applicationId, count: 1 });

    const requestId = await ctx.db.insert('requests', {
      applicationId: principal.applicationId,
      organizationId: principal.organizationId,
      requesterMembershipId: principal.membershipId,
      definitionVersionId: version._id,
      version: version.version,
      policyPreset: version.definition.policyPreset,
      state: 'draft',
      revision: 1,
      operationId: args.operationId,
      operationFingerprint: await fingerprint(version._id, values),
      values,
      updatedAt: Date.now(),
    });
    return { requestId, revision: 1, version: version.version, created: true };
  },
});

export const update = mutation({
  args: {
    applicationId: v.id('applications'),
    requestId: v.id('requests'),
    expectedRevision: v.number(),
    values: requestValuesValidator,
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { row } = await requireEditable(ctx, args.applicationId, args.requestId, args.expectedRevision);
    const values = normalizeRequestValues(args.values);
    assertValidValues(await pinnedDefinition(ctx, row), values);
    if (canonicalJson(row.values) === canonicalJson(values)) return { revision: row.revision };
    const revision = row.revision + 1;
    await ctx.db.patch(row._id, { values, revision, updatedAt: Date.now() });
    return { revision };
  },
});

// A draft's files never outnumber its attach events, attaching stops at the attach budget, and every remove follows an
// attach, so the bounds below cover every row the draft can hold.
async function removeAttachmentsOf(ctx: MutationCtx, requestId: Id<'requests'>) {
  const attachments = await ctx.db
    .query('requestAttachments')
    .withIndex('by_request', (q) => q.eq('requestId', requestId))
    .take(MAX_ATTACHMENTS_PER_REQUEST);
  for (const attachment of attachments) {
    await ctx.db.delete(attachment._id);
    await ctx.storage.delete(attachment.storageId);
  }
  const events = await ctx.db
    .query('attachmentEvents')
    .withIndex('by_request', (q) => q.eq('requestId', requestId))
    .take(MAX_ATTACHMENT_EVENTS_PER_REQUEST);
  for (const event of events) await ctx.db.delete(event._id);
}

export const remove = mutation({
  args: { applicationId: v.id('applications'), requestId: v.id('requests'), expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { row } = await requireEditable(ctx, args.applicationId, args.requestId, args.expectedRevision);
    await removeAttachmentsOf(ctx, row._id);
    await ctx.db.delete(row._id);
    const counter = await findCounter(ctx, row.applicationId);
    if (counter) await ctx.db.patch(counter._id, { count: Math.max(0, counter.count - 1) });
    return null;
  },
});

export const get = query({
  args: { applicationId: v.id('applications'), requestId: v.id('requests') },
  returns: v.union(requestViewValidator, v.null()),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const row = await ctx.db.get(args.requestId);
    if (!row || !canRead(principal, row)) return null;
    return toView(principal, row);
  },
});

export const list = query({
  args: {
    applicationId: v.id('applications'),
    filters: v.optional(
      v.array(v.object({ field: v.string(), operator: v.string(), value: v.optional(requestValueValidator) })),
    ),
    sort: v.optional(v.object({ field: v.string(), direction: v.string() })),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(requestViewValidator),
    total: v.number(),
    page: v.number(),
    pageSize: v.number(),
    pageCount: v.number(),
    scope: v.union(v.literal('own'), v.literal('application')),
  }),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const head = await findHead(ctx, principal.applicationId);
    const current = head?.currentVersionId ? await ctx.db.get(head.currentVersionId) : null;
    const fields: RecordQueryField[] = [];
    for (const field of current?.definition.fields ?? []) {
      if (field.type !== 'attachment') fields.push({ name: field.key, type: field.type });
    }

    const query = { filters: args.filters, sort: args.sort, page: args.page, pageSize: args.pageSize };
    validateRecordQuery(fields, query);

    const limit = MAX_REQUESTS_PER_APPLICATION + 1;
    const ranges = [
      await ctx.db
        .query('requests')
        .withIndex('by_application_requester', (q) =>
          q.eq('applicationId', principal.applicationId).eq('requesterMembershipId', principal.membershipId),
        )
        .take(limit),
    ];
    if (canReadAllRecords(principal)) {
      ranges.push(
        await ctx.db
          .query('requests')
          .withIndex('by_application_state', (q) => q.eq('applicationId', principal.applicationId).lt('state', 'draft'))
          .take(limit),
        await ctx.db
          .query('requests')
          .withIndex('by_application_state', (q) => q.eq('applicationId', principal.applicationId).gt('state', 'draft'))
          .take(limit),
      );
    }

    const readableById = new Map<Id<'requests'>, Doc<'requests'>>();
    for (const row of ranges.flat()) {
      if (canRead(principal, row)) readableById.set(row._id, row);
    }
    const readable = [...readableById.values()];
    if (
      ranges.some((rows) => rows.length > MAX_REQUESTS_PER_APPLICATION) ||
      readable.length > MAX_REQUESTS_PER_APPLICATION
    ) {
      throw requestError(
        'RECORD_BROWSE_LIMIT_EXCEEDED',
        `Browsing is limited to ${MAX_REQUESTS_PER_APPLICATION} requests per application`,
      );
    }

    const scope: 'own' | 'application' = readable.some((row) => !isOwn(principal, row)) ? 'application' : 'own';
    const page = queryRecords(readable, fields, query);
    return { ...page, items: page.items.map((row) => toView(principal, row)), scope };
  },
});
