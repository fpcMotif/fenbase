import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import { seedLeaveDefinition, type DefinitionSeedApi } from '../demo-definition-seed';
import { leaveDefinition } from '../leave-definition';

const APPLICATION = 'applications:1' as Id<'applications'>;
const REVIEWER = 'memberships:b' as Id<'memberships'>;
const VERSION = 'applicationDefinitionVersions:1' as Id<'applicationDefinitionVersions'>;

function stubApi(head: { revision: number; latestVersion: number } | null) {
  const calls: string[] = [];
  const seedApi: DefinitionSeedApi = {
    getHead: vi.fn(async () => {
      calls.push('getHead');
      return head;
    }),
    saveDraft: vi.fn(async (args) => {
      calls.push(`saveDraft:${args.expectedRevision}`);
      return { revision: 1 };
    }),
    publish: vi.fn(async (args) => {
      calls.push(`publish:${args.expectedRevision}`);
      return { versionId: VERSION, version: 1, revision: 2 };
    }),
  };
  return { seedApi, calls };
}

describe('seedLeaveDefinition', () => {
  it('creates and publishes the leave definition through the builder API when none exists', async () => {
    const { seedApi, calls } = stubApi(null);

    const result = await seedLeaveDefinition(seedApi, APPLICATION, REVIEWER);

    expect(result).toEqual({ status: 'created', revision: 2, version: 1 });
    expect(calls).toEqual(['getHead', 'saveDraft:0', 'publish:1']);
    expect(seedApi.saveDraft).toHaveBeenCalledWith({
      applicationId: APPLICATION,
      expectedRevision: 0,
      definition: leaveDefinition(REVIEWER),
    });
  });

  it('leaves an existing definition untouched, even one a builder has edited', async () => {
    const { seedApi, calls } = stubApi({ revision: 5, latestVersion: 1 });

    const result = await seedLeaveDefinition(seedApi, APPLICATION, REVIEWER);

    expect(result).toEqual({ status: 'skipped', revision: 5, version: 1 });
    expect(calls).toEqual(['getHead']);
  });
});
