import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { capabilityValidator, membershipStatusValidator } from './membershipValidators';

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
