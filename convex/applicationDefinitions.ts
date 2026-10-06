import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import {
  definitionValidator,
  publishedKeysOf,
  publishedKeyValidator,
  validateDefinition,
  type Definition,
  type DefinitionErrorCode,
  type PublishedKey,
} from './definitionModel';
import {
  assertCanConfigureApplication,
  isEligibleReviewer,
  requireApplicationPrincipal,
  type ApplicationPrincipal,
} from './membershipModel';

const MAX_LISTED_ROWS = 100;

function definitionError(code: DefinitionErrorCode, message: string, field?: string) {
  return new ConvexError(field === undefined ? { code, message } : { code, message, field });
}

function revisionConflict(currentRevision: number) {
  return new ConvexError({
    code: 'DEFINITION_REVISION_CONFLICT',
    message: 'The definition changed since you loaded it',
    currentRevision,
  });
}

async function findHead(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<'applications'>,
): Promise<Doc<'applicationDefinitions'> | null> {
  return ctx.db
    .query('applicationDefinitions')
    .withIndex('by_application', (q) => q.eq('applicationId', applicationId))
    .unique();
}

async function currentPublishedKeys(
  ctx: QueryCtx | MutationCtx,
  head: Doc<'applicationDefinitions'> | null,
): Promise<PublishedKey[]> {
  if (!head?.currentVersionId) return [];
  const current = await ctx.db.get(head.currentVersionId);
  return current ? publishedKeysOf(current.definition) : [];
}

async function assertValidDefinition(
  ctx: MutationCtx,
  principal: ApplicationPrincipal,
  definition: Definition,
  publishedKeys: readonly PublishedKey[],
): Promise<void> {
  const issue = validateDefinition(definition, publishedKeys);
  if (issue) throw definitionError(issue.code, 'The definition is invalid', issue.field);
  if (!(await isEligibleReviewer(ctx, principal.applicationId, definition.reviewerMembershipId))) {
    throw definitionError(
      'DEFINITION_REVIEWER_INVALID',
      'The reviewer must be an active member of this application who can review requests',
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function requireBuilder(ctx: QueryCtx | MutationCtx, applicationId: Id<'applications'>) {
  const principal = await requireApplicationPrincipal(ctx, applicationId);
  assertCanConfigureApplication(principal);
  return principal;
}

const versionSummaryValidator = v.object({
  versionId: v.id('applicationDefinitionVersions'),
  version: v.number(),
  sourceRevision: v.number(),
  publishedAt: v.number(),
  publishedByMembershipId: v.id('memberships'),
});

export const getBuilderState = query({
  args: { applicationId: v.id('applications') },
  returns: v.object({
    head: v.union(
      v.object({
        revision: v.number(),
        draft: definitionValidator,
        publishedRevision: v.union(v.number(), v.null()),
        currentVersion: v.union(
          v.object({ versionId: v.id('applicationDefinitionVersions'), version: v.number() }),
          v.null(),
        ),
        latestVersion: v.number(),
      }),
      v.null(),
    ),
    versions: v.array(versionSummaryValidator),
    reviewerCandidates: v.array(v.object({ membershipId: v.id('memberships'), isSelf: v.boolean() })),
    publishedKeys: v.array(publishedKeyValidator),
  }),
  handler: async (ctx, args) => {
    const principal = await requireBuilder(ctx, args.applicationId);
    const head = await findHead(ctx, principal.applicationId);

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_application', (q) => q.eq('applicationId', principal.applicationId))
      .take(MAX_LISTED_ROWS + 1);
    if (members.length > MAX_LISTED_ROWS) {
      throw new ConvexError({
        code: 'MEMBERSHIP_LIST_LIMIT_EXCEEDED',
        message: `Membership lists are limited to ${MAX_LISTED_ROWS} rows`,
      });
    }
    const reviewerCandidates = members
      .filter((member) => member.status === 'active' && member.grants.includes('reviewRequests'))
      .map((member) => ({ membershipId: member._id, isSelf: member._id === principal.membershipId }));

    const versionRows = await ctx.db
      .query('applicationDefinitionVersions')
      .withIndex('by_application_version', (q) => q.eq('applicationId', principal.applicationId))
      .order('desc')
      .take(MAX_LISTED_ROWS);
    const versions = versionRows
      .map((row) => ({
        versionId: row._id,
        version: row.version,
        sourceRevision: row.sourceRevision,
        publishedAt: row.publishedAt,
        publishedByMembershipId: row.publishedByMembershipId,
      }))
      .sort((left, right) => right.version - left.version);

    const current = head?.currentVersionId ? await ctx.db.get(head.currentVersionId) : null;
    return {
      head: head && {
        revision: head.revision,
        draft: head.draft,
        publishedRevision: head.publishedRevision,
        currentVersion: current && { versionId: current._id, version: current.version },
        latestVersion: head.latestVersion,
      },
      versions,
      reviewerCandidates,
      publishedKeys: current ? publishedKeysOf(current.definition) : [],
    };
  },
});

export const getPublishedVersion = query({
  args: { applicationId: v.id('applications'), versionId: v.optional(v.id('applicationDefinitionVersions')) },
  returns: v.object({
    versionId: v.id('applicationDefinitionVersions'),
    applicationId: v.id('applications'),
    version: v.number(),
    isCurrent: v.boolean(),
    definition: definitionValidator,
    sourceRevision: v.number(),
    publishedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const head = await findHead(ctx, principal.applicationId);
    const versionId = args.versionId ?? head?.currentVersionId;
    if (!versionId) throw definitionError('DEFINITION_NOT_FOUND', 'This application has no published definition');
    const row = await ctx.db.get(versionId);
    if (!row || row.applicationId !== principal.applicationId) {
      throw definitionError('DEFINITION_VERSION_NOT_FOUND', 'Definition version not found');
    }
    return {
      versionId: row._id,
      applicationId: row.applicationId,
      version: row.version,
      isCurrent: head?.currentVersionId === row._id,
      definition: row.definition,
      sourceRevision: row.sourceRevision,
      publishedAt: row.publishedAt,
    };
  },
});

export const saveDraft = mutation({
  args: { applicationId: v.id('applications'), expectedRevision: v.number(), definition: definitionValidator },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const principal = await requireBuilder(ctx, args.applicationId);
    const head = await findHead(ctx, principal.applicationId);
    const currentRevision = head?.revision ?? 0;
    if (args.expectedRevision !== currentRevision) throw revisionConflict(currentRevision);
    await assertValidDefinition(ctx, principal, args.definition, await currentPublishedKeys(ctx, head));

    const updatedAt = Date.now();
    if (!head) {
      await ctx.db.insert('applicationDefinitions', {
        applicationId: principal.applicationId,
        organizationId: principal.organizationId,
        draft: args.definition,
        revision: 1,
        publishedRevision: null,
        currentVersionId: null,
        latestVersion: 0,
        updatedAt,
        updatedByMembershipId: principal.membershipId,
      });
      return { revision: 1 };
    }
    if (canonicalJson(head.draft) === canonicalJson(args.definition)) return { revision: head.revision };

    const revision = head.revision + 1;
    await ctx.db.patch(head._id, {
      draft: args.definition,
      revision,
      updatedAt,
      updatedByMembershipId: principal.membershipId,
    });
    return { revision };
  },
});

export const publish = mutation({
  args: { applicationId: v.id('applications'), expectedRevision: v.number() },
  returns: v.object({
    versionId: v.id('applicationDefinitionVersions'),
    version: v.number(),
    revision: v.number(),
  }),
  handler: async (ctx, args) => {
    const principal = await requireBuilder(ctx, args.applicationId);
    const head = await findHead(ctx, principal.applicationId);
    if (!head) throw definitionError('DEFINITION_NOT_FOUND', 'Save a draft before publishing');
    if (args.expectedRevision !== head.revision) throw revisionConflict(head.revision);
    if (head.publishedRevision === head.revision) {
      throw definitionError('DEFINITION_NOTHING_TO_PUBLISH', 'The draft has no changes since the last publish');
    }
    await assertValidDefinition(ctx, principal, head.draft, await currentPublishedKeys(ctx, head));

    const now = Date.now();
    const version = head.latestVersion + 1;
    const revision = head.revision + 1;
    const versionId = await ctx.db.insert('applicationDefinitionVersions', {
      applicationId: principal.applicationId,
      organizationId: principal.organizationId,
      version,
      definition: head.draft,
      sourceRevision: head.revision,
      publishedAt: now,
      publishedByMembershipId: principal.membershipId,
    });
    await ctx.db.patch(head._id, {
      currentVersionId: versionId,
      latestVersion: version,
      revision,
      publishedRevision: revision,
      updatedAt: now,
      updatedByMembershipId: principal.membershipId,
    });
    return { versionId, version, revision };
  },
});
