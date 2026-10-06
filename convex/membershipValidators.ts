import { v, type Infer } from 'convex/values';

export const capabilityValidator = v.union(
  v.literal('configureApplication'),
  v.literal('submitRequests'),
  v.literal('reviewRequests'),
  v.literal('readApplicationRecords'),
  v.literal('manageMembers'),
);

// `manageMembers` is deliberately absent: only the internal fixture seed can give it.
export const assignableCapabilityValidator = v.union(
  v.literal('configureApplication'),
  v.literal('submitRequests'),
  v.literal('reviewRequests'),
  v.literal('readApplicationRecords'),
);

export const membershipStatusValidator = v.union(v.literal('active'), v.literal('inactive'));

export type Capability = Infer<typeof capabilityValidator>;
export type AssignableCapability = Infer<typeof assignableCapabilityValidator>;
export type MembershipStatus = Infer<typeof membershipStatusValidator>;
