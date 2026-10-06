import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { requireUser } from './auth';
import type { Capability } from './membershipValidators';

export type ApplicationPrincipal = {
  authUserId: string;
  membershipId: Id<'memberships'>;
  application: Doc<'applications'>;
  applicationId: Id<'applications'>;
  organizationId: Id<'organizations'>;
  grants: ReadonlySet<Capability>;
};

export function applicationAccessDenied(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: 'APPLICATION_ACCESS_DENIED',
    message: 'You do not have access to this application',
  });
}

export async function requireApplicationPrincipal(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<'applications'>,
): Promise<ApplicationPrincipal> {
  const authUserId = await requireUser(ctx);
  const membership = await ctx.db
    .query('memberships')
    .withIndex('by_auth_user_application', (q) => q.eq('authUserId', authUserId).eq('applicationId', applicationId))
    .unique();
  if (!membership || membership.status !== 'active') throw applicationAccessDenied();
  const application = await ctx.db.get(membership.applicationId);
  if (!application || application.organizationId !== membership.organizationId) throw applicationAccessDenied();

  return {
    authUserId,
    membershipId: membership._id,
    application,
    applicationId: application._id,
    organizationId: application.organizationId,
    grants: new Set(membership.grants),
  };
}

export function canConfigureApplication(principal: ApplicationPrincipal): boolean {
  return principal.grants.has('configureApplication');
}

export function canReadAllRecords(principal: ApplicationPrincipal): boolean {
  return principal.grants.has('readApplicationRecords');
}

export function assertCanManageMember(principal: ApplicationPrincipal, target?: Doc<'memberships'>): void {
  if (!principal.grants.has('manageMembers')) {
    throw new ConvexError({
      code: 'PERMISSION_DENIED',
      message: 'You do not have permission to manage members of this application',
    });
  }
  if (!target) return;
  if (target.applicationId !== principal.applicationId) throw membershipNotFound();
  if (target.authUserId === principal.authUserId) {
    throw new ConvexError({
      code: 'SELF_ADMINISTRATION_DENIED',
      message: 'You cannot change your own membership',
    });
  }
}

export function membershipNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: 'MEMBERSHIP_NOT_FOUND', message: 'Membership not found' });
}
