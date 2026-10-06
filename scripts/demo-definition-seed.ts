#!/usr/bin/env bun

import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Definition } from '../convex/definitionModel';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';
import { leaveDefinition } from './leave-definition';

export type DefinitionSeedApi = {
  getHead(applicationId: Id<'applications'>): Promise<{ revision: number; latestVersion: number } | null>;
  saveDraft(args: {
    applicationId: Id<'applications'>;
    expectedRevision: number;
    definition: Definition;
  }): Promise<{ revision: number }>;
  publish(args: {
    applicationId: Id<'applications'>;
    expectedRevision: number;
  }): Promise<{ versionId: Id<'applicationDefinitionVersions'>; version: number; revision: number }>;
};

export type DefinitionSeedResult = { status: 'created' | 'skipped'; revision: number; version: number };

export function convexDefinitionSeedApi(client: ConvexHttpClient): DefinitionSeedApi {
  return {
    getHead: async (applicationId) =>
      (await client.query(api.applicationDefinitions.getBuilderState, { applicationId })).head,
    saveDraft: (args) => client.mutation(api.applicationDefinitions.saveDraft, args),
    publish: (args) => client.mutation(api.applicationDefinitions.publish, args),
  };
}

// Never overwrites: any existing definition head, including one a builder edited, is left untouched. A racing seed
// loses with DEFINITION_REVISION_CONFLICT from saveDraft instead of replacing the winner's draft.
export async function seedLeaveDefinition(
  seedApi: DefinitionSeedApi,
  applicationId: Id<'applications'>,
  reviewerMembershipId: Id<'memberships'>,
): Promise<DefinitionSeedResult> {
  const head = await seedApi.getHead(applicationId);
  if (head) return { status: 'skipped', revision: head.revision, version: head.latestVersion };

  const saved = await seedApi.saveDraft({
    applicationId,
    expectedRevision: 0,
    definition: leaveDefinition(reviewerMembershipId),
  });
  const published = await seedApi.publish({ applicationId, expectedRevision: saved.revision });
  return { status: 'created', revision: published.revision, version: published.version };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert(value, `Set ${name}`);
  return value;
}

async function main(): Promise<void> {
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const auth = createDemoAuthClient(siteUrl);
  const client = await signInAndCreateConvexClient(
    auth,
    convexUrl,
    requiredEnv('DEFINITION_SEED_EMAIL'),
    requiredEnv('DEFINITION_SEED_PASSWORD'),
  );
  try {
    const result = await seedLeaveDefinition(
      convexDefinitionSeedApi(client),
      requiredEnv('DEFINITION_SEED_APPLICATION_ID') as Id<'applications'>,
      requiredEnv('DEFINITION_SEED_REVIEWER_MEMBERSHIP_ID') as Id<'memberships'>,
    );
    console.log(JSON.stringify(result));
  } finally {
    await auth.signOut();
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Definition seed failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
