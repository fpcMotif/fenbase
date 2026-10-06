import { describe, expect, it } from 'vitest';
import { countRemainingFixtureRows } from '../demo-membership-journey';

describe('countRemainingFixtureRows', () => {
  it('ignores non-fixture rows that share the target', () => {
    expect(
      countRemainingFixtureRows(
        {
          organizations: [{ _id: 'org-real', key: 'acme' }],
          applications: [{ _id: 'app-real', organizationId: 'org-real' }],
          memberships: [{ _id: 'm-real', organizationId: 'org-real', applicationId: 'app-real' }],
        },
        new Set(['org-fixture-deleted']),
      ),
    ).toEqual({ organizations: 0, applications: 0, memberships: 0 });
  });

  it('counts leftover rows under a seeded fixture organization or any fixture-keyed organization', () => {
    expect(
      countRemainingFixtureRows(
        {
          organizations: [
            { _id: 'org-real', key: 'acme' },
            { _id: 'org-stray', key: 'fixture-stray' },
          ],
          applications: [
            { _id: 'app-orphan', organizationId: 'org-seeded' },
            { _id: 'app-stray', organizationId: 'org-stray' },
            { _id: 'app-real', organizationId: 'org-real' },
          ],
          memberships: [
            { _id: 'm-orphan', organizationId: 'org-seeded', applicationId: 'app-orphan' },
            { _id: 'm-real', organizationId: 'org-real', applicationId: 'app-real' },
          ],
        },
        new Set(['org-seeded']),
      ),
    ).toEqual({ organizations: 1, applications: 2, memberships: 1 });
  });
});
