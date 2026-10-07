import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { definitionValidator, policyPresetValidator } from './definitionModel';
import { capabilityValidator, membershipStatusValidator } from './membershipValidators';
import {
  requestStateValidator,
  requestValuesValidator,
  reviewCommandValidator,
  reviewTaskStatusValidator,
} from './requestValues';

export default defineSchema({
  organizations: defineTable({
    key: v.string(),
    name: v.string(),
  }).index('by_key', ['key']),

  applications: defineTable({
    organizationId: v.id('organizations'),
    key: v.string(),
    name: v.string(),
  }).index('by_organization_key', ['organizationId', 'key']),

  memberships: defineTable({
    authUserId: v.string(),
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    status: membershipStatusValidator,
    grants: v.array(capabilityValidator),
    updatedAt: v.number(),
  })
    .index('by_auth_user_application', ['authUserId', 'applicationId'])
    .index('by_auth_user_status', ['authUserId', 'status'])
    .index('by_application', ['applicationId']),

  applicationDefinitions: defineTable({
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    draft: definitionValidator,
    revision: v.number(),
    publishedRevision: v.union(v.number(), v.null()),
    currentVersionId: v.union(v.id('applicationDefinitionVersions'), v.null()),
    latestVersion: v.number(),
    updatedAt: v.number(),
    updatedByMembershipId: v.id('memberships'),
  }).index('by_application', ['applicationId']),

  applicationDefinitionVersions: defineTable({
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    version: v.number(),
    definition: definitionValidator,
    sourceRevision: v.number(),
    publishedAt: v.number(),
    publishedByMembershipId: v.id('memberships'),
  }).index('by_application_version', ['applicationId', 'version']),

  requests: defineTable({
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    requesterMembershipId: v.id('memberships'),
    definitionVersionId: v.id('applicationDefinitionVersions'),
    version: v.number(),
    policyPreset: policyPresetValidator,
    state: requestStateValidator,
    revision: v.number(),
    operationId: v.string(),
    operationFingerprint: v.string(),
    values: requestValuesValidator,
    updatedAt: v.number(),
    reviewerMembershipId: v.optional(v.id('memberships')),
    submittedAt: v.optional(v.number()),
    decidedAt: v.optional(v.number()),
  })
    .index('by_application_requester', ['applicationId', 'requesterMembershipId'])
    .index('by_application_state', ['applicationId', 'state'])
    .index('by_requester_operation', ['requesterMembershipId', 'operationId']),

  reviewTasks: defineTable({
    requestId: v.id('requests'),
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    requesterMembershipId: v.id('memberships'),
    reviewerMembershipId: v.id('memberships'),
    definitionVersionId: v.id('applicationDefinitionVersions'),
    version: v.number(),
    status: reviewTaskStatusValidator,
    outcome: v.optional(requestStateValidator),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index('by_request', ['requestId'])
    .index('by_reviewer_status', ['reviewerMembershipId', 'status']),

  requestEvents: defineTable({
    requestId: v.id('requests'),
    applicationId: v.id('applications'),
    organizationId: v.id('organizations'),
    actorMembershipId: v.id('memberships'),
    command: reviewCommandValidator,
    fromState: requestStateValidator,
    toState: requestStateValidator,
    revision: v.number(),
    definitionVersionId: v.id('applicationDefinitionVersions'),
    operationId: v.string(),
    operationFingerprint: v.string(),
    at: v.number(),
  })
    .index('by_request', ['requestId'])
    .index('by_actor_operation', ['actorMembershipId', 'operationId']),

  requestCounts: defineTable({
    applicationId: v.id('applications'),
    count: v.number(),
  }).index('by_application', ['applicationId']),

  demoCollections: defineTable({
    ownerId: v.string(),
    name: v.string(),
    title: v.string(),
    fields: v.array(
      v.object({
        name: v.string(),
        type: v.union(v.literal('text'), v.literal('number'), v.literal('boolean')),
        required: v.optional(v.boolean()),
      }),
    ),
  })
    .index('by_owner', ['ownerId'])
    .index('by_owner_name', ['ownerId', 'name']),

  demoRecords: defineTable({
    ownerId: v.string(),
    collectionId: v.id('demoCollections'),
    values: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
    updatedAt: v.number(),
  })
    .index('by_owner', ['ownerId'])
    .index('by_collection', ['collectionId'])
    .index('by_owner_and_collection', ['ownerId', 'collectionId']),

  demoWorkflows: defineTable({
    ownerId: v.string(),
    collectionId: v.id('demoCollections'),
    name: v.string(),
    field: v.string(),
    value: v.union(v.string(), v.number(), v.boolean()),
  })
    .index('by_owner', ['ownerId'])
    .index('by_collection', ['collectionId'])
    .index('by_owner_and_collection', ['ownerId', 'collectionId']),

  demoWorkflowRuns: defineTable({
    ownerId: v.string(),
    workflowId: v.id('demoWorkflows'),
    status: v.literal('completed'),
    updatedCount: v.number(),
    completedAt: v.number(),
  })
    .index('by_owner', ['ownerId'])
    .index('by_workflow', ['workflowId']),

  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
  }).index('by_email', ['email']),

  sessions: defineTable({
    userId: v.string(),
    token: v.string(),
    expiresAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  }).index('by_token', ['token']),

  collections: defineTable({
    name: v.string(),
    title: v.optional(v.string()),
    options: v.optional(v.any()),
  }).index('by_name', ['name']),
});
