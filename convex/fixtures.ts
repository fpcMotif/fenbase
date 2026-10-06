import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { capabilityValidator, membershipStatusValidator } from './membershipValidators';

const FIXTURE_ORGANIZATION_PREFIX = 'fixture-';
const FIXTURE_APPLICATION_KEY = 'leaveRequests';
const FIXTURE_APPLICATION_NAME = 'Leave requests';
const MAX_FIXTURE_APPLICATIONS = 10;
const MAX_FIXTURE_MEMBERSHIPS = 500;

export const upsertMember = internalMutation({
  args: {
    organizationKey: v.string(),
    organizationName: v.string(),
    authUserId: v.string(),
    capabilities: v.array(capabilityValidator),
    status: membershipStatusValidator,
  },
  returns: v.object({
    organizationId: v.id('organizations'),
    applicationId: v.id('applications'),
    membershipId: v.id('memberships'),
    created: v.object({ organization: v.boolean(), application: v.boolean(), membership: v.boolean() }),
  }),
  handler: async (ctx, args) => {
    if (!args.organizationKey.startsWith(FIXTURE_ORGANIZATION_PREFIX)) {
      throw new ConvexError({
        code: 'FIXTURE_ORGANIZATION_KEY_INVALID',
        message: `Fixture organization keys must start with ${FIXTURE_ORGANIZATION_PREFIX}`,
      });
    }
    if (new Set(args.capabilities).size !== args.capabilities.length) {
      throw new ConvexError({ code: 'FIXTURE_CAPABILITY_DUPLICATE', message: 'Capabilities must not repeat' });
    }

    const existingOrganization = await ctx.db
      .query('organizations')
      .withIndex('by_key', (q) => q.eq('key', args.organizationKey))
      .unique();
    const organizationId =
      existingOrganization?._id ??
      (await ctx.db.insert('organizations', { key: args.organizationKey, name: args.organizationName }));

    const existingApplication = await ctx.db
      .query('applications')
      .withIndex('by_organization_key', (q) =>
        q.eq('organizationId', organizationId).eq('key', FIXTURE_APPLICATION_KEY),
      )
      .unique();
    const applicationId =
      existingApplication?._id ??
      (await ctx.db.insert('applications', {
        organizationId,
        key: FIXTURE_APPLICATION_KEY,
        name: FIXTURE_APPLICATION_NAME,
      }));

    const existingMembership = await ctx.db
      .query('memberships')
      .withIndex('by_auth_user_application', (q) =>
        q.eq('authUserId', args.authUserId).eq('applicationId', applicationId),
      )
      .unique();
    let membershipId = existingMembership?._id;
    if (!existingMembership) {
      membershipId = await ctx.db.insert('memberships', {
        authUserId: args.authUserId,
        applicationId,
        organizationId,
        status: args.status,
        grants: args.capabilities,
        updatedAt: Date.now(),
      });
    } else if (
      existingMembership.status !== args.status ||
      existingMembership.grants.join(',') !== args.capabilities.join(',')
    ) {
      await ctx.db.patch(existingMembership._id, {
        status: args.status,
        grants: args.capabilities,
        updatedAt: Date.now(),
      });
    }
    if (!membershipId) throw new Error('Fixture membership was not written');

    return {
      organizationId,
      applicationId,
      membershipId,
      created: {
        organization: !existingOrganization,
        application: !existingApplication,
        membership: !existingMembership,
      },
    };
  },
});

export const removeOrganization = internalMutation({
  args: { organizationKey: v.string() },
  returns: v.object({ organizations: v.number(), applications: v.number(), memberships: v.number() }),
  handler: async (ctx, args) => {
    const removed = { organizations: 0, applications: 0, memberships: 0 };
    if (!args.organizationKey.startsWith(FIXTURE_ORGANIZATION_PREFIX)) {
      throw new ConvexError({
        code: 'FIXTURE_ORGANIZATION_KEY_INVALID',
        message: `Fixture organization keys must start with ${FIXTURE_ORGANIZATION_PREFIX}`,
      });
    }
    const organization = await ctx.db
      .query('organizations')
      .withIndex('by_key', (q) => q.eq('key', args.organizationKey))
      .unique();
    if (!organization) return removed;

    const applications = await ctx.db
      .query('applications')
      .withIndex('by_organization_key', (q) => q.eq('organizationId', organization._id))
      .take(MAX_FIXTURE_APPLICATIONS);
    for (const application of applications) {
      const memberships = await ctx.db
        .query('memberships')
        .withIndex('by_application', (q) => q.eq('applicationId', application._id))
        .take(MAX_FIXTURE_MEMBERSHIPS);
      for (const membership of memberships) {
        await ctx.db.delete(membership._id);
        removed.memberships += 1;
      }
      await ctx.db.delete(application._id);
      removed.applications += 1;
    }
    await ctx.db.delete(organization._id);
    removed.organizations += 1;
    return removed;
  },
});
