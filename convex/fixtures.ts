import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { capabilityValidator, membershipStatusValidator, type Capability } from './membershipValidators';

const FIXTURE_ORGANIZATION_PREFIX = 'fixture-';
const FIXTURE_APPLICATION_KEY = 'leaveRequests';
const FIXTURE_APPLICATION_NAME = 'Leave requests';
const FIXTURE_DELETE_BATCH = 500;

function assertFixtureOrganizationKey(organizationKey: string): void {
  if (!organizationKey.startsWith(FIXTURE_ORGANIZATION_PREFIX)) {
    throw new ConvexError({
      code: 'FIXTURE_ORGANIZATION_KEY_INVALID',
      message: `Fixture organization keys must start with ${FIXTURE_ORGANIZATION_PREFIX}`,
    });
  }
}

function sameGrants(left: readonly Capability[], right: readonly Capability[]): boolean {
  const rightSet = new Set(right);
  return left.length === rightSet.size && left.every((grant) => rightSet.has(grant));
}

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
    assertFixtureOrganizationKey(args.organizationKey);
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
    const membershipId =
      existingMembership?._id ??
      (await ctx.db.insert('memberships', {
        authUserId: args.authUserId,
        applicationId,
        organizationId,
        status: args.status,
        grants: args.capabilities,
        updatedAt: Date.now(),
      }));
    if (
      existingMembership &&
      (existingMembership.status !== args.status || !sameGrants(existingMembership.grants, args.capabilities))
    ) {
      await ctx.db.patch(existingMembership._id, {
        status: args.status,
        grants: args.capabilities,
        updatedAt: Date.now(),
      });
    }

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
  returns: v.object({
    organizations: v.number(),
    applications: v.number(),
    memberships: v.number(),
    definitions: v.number(),
    definitionVersions: v.number(),
    requests: v.number(),
  }),
  handler: async (ctx, args) => {
    assertFixtureOrganizationKey(args.organizationKey);
    const removed = {
      organizations: 0,
      applications: 0,
      memberships: 0,
      definitions: 0,
      definitionVersions: 0,
      requests: 0,
    };
    const organization = await ctx.db
      .query('organizations')
      .withIndex('by_key', (q) => q.eq('key', args.organizationKey))
      .unique();
    if (!organization) return removed;

    for (;;) {
      const applications = await ctx.db
        .query('applications')
        .withIndex('by_organization_key', (q) => q.eq('organizationId', organization._id))
        .take(FIXTURE_DELETE_BATCH);
      if (applications.length === 0) break;
      for (const application of applications) {
        for (;;) {
          const requests = await ctx.db
            .query('requests')
            .withIndex('by_application_requester', (q) => q.eq('applicationId', application._id))
            .take(FIXTURE_DELETE_BATCH);
          if (requests.length === 0) break;
          for (const request of requests) {
            await ctx.db.delete(request._id);
            removed.requests += 1;
          }
        }
        const counter = await ctx.db
          .query('requestCounts')
          .withIndex('by_application', (q) => q.eq('applicationId', application._id))
          .unique();
        if (counter) await ctx.db.delete(counter._id);
        for (;;) {
          const versions = await ctx.db
            .query('applicationDefinitionVersions')
            .withIndex('by_application_version', (q) => q.eq('applicationId', application._id))
            .take(FIXTURE_DELETE_BATCH);
          if (versions.length === 0) break;
          for (const version of versions) {
            await ctx.db.delete(version._id);
            removed.definitionVersions += 1;
          }
        }
        const definition = await ctx.db
          .query('applicationDefinitions')
          .withIndex('by_application', (q) => q.eq('applicationId', application._id))
          .unique();
        if (definition) {
          await ctx.db.delete(definition._id);
          removed.definitions += 1;
        }
        for (;;) {
          const memberships = await ctx.db
            .query('memberships')
            .withIndex('by_application', (q) => q.eq('applicationId', application._id))
            .take(FIXTURE_DELETE_BATCH);
          if (memberships.length === 0) break;
          for (const membership of memberships) {
            await ctx.db.delete(membership._id);
            removed.memberships += 1;
          }
        }
        await ctx.db.delete(application._id);
        removed.applications += 1;
      }
    }
    await ctx.db.delete(organization._id);
    removed.organizations += 1;
    return removed;
  },
});
