import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import { requireUser } from './auth';
import {
  applicationAccessDenied,
  assertHasManageMembers,
  assertManageableTarget,
  canConfigureApplication,
  canReadAllRecords,
  membershipNotFound,
  requireApplicationPrincipal,
} from './membershipModel';
import { assignableCapabilityValidator, capabilityValidator, membershipStatusValidator } from './membershipValidators';

const MAX_LISTED_MEMBERSHIPS = 100;

function assertWithinListLimit(rows: readonly unknown[]): void {
  if (rows.length > MAX_LISTED_MEMBERSHIPS) {
    throw new ConvexError({
      code: 'MEMBERSHIP_LIST_LIMIT_EXCEEDED',
      message: `Membership lists are limited to ${MAX_LISTED_MEMBERSHIPS} rows`,
    });
  }
}

export const listMine = query({
  args: {},
  returns: v.array(
    v.object({
      membershipId: v.id('memberships'),
      applicationId: v.id('applications'),
      applicationName: v.string(),
      organizationName: v.string(),
      grants: v.array(capabilityValidator),
    }),
  ),
  handler: async (ctx) => {
    const authUserId = await requireUser(ctx);
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_auth_user_status', (q) => q.eq('authUserId', authUserId).eq('status', 'active'))
      .take(MAX_LISTED_MEMBERSHIPS + 1);
    assertWithinListLimit(memberships);

    const items = [];
    for (const membership of memberships) {
      const application = await ctx.db.get(membership.applicationId);
      if (!application || application.organizationId !== membership.organizationId) continue;
      const organization = await ctx.db.get(application.organizationId);
      if (!organization) continue;
      items.push({
        membershipId: membership._id,
        applicationId: membership.applicationId,
        applicationName: application.name,
        organizationName: organization.name,
        grants: membership.grants,
      });
    }
    return items;
  },
});

const memberSummaryValidator = v.object({
  membershipId: v.id('memberships'),
  status: membershipStatusValidator,
  grants: v.array(capabilityValidator),
  updatedAt: v.number(),
});

export const listMembers = query({
  args: { applicationId: v.id('applications') },
  returns: v.array(memberSummaryValidator),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    assertHasManageMembers(principal);
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_application', (q) => q.eq('applicationId', principal.applicationId))
      .take(MAX_LISTED_MEMBERSHIPS + 1);
    assertWithinListLimit(members);
    return members.map(toMemberSummary);
  },
});

function toMemberSummary(member: Doc<'memberships'>) {
  return {
    membershipId: member._id,
    status: member.status,
    grants: member.grants,
    updatedAt: member.updatedAt,
  };
}

async function requireManagedMember(
  ctx: MutationCtx,
  applicationId: Id<'applications'>,
  membershipId: Id<'memberships'>,
): Promise<Doc<'memberships'>> {
  const principal = await requireApplicationPrincipal(ctx, applicationId);
  assertHasManageMembers(principal);
  const target = await ctx.db.get(membershipId);
  if (!target) throw membershipNotFound();
  assertManageableTarget(principal, target);
  return target;
}

export const setMemberStatus = mutation({
  args: {
    applicationId: v.id('applications'),
    membershipId: v.id('memberships'),
    status: membershipStatusValidator,
  },
  returns: memberSummaryValidator,
  handler: async (ctx, args) => {
    const target = await requireManagedMember(ctx, args.applicationId, args.membershipId);
    if (target.status === args.status) return toMemberSummary(target);

    const updatedAt = Date.now();
    await ctx.db.patch(target._id, { status: args.status, updatedAt });
    return toMemberSummary({ ...target, status: args.status, updatedAt });
  },
});

const grantArgs = {
  applicationId: v.id('applications'),
  membershipId: v.id('memberships'),
  capability: assignableCapabilityValidator,
};

export const assignGrant = mutation({
  args: grantArgs,
  returns: memberSummaryValidator,
  handler: async (ctx, args) => {
    const target = await requireManagedMember(ctx, args.applicationId, args.membershipId);
    if (target.status !== 'active') {
      throw new ConvexError({ code: 'MEMBERSHIP_INACTIVE', message: 'Reactivate this member before granting access' });
    }
    if (target.grants.includes(args.capability)) return toMemberSummary(target);

    const updated = { grants: [...target.grants, args.capability], updatedAt: Date.now() };
    await ctx.db.patch(target._id, updated);
    return toMemberSummary({ ...target, ...updated });
  },
});

export const revokeGrant = mutation({
  args: grantArgs,
  returns: memberSummaryValidator,
  handler: async (ctx, args) => {
    const target = await requireManagedMember(ctx, args.applicationId, args.membershipId);
    if (!target.grants.includes(args.capability)) return toMemberSummary(target);

    const updated = {
      grants: target.grants.filter((grant) => grant !== args.capability),
      updatedAt: Date.now(),
    };
    await ctx.db.patch(target._id, updated);
    return toMemberSummary({ ...target, ...updated });
  },
});

export const getMyAccess = query({
  args: { applicationId: v.id('applications') },
  returns: v.object({
    membershipId: v.id('memberships'),
    status: membershipStatusValidator,
    grants: v.array(capabilityValidator),
    organization: v.object({ key: v.string(), name: v.string() }),
    application: v.object({ key: v.string(), name: v.string() }),
    capabilities: v.object({
      configureApplication: v.boolean(),
      readAllRecords: v.boolean(),
      submitRequests: v.boolean(),
      reviewRequests: v.boolean(),
      manageMembers: v.boolean(),
    }),
  }),
  handler: async (ctx, args) => {
    const principal = await requireApplicationPrincipal(ctx, args.applicationId);
    const { application } = principal;
    const organization = await ctx.db.get(principal.organizationId);
    if (!organization) throw applicationAccessDenied();

    return {
      membershipId: principal.membershipId,
      status: 'active' as const,
      grants: [...principal.grants],
      organization: { key: organization.key, name: organization.name },
      application: { key: application.key, name: application.name },
      capabilities: {
        configureApplication: canConfigureApplication(principal),
        readAllRecords: canReadAllRecords(principal),
        submitRequests: principal.grants.has('submitRequests'),
        reviewRequests: principal.grants.has('reviewRequests'),
        manageMembers: principal.grants.has('manageMembers'),
      },
    };
  },
});
