import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeOrganization, upsertMember } from '../fixtures';
import { assignGrant, getMyAccess, listMembers, listMine, revokeGrant, setMemberStatus } from '../memberships';
import { createContext, invokeHandler, type TestContext, type TestDoc } from './helpers';

const auth = vi.hoisted(() => ({ currentUser: null as string | null }));

vi.mock('../auth', () => ({
  requireUser: async () => {
    if (auth.currentUser === null) throw new ConvexError('Unauthenticated');
    return auth.currentUser;
  },
}));

const ORG_1 = 'organizations:1';
const ORG_2 = 'organizations:2';
const APP_1 = 'applications:1';
const APP_2 = 'applications:2';

function membership(
  id: string,
  authUserId: string,
  grants: string[],
  options: { applicationId?: string; organizationId?: string; status?: 'active' | 'inactive' } = {},
): TestDoc {
  return {
    _id: `memberships:${id}`,
    _creationTime: 1,
    authUserId,
    applicationId: options.applicationId ?? APP_1,
    organizationId: options.organizationId ?? ORG_1,
    status: options.status ?? 'active',
    grants,
    updatedAt: 1,
  };
}

function fixtureContext(extraMemberships: TestDoc[] = []): TestContext {
  return createContext({
    organizations: [
      { _id: ORG_1, _creationTime: 1, key: 'fixture-org-1', name: 'Fixture Org One' },
      { _id: ORG_2, _creationTime: 1, key: 'fixture-org-2', name: 'Fixture Org Two' },
    ],
    applications: [
      { _id: APP_1, _creationTime: 1, organizationId: ORG_1, key: 'leaveRequests', name: 'Leave requests' },
      { _id: APP_2, _creationTime: 1, organizationId: ORG_2, key: 'leaveRequests', name: 'Leave requests' },
    ],
    memberships: [
      membership('a', 'user-a', ['submitRequests']),
      membership('b', 'user-b', ['submitRequests', 'reviewRequests']),
      membership('c', 'user-c', ['submitRequests']),
      membership('d', 'user-d', ['configureApplication']),
      membership('m', 'user-m', ['manageMembers']),
      membership('z', 'user-z', ['submitRequests', 'manageMembers'], { applicationId: APP_2, organizationId: ORG_2 }),
      ...extraMemberships,
    ],
  });
}

function signIn(authUserId: string | null): void {
  auth.currentUser = authUserId;
}

function errorCode(error: unknown): unknown {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  return typeof data === 'object' && data !== null && 'code' in data ? data.code : undefined;
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ConvexError);
  expect(errorCode(error)).toBe(code);
}

async function expectUnauthenticated(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toThrow('Unauthenticated');
}

function expectNoWrites(ctx: TestContext): void {
  expect(ctx.counts).toEqual({ inserts: 0, patches: 0, deletes: 0 });
}

beforeEach(() => signIn(null));

describe('application principal', () => {
  it('resolves the membership id, organization and grants from the caller’s own membership row', async () => {
    const ctx = fixtureContext();
    signIn('user-a');

    const access = await invokeHandler(getMyAccess, ctx, { applicationId: APP_1 });

    expect(access).toEqual({
      membershipId: 'memberships:a',
      status: 'active',
      grants: ['submitRequests'],
      organization: { key: 'fixture-org-1', name: 'Fixture Org One' },
      application: { key: 'leaveRequests', name: 'Leave requests' },
      capabilities: {
        configureApplication: false,
        readAllRecords: false,
        submitRequests: true,
        reviewRequests: false,
        manageMembers: false,
      },
    });
    expect(access).not.toHaveProperty('authUserId');
  });

  it('rejects an anonymous caller', async () => {
    await expectUnauthenticated(invokeHandler(getMyAccess, fixtureContext(), { applicationId: APP_1 }));
  });

  it.each([
    ['a nonmember', 'user-outsider', APP_1],
    ['a foreign-organization member', 'user-z', APP_1],
    ['a member asking for another organization’s application', 'user-a', APP_2],
    ['a member with a guessed application id', 'user-a', 'applications:999'],
  ])('denies %s with the shared application denial', async (_label, user, applicationId) => {
    signIn(user);
    await expectCode(invokeHandler(getMyAccess, fixtureContext(), { applicationId }), 'APPLICATION_ACCESS_DENIED');
  });

  it('denies an inactive member with the shared application denial', async () => {
    const ctx = fixtureContext([membership('x', 'user-x', ['manageMembers'], { status: 'inactive' })]);
    signIn('user-x');
    await expectCode(invokeHandler(getMyAccess, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
  });

  it('denies a membership whose application no longer exists', async () => {
    const ctx = fixtureContext([membership('x', 'user-x', ['submitRequests'], { applicationId: 'applications:9' })]);
    signIn('user-x');
    await expectCode(invokeHandler(getMyAccess, ctx, { applicationId: 'applications:9' }), 'APPLICATION_ACCESS_DENIED');
  });

  it('denies a membership whose stored organization differs from its application’s organization', async () => {
    const ctx = fixtureContext([membership('x', 'user-x', ['manageMembers'], { organizationId: ORG_2 })]);
    signIn('user-x');
    await expectCode(invokeHandler(getMyAccess, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
    await expectCode(invokeHandler(listMembers, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
    expect(await invokeHandler(listMine, ctx, {})).toEqual([]);
  });

  it('fails closed when one user has two rows for the same application', async () => {
    const ctx = fixtureContext([membership('a2', 'user-a', ['manageMembers'])]);
    signIn('user-a');
    await expect(invokeHandler(getMyAccess, ctx, { applicationId: APP_1 })).rejects.toThrow();
  });
});

describe('listMine', () => {
  it('lists only the caller’s active memberships with names, never other users’ rows', async () => {
    const ctx = fixtureContext([
      membership('a-inactive', 'user-a', ['submitRequests'], {
        applicationId: APP_2,
        organizationId: ORG_2,
        status: 'inactive',
      }),
    ]);
    signIn('user-a');

    expect(await invokeHandler(listMine, ctx, {})).toEqual([
      {
        membershipId: 'memberships:a',
        applicationId: APP_1,
        applicationName: 'Leave requests',
        organizationName: 'Fixture Org One',
        grants: ['submitRequests'],
      },
    ]);
  });

  it('returns nothing for a signed-in nonmember and rejects an anonymous caller', async () => {
    signIn('user-outsider');
    expect(await invokeHandler(listMine, fixtureContext(), {})).toEqual([]);
    signIn(null);
    await expectUnauthenticated(invokeHandler(listMine, fixtureContext(), {}));
  });
});

describe('listMembers', () => {
  it('lets a membership admin list exactly its own application’s members without identities', async () => {
    signIn('user-m');
    const members = await invokeHandler(listMembers, fixtureContext(), { applicationId: APP_1 });

    expect(members).toEqual([
      { membershipId: 'memberships:a', status: 'active', grants: ['submitRequests'], updatedAt: 1 },
      { membershipId: 'memberships:b', status: 'active', grants: ['submitRequests', 'reviewRequests'], updatedAt: 1 },
      { membershipId: 'memberships:c', status: 'active', grants: ['submitRequests'], updatedAt: 1 },
      { membershipId: 'memberships:d', status: 'active', grants: ['configureApplication'], updatedAt: 1 },
      { membershipId: 'memberships:m', status: 'active', grants: ['manageMembers'], updatedAt: 1 },
    ]);
  });

  it('shows the separate organization admin only its own organization', async () => {
    signIn('user-z');
    const members = await invokeHandler(listMembers, fixtureContext(), { applicationId: APP_2 });
    expect(members).toEqual([
      { membershipId: 'memberships:z', status: 'active', grants: ['submitRequests', 'manageMembers'], updatedAt: 1 },
    ]);
  });

  it.each(['user-a', 'user-b', 'user-c', 'user-d'])('denies %s without the manageMembers grant', async (user) => {
    signIn(user);
    await expectCode(invokeHandler(listMembers, fixtureContext(), { applicationId: APP_1 }), 'PERMISSION_DENIED');
  });

  it('denies a foreign admin and an anonymous caller', async () => {
    signIn('user-z');
    await expectCode(
      invokeHandler(listMembers, fixtureContext(), { applicationId: APP_1 }),
      'APPLICATION_ACCESS_DENIED',
    );
    signIn(null);
    await expectUnauthenticated(invokeHandler(listMembers, fixtureContext(), { applicationId: APP_1 }));
  });

  it('returns at most 101 rows', async () => {
    const extra = Array.from({ length: 120 }, (_, index) => membership(`extra-${index}`, `user-extra-${index}`, []));
    signIn('user-m');
    const members = await invokeHandler(listMembers, fixtureContext(extra), { applicationId: APP_1 });
    expect(members).toHaveLength(101);
  });
});

describe('setMemberStatus', () => {
  it('revokes access for an already signed-in member and only another admin can restore it', async () => {
    const ctx = fixtureContext();
    signIn('user-b');
    await invokeHandler(getMyAccess, ctx, { applicationId: APP_1 });

    signIn('user-m');
    await invokeHandler(setMemberStatus, ctx, {
      applicationId: APP_1,
      membershipId: 'memberships:b',
      status: 'inactive',
    });

    signIn('user-b');
    await expectCode(invokeHandler(getMyAccess, ctx, { applicationId: APP_1 }), 'APPLICATION_ACCESS_DENIED');
    expect(await invokeHandler(listMine, ctx, {})).toEqual([]);
    const writesBeforeSelfReactivation = { ...ctx.counts };
    await expectCode(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId: 'memberships:b', status: 'active' }),
      'APPLICATION_ACCESS_DENIED',
    );
    expect(ctx.counts).toEqual(writesBeforeSelfReactivation);
    expect(ctx.read('memberships', 'memberships:b')?.status).toBe('inactive');

    signIn('user-m');
    await invokeHandler(setMemberStatus, ctx, {
      applicationId: APP_1,
      membershipId: 'memberships:b',
      status: 'active',
    });

    signIn('user-b');
    const access = await invokeHandler(getMyAccess, ctx, { applicationId: APP_1 });
    expect(access).toMatchObject({ membershipId: 'memberships:b', capabilities: { reviewRequests: true } });
  });

  it.each([
    ['their own membership', 'memberships:a'],
    ['another member', 'memberships:c'],
  ])('denies an employee changing the status of %s without writing', async (_label, membershipId) => {
    const ctx = fixtureContext();
    signIn('user-a');
    await expectCode(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId, status: 'inactive' }),
      'PERMISSION_DENIED',
    );
    expectNoWrites(ctx);
  });

  it('denies an admin changing their own status without writing', async () => {
    const ctx = fixtureContext();
    signIn('user-m');
    await expectCode(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId: 'memberships:m', status: 'inactive' }),
      'SELF_ADMINISTRATION_DENIED',
    );
    expectNoWrites(ctx);
  });

  it.each([
    ['a known membership in another organization', 'memberships:z'],
    ['a guessed membership id', 'memberships:999'],
  ])('hides %s from the admin without writing', async (_label, membershipId) => {
    const ctx = fixtureContext();
    signIn('user-m');
    await expectCode(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId, status: 'inactive' }),
      'MEMBERSHIP_NOT_FOUND',
    );
    expectNoWrites(ctx);
    expect(ctx.read('memberships', 'memberships:z')?.status).toBe('active');
  });

  it('denies a foreign admin who names another organization’s application without writing', async () => {
    const ctx = fixtureContext();
    signIn('user-z');
    await expectCode(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId: 'memberships:a', status: 'inactive' }),
      'APPLICATION_ACCESS_DENIED',
    );
    expectNoWrites(ctx);
  });

  it('rejects an anonymous caller without writing', async () => {
    const ctx = fixtureContext();
    await expectUnauthenticated(
      invokeHandler(setMemberStatus, ctx, { applicationId: APP_1, membershipId: 'memberships:a', status: 'inactive' }),
    );
    expectNoWrites(ctx);
  });

  it('writes once when the same status is set twice', async () => {
    const ctx = fixtureContext();
    signIn('user-m');
    const args = { applicationId: APP_1, membershipId: 'memberships:c', status: 'inactive' };
    await invokeHandler(setMemberStatus, ctx, args);
    await invokeHandler(setMemberStatus, ctx, args);
    expect(ctx.counts.patches).toBe(1);
  });
});

describe('assignGrant and revokeGrant', () => {
  async function capabilitiesOf(ctx: TestContext, user: string): Promise<unknown> {
    signIn(user);
    const access = await invokeHandler(getMyAccess, ctx, { applicationId: APP_1 });
    return typeof access === 'object' && access !== null && 'capabilities' in access ? access.capabilities : undefined;
  }

  it('keeps builder configuration separate from record visibility until an admin grants it', async () => {
    const ctx = fixtureContext();
    expect(await capabilitiesOf(ctx, 'user-d')).toMatchObject({ configureApplication: true, readAllRecords: false });

    signIn('user-m');
    const grant = { applicationId: APP_1, membershipId: 'memberships:d', capability: 'readApplicationRecords' };
    await invokeHandler(assignGrant, ctx, grant);
    expect(await capabilitiesOf(ctx, 'user-d')).toMatchObject({ configureApplication: true, readAllRecords: true });

    signIn('user-m');
    await invokeHandler(revokeGrant, ctx, grant);
    expect(await capabilitiesOf(ctx, 'user-d')).toMatchObject({ configureApplication: true, readAllRecords: false });
  });

  it('removes a reviewer grant from an already signed-in member', async () => {
    const ctx = fixtureContext();
    expect(await capabilitiesOf(ctx, 'user-b')).toMatchObject({ reviewRequests: true });
    signIn('user-m');
    await invokeHandler(revokeGrant, ctx, {
      applicationId: APP_1,
      membershipId: 'memberships:b',
      capability: 'reviewRequests',
    });
    expect(await capabilitiesOf(ctx, 'user-b')).toMatchObject({ reviewRequests: false, submitRequests: true });
  });

  it.each([
    ['assignGrant', assignGrant],
    ['revokeGrant', revokeGrant],
  ])('%s denies an employee granting themselves without writing', async (_name, fn) => {
    const ctx = fixtureContext();
    signIn('user-a');
    await expectCode(
      invokeHandler(fn, ctx, { applicationId: APP_1, membershipId: 'memberships:a', capability: 'reviewRequests' }),
      'PERMISSION_DENIED',
    );
    expectNoWrites(ctx);
  });

  it.each([
    ['assignGrant', assignGrant],
    ['revokeGrant', revokeGrant],
  ])('%s denies an admin changing their own grants without writing', async (_name, fn) => {
    const ctx = fixtureContext();
    signIn('user-m');
    await expectCode(
      invokeHandler(fn, ctx, { applicationId: APP_1, membershipId: 'memberships:m', capability: 'reviewRequests' }),
      'SELF_ADMINISTRATION_DENIED',
    );
    expectNoWrites(ctx);
  });

  it.each(['memberships:z', 'memberships:999'])('hides %s from the org-1 admin without writing', async (id) => {
    const ctx = fixtureContext();
    signIn('user-m');
    await expectCode(
      invokeHandler(assignGrant, ctx, { applicationId: APP_1, membershipId: id, capability: 'reviewRequests' }),
      'MEMBERSHIP_NOT_FOUND',
    );
    expectNoWrites(ctx);
  });

  it('refuses to grant a capability to an inactive member without writing', async () => {
    const ctx = fixtureContext([membership('x', 'user-x', [], { status: 'inactive' })]);
    signIn('user-m');
    await expectCode(
      invokeHandler(assignGrant, ctx, {
        applicationId: APP_1,
        membershipId: 'memberships:x',
        capability: 'reviewRequests',
      }),
      'MEMBERSHIP_INACTIVE',
    );
    expectNoWrites(ctx);
  });

  it('writes only when the grant set changes', async () => {
    const ctx = fixtureContext();
    signIn('user-m');
    const args = { applicationId: APP_1, membershipId: 'memberships:c', capability: 'reviewRequests' };
    await invokeHandler(assignGrant, ctx, args);
    await invokeHandler(assignGrant, ctx, args);
    await invokeHandler(revokeGrant, ctx, args);
    await invokeHandler(revokeGrant, ctx, args);
    expect(ctx.counts.patches).toBe(2);
    expect(ctx.read('memberships', 'memberships:c')?.grants).toEqual(['submitRequests']);
  });

  it('rejects an anonymous caller without writing', async () => {
    const ctx = fixtureContext();
    await expectUnauthenticated(
      invokeHandler(assignGrant, ctx, {
        applicationId: APP_1,
        membershipId: 'memberships:a',
        capability: 'reviewRequests',
      }),
    );
    expectNoWrites(ctx);
  });
});

describe('membership fixtures', () => {
  const seedA = {
    organizationKey: 'fixture-org-1',
    organizationName: 'Fixture Org One',
    authUserId: 'user-a',
    capabilities: ['submitRequests'],
    status: 'active',
  };

  it('creates one organization, application and membership and reuses them on a repeat run', async () => {
    const ctx = createContext();

    const first = await invokeHandler(upsertMember, ctx, seedA);
    const second = await invokeHandler(upsertMember, ctx, seedA);
    const reviewer = await invokeHandler(upsertMember, ctx, {
      ...seedA,
      authUserId: 'user-b',
      capabilities: ['submitRequests', 'reviewRequests'],
    });

    expect(first).toMatchObject({ created: { organization: true, application: true, membership: true } });
    expect(second).toEqual({
      ...(first as object),
      created: { organization: false, application: false, membership: false },
    });
    expect(reviewer).toMatchObject({ created: { organization: false, application: false, membership: true } });
    expect(ctx.counts.inserts).toBe(4);

    signIn('user-a');
    expect(await invokeHandler(listMine, ctx, {})).toEqual([
      expect.objectContaining({ organizationName: 'Fixture Org One', applicationName: 'Leave requests' }),
    ]);
  });

  it('sets the grant list and status exactly on a repeat run', async () => {
    const ctx = createContext();
    const { membershipId } = (await invokeHandler(upsertMember, ctx, seedA)) as { membershipId: string };
    await invokeHandler(upsertMember, ctx, { ...seedA, capabilities: ['reviewRequests'], status: 'inactive' });
    expect(ctx.read('memberships', membershipId)).toMatchObject({ grants: ['reviewRequests'], status: 'inactive' });
  });

  it.each([
    ['an organization key without the fixture- prefix', { organizationKey: 'acme' }],
    ['duplicate capabilities', { capabilities: ['submitRequests', 'submitRequests'] }],
  ])('rejects %s without writing', async (_label, override) => {
    const ctx = createContext();
    await expect(invokeHandler(upsertMember, ctx, { ...seedA, ...override })).rejects.toThrow();
    expectNoWrites(ctx);
  });

  it('removes only the named fixture organization and reports the counts', async () => {
    const ctx = fixtureContext();

    const removed = await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-2' });

    expect(removed).toEqual({ organizations: 1, applications: 1, memberships: 1 });
    expect(ctx.read('organizations', ORG_2)).toBeNull();
    expect(ctx.read('memberships', 'memberships:z')).toBeNull();
    expect(ctx.read('organizations', ORG_1)).not.toBeNull();
    expect(ctx.read('memberships', 'memberships:a')).not.toBeNull();
    expect(await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-2' })).toEqual({
      organizations: 0,
      applications: 0,
      memberships: 0,
    });
  });

  it('removes every membership and application of a large fixture organization before the organization', async () => {
    const applications = Array.from({ length: 12 }, (_, index) => ({
      _id: `applications:big-${index}`,
      _creationTime: 1,
      organizationId: ORG_2,
      key: `app-${index}`,
      name: `App ${index}`,
    }));
    const members = Array.from({ length: 600 }, (_, index) =>
      membership(`big-${index}`, `user-big-${index}`, [], {
        applicationId: `applications:big-${index % 2}`,
        organizationId: ORG_2,
      }),
    );
    const ctx = createContext({
      organizations: [{ _id: ORG_2, _creationTime: 1, key: 'fixture-org-2', name: 'Fixture Org Two' }],
      applications,
      memberships: members,
    });

    const removed = await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-2' });

    expect(removed).toEqual({ organizations: 1, applications: 12, memberships: 600 });
    expect(ctx.counts.deletes).toBe(613);
  });

  it('rejects a non-fixture organization key on removal without writing', async () => {
    const ctx = fixtureContext();
    await expectCode(
      invokeHandler(removeOrganization, ctx, { organizationKey: 'acme' }),
      'FIXTURE_ORGANIZATION_KEY_INVALID',
    );
    expectNoWrites(ctx);
  });

  it('does not rewrite a membership when the same grants are seeded in another order', async () => {
    const ctx = createContext();
    await invokeHandler(upsertMember, ctx, { ...seedA, capabilities: ['submitRequests', 'reviewRequests'] });
    await invokeHandler(upsertMember, ctx, { ...seedA, capabilities: ['reviewRequests', 'submitRequests'] });
    expect(ctx.counts.patches).toBe(0);
  });
});
