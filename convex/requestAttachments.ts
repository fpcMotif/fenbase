import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import {
  MAX_ATTACHMENT_EVENTS_PER_REQUEST,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_SWEEP_BATCH,
  ORPHAN_GRACE_MS,
  canReadAttachments,
  extensionMatches,
  sameSha256,
  sanitizeFileName,
  sniffContentType,
} from './attachmentModel';
import { isAttachmentField } from './definitionModel';
import { requireApplicationPrincipal } from './membershipModel';
import {
  assertEditable,
  assertOperationId,
  canRead,
  notFound,
  pinnedDefinition,
  requestError,
  requireOwnRequest,
  sha256Hex,
} from './requests';

// Protected request evidence. Bytes reach storage only through `upload`, which binds them to the caller's draft in one
// server call, and leave only through `download`, which checks access again on every call. No function accepts or
// returns a storage id, and no storage URL is ever made.

const uploadArgs = {
  applicationId: v.id('applications'),
  requestId: v.id('requests'),
  fieldKey: v.string(),
  expectedRevision: v.number(),
  operationId: v.string(),
};

const uploadResultValidator = v.object({
  attachmentId: v.id('requestAttachments'),
  revision: v.number(),
  replayed: v.boolean(),
  fileName: v.string(),
  size: v.number(),
  contentType: v.string(),
  sha256: v.string(),
});

const authorizedUploadValidator = v.union(
  v.object({ kind: v.literal('replay'), result: uploadResultValidator }),
  v.object({ kind: v.literal('ok'), maxBytes: v.number(), accept: v.array(v.string()) }),
);

const authorizedDownloadValidator = v.union(
  v.object({
    storageId: v.id('_storage'),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.string(),
  }),
  v.null(),
);

const downloadResultValidator = v.object({
  fileName: v.string(),
  contentType: v.string(),
  size: v.number(),
  sha256: v.string(),
  bytes: v.bytes(),
});

const attachResultValidator = v.union(
  v.object({ kind: v.literal('replay'), result: uploadResultValidator }),
  uploadResultValidator,
);

// Actions that call functions of their own module need explicit types to break the inference cycle.
type UploadResult = Infer<typeof uploadResultValidator>;
type AuthorizedUpload = Infer<typeof authorizedUploadValidator>;
type AttachResult = Infer<typeof attachResultValidator>;
type AuthorizedDownload = Infer<typeof authorizedDownloadValidator>;
type DownloadResult = Infer<typeof downloadResultValidator>;

const attachmentViewValidator = v.object({
  _id: v.id('requestAttachments'),
  fieldKey: v.string(),
  fileName: v.string(),
  size: v.number(),
  contentType: v.string(),
  sha256: v.string(),
  createdAt: v.number(),
});

type UploadCheckArgs = {
  applicationId: Id<'applications'>;
  requestId: Id<'requests'>;
  fieldKey: string;
  expectedRevision: number;
  operationId: string;
  fingerprint: string;
};

export async function bytesSha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function findOperation(ctx: QueryCtx | MutationCtx, membershipId: Id<'memberships'>, operationId: string) {
  return ctx.db
    .query('attachmentEvents')
    .withIndex('by_actor_operation', (q) => q.eq('actorMembershipId', membershipId).eq('operationId', operationId))
    .first();
}

function operationConflict() {
  return requestError('RECORD_OPERATION_CONFLICT', 'This operation id was already used for a different file change');
}

function replayOf(event: Doc<'attachmentEvents'>) {
  return {
    attachmentId: event.attachmentId,
    revision: event.revision,
    replayed: true,
    fileName: event.fileName,
    size: event.size,
    contentType: event.contentType,
    sha256: event.sha256,
  };
}

// The order matches the review commands: access, then the replay, then the request state and revision, then the field
// and its limits. Both the authorizing query and the linking mutation run it, so the link re-checks what the upload saw.
async function checkUpload(ctx: QueryCtx | MutationCtx, args: UploadCheckArgs) {
  const { principal, row } = await requireOwnRequest(ctx, args.applicationId, args.requestId);
  assertOperationId(args.operationId);
  const previous = await findOperation(ctx, principal.membershipId, args.operationId);
  if (previous) {
    if (previous.kind !== 'attach' || previous.fingerprint !== args.fingerprint) throw operationConflict();
    return { kind: 'replay' as const, result: replayOf(previous) };
  }
  assertEditable(row, args.expectedRevision);
  const definition = await pinnedDefinition(ctx, row);
  const field = definition.fields.find((candidate) => candidate.key === args.fieldKey);
  if (!field || !isAttachmentField(field)) {
    throw requestError('RECORD_FIELD_UNKNOWN', 'This form has no such attachment field', { field: args.fieldKey });
  }
  const inField = await ctx.db
    .query('requestAttachments')
    .withIndex('by_request', (q) => q.eq('requestId', row._id).eq('fieldKey', field.key))
    .take(field.maxFiles);
  const inRequest = await ctx.db
    .query('requestAttachments')
    .withIndex('by_request', (q) => q.eq('requestId', row._id))
    .take(MAX_ATTACHMENTS_PER_REQUEST);
  const events = await ctx.db
    .query('attachmentEvents')
    .withIndex('by_request', (q) => q.eq('requestId', row._id))
    .take(MAX_ATTACHMENT_EVENTS_PER_REQUEST);
  if (
    inField.length >= field.maxFiles ||
    inRequest.length >= MAX_ATTACHMENTS_PER_REQUEST ||
    events.length >= MAX_ATTACHMENT_EVENTS_PER_REQUEST
  ) {
    throw requestError('ATTACHMENT_LIMIT_REACHED', 'This request holds no more files', {
      field: field.key,
      max: field.maxFiles,
    });
  }
  return { kind: 'ok' as const, principal, row, field };
}

export const authorizeUpload = internalQuery({
  args: { ...uploadArgs, fingerprint: v.string() },
  returns: authorizedUploadValidator,
  handler: async (ctx, args) => {
    const check = await checkUpload(ctx, args);
    if (check.kind === 'replay') return check;
    return { kind: 'ok' as const, maxBytes: check.field.maxBytes, accept: check.field.accept };
  },
});

export const attach = internalMutation({
  args: {
    ...uploadArgs,
    fingerprint: v.string(),
    storageId: v.id('_storage'),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.string(),
  },
  returns: attachResultValidator,
  handler: async (ctx, args) => {
    const check = await checkUpload(ctx, args);
    if (check.kind === 'replay') return check;
    const { principal, row, field } = check;
    const stored = await ctx.db.system.get('_storage', args.storageId);
    if (!stored || stored.size !== args.size || !sameSha256(stored.sha256, args.sha256)) {
      throw new Error('The stored file does not match the uploaded bytes (storage metadata mismatch)');
    }
    const linked = await ctx.db
      .query('requestAttachments')
      .withIndex('by_storage', (q) => q.eq('storageId', args.storageId))
      .first();
    if (linked) throw new Error('This stored file is already linked to an attachment');

    const now = Date.now();
    const revision = row.revision + 1;
    const metadata = {
      fieldKey: field.key,
      fileName: args.fileName,
      size: args.size,
      contentType: args.contentType,
      sha256: args.sha256,
    };
    const attachmentId = await ctx.db.insert('requestAttachments', {
      requestId: row._id,
      applicationId: row.applicationId,
      organizationId: row.organizationId,
      uploaderMembershipId: principal.membershipId,
      operationId: args.operationId,
      storageId: args.storageId,
      createdAt: now,
      ...metadata,
    });
    await ctx.db.patch(row._id, { revision, updatedAt: now });
    await ctx.db.insert('attachmentEvents', {
      requestId: row._id,
      applicationId: row.applicationId,
      organizationId: row.organizationId,
      actorMembershipId: principal.membershipId,
      operationId: args.operationId,
      fingerprint: args.fingerprint,
      kind: 'attach',
      attachmentId,
      revision,
      createdAt: now,
      ...metadata,
    });
    const { fieldKey: _fieldKey, ...file } = metadata;
    return { attachmentId, revision, replayed: false, ...file };
  },
});

export const upload = action({
  args: { ...uploadArgs, fileName: v.string(), bytes: v.bytes() },
  returns: uploadResultValidator,
  handler: async (ctx, args): Promise<UploadResult> => {
    const bytes = new Uint8Array(args.bytes);
    const sha256 = await bytesSha256Hex(args.bytes);
    const checkArgs = {
      applicationId: args.applicationId,
      requestId: args.requestId,
      fieldKey: args.fieldKey,
      expectedRevision: args.expectedRevision,
      operationId: args.operationId,
      fingerprint: await sha256Hex({
        kind: 'attach',
        requestId: args.requestId,
        fieldKey: args.fieldKey,
        fileName: args.fileName,
        sha256,
        expectedRevision: args.expectedRevision,
      }),
    };
    const authorized: AuthorizedUpload = await ctx.runQuery(internal.requestAttachments.authorizeUpload, checkArgs);
    if (authorized.kind === 'replay') return authorized.result;

    if (bytes.byteLength > authorized.maxBytes) {
      throw requestError('ATTACHMENT_TOO_LARGE', 'The file is larger than this field allows', {
        field: args.fieldKey,
        max: authorized.maxBytes,
      });
    }
    const fileName = sanitizeFileName(args.fileName);
    if (fileName === null) {
      throw requestError('ATTACHMENT_NAME_INVALID', 'The file name is empty or unusable', { field: args.fieldKey });
    }
    const contentType = sniffContentType(bytes);
    if (contentType === null || !authorized.accept.includes(contentType) || !extensionMatches(fileName, contentType)) {
      throw requestError('ATTACHMENT_TYPE_NOT_ALLOWED', 'This file type is not allowed here', {
        field: args.fieldKey,
      });
    }

    const storageId = await ctx.storage.store(new Blob([args.bytes], { type: contentType }));
    let linked: AttachResult;
    try {
      linked = await ctx.runMutation(internal.requestAttachments.attach, {
        ...checkArgs,
        storageId,
        fileName,
        contentType,
        size: bytes.byteLength,
        sha256,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
    if ('kind' in linked) {
      await ctx.storage.delete(storageId);
      return linked.result;
    }
    return linked;
  },
});

export const remove = mutation({
  args: {
    applicationId: v.id('applications'),
    requestId: v.id('requests'),
    attachmentId: v.id('requestAttachments'),
    expectedRevision: v.number(),
    operationId: v.string(),
  },
  returns: v.object({ revision: v.number(), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const { principal, row } = await requireOwnRequest(ctx, args.applicationId, args.requestId);
    assertOperationId(args.operationId);
    const fingerprint = await sha256Hex({
      kind: 'remove',
      requestId: args.requestId,
      attachmentId: args.attachmentId,
      expectedRevision: args.expectedRevision,
    });
    const previous = await findOperation(ctx, principal.membershipId, args.operationId);
    if (previous) {
      if (previous.kind !== 'remove' || previous.fingerprint !== fingerprint) throw operationConflict();
      return { revision: previous.revision, replayed: true };
    }
    assertEditable(row, args.expectedRevision);
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment || attachment.requestId !== row._id) throw notFound();

    const now = Date.now();
    const revision = row.revision + 1;
    await ctx.db.delete(attachment._id);
    await ctx.storage.delete(attachment.storageId);
    await ctx.db.patch(row._id, { revision, updatedAt: now });
    await ctx.db.insert('attachmentEvents', {
      requestId: row._id,
      applicationId: row.applicationId,
      organizationId: row.organizationId,
      actorMembershipId: principal.membershipId,
      operationId: args.operationId,
      fingerprint,
      kind: 'remove',
      attachmentId: attachment._id,
      fieldKey: attachment.fieldKey,
      fileName: attachment.fileName,
      size: attachment.size,
      contentType: attachment.contentType,
      sha256: attachment.sha256,
      revision,
      createdAt: now,
    });
    return { revision, replayed: false };
  },
});

// Null when the caller cannot read the request, an empty list when they can read the request but not its files.
export const list = query({
  args: { applicationId: v.id('applications'), requestId: v.id('requests') },
  returns: v.union(v.array(attachmentViewValidator), v.null()),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const row = await ctx.db.get(args.requestId);
    if (!row || !canRead(principal, row)) return null;
    if (!canReadAttachments(principal, row)) return [];
    const attachments = await ctx.db
      .query('requestAttachments')
      .withIndex('by_request', (q) => q.eq('requestId', row._id))
      .take(MAX_ATTACHMENTS_PER_REQUEST);
    return attachments.map((attachment) => ({
      _id: attachment._id,
      fieldKey: attachment.fieldKey,
      fileName: attachment.fileName,
      size: attachment.size,
      contentType: attachment.contentType,
      sha256: attachment.sha256,
      createdAt: attachment.createdAt,
    }));
  },
});

// Missing, foreign, cross-application and denied attachments all return null, so a caller cannot tell them apart.
export const authorizeDownload = internalQuery({
  args: { applicationId: v.id('applications'), attachmentId: v.id('requestAttachments') },
  returns: authorizedDownloadValidator,
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment || attachment.applicationId !== principal.applicationId) return null;
    const row = await ctx.db.get(attachment.requestId);
    if (!row || !canRead(principal, row) || !canReadAttachments(principal, row)) return null;
    return {
      storageId: attachment.storageId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
    };
  },
});

export const download = action({
  args: { applicationId: v.id('applications'), attachmentId: v.id('requestAttachments') },
  returns: downloadResultValidator,
  handler: async (ctx, args): Promise<DownloadResult> => {
    const authorized: AuthorizedDownload = await ctx.runQuery(internal.requestAttachments.authorizeDownload, args);
    if (!authorized) throw notFound();
    const blob = await ctx.storage.get(authorized.storageId);
    if (!blob) throw new Error('Attachment integrity check failed: the stored file is missing');
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength !== authorized.size || (await bytesSha256Hex(bytes)) !== authorized.sha256) {
      throw new Error('Attachment integrity check failed: the stored bytes changed');
    }
    const { storageId: _storageId, ...metadata } = authorized;
    return { ...metadata, bytes };
  },
});

// Deletes blobs that no attachment row owns once they are older than the grace window, one bounded page per run, and
// schedules itself for the next page.
export const sweepOrphans = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), olderThanMs: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ scanned: v.number(), deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? MAX_SWEEP_BATCH), 1), MAX_SWEEP_BATCH);
    const cutoff = Date.now() - (args.olderThanMs ?? ORPHAN_GRACE_MS);
    const page = await ctx.db.system.query('_storage').order('asc').paginate({ cursor: args.cursor, numItems: limit });
    let deleted = 0;
    for (const file of page.page) {
      if (file._creationTime > cutoff) continue;
      const owner = await ctx.db
        .query('requestAttachments')
        .withIndex('by_storage', (q) => q.eq('storageId', file._id))
        .first();
      if (owner) continue;
      await ctx.storage.delete(file._id);
      deleted += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.requestAttachments.sweepOrphans, {
        cursor: page.continueCursor,
        olderThanMs: args.olderThanMs,
        limit: args.limit,
      });
    }
    return { scanned: page.page.length, deleted, isDone: page.isDone };
  },
});
