#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Capability } from '../convex/membershipValidators';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';

type ActorKey = 'A' | 'B' | 'C' | 'D' | 'M' | 'Z';
type OrganizationKey = 'fixture-org-1' | 'fixture-org-2';

type Actor = {
  key: ActorKey;
  role: string;
  organizationKey: OrganizationKey;
  capabilities: Capability[];
  email: string;
  auth: ReturnType<typeof createDemoAuthClient>;
  client?: ConvexHttpClient;
  authUserId?: string;
  membershipId?: Id<'memberships'>;
  applicationId?: Id<'applications'>;
};

type Check = { id: string; expected: unknown; actual: unknown; pass: boolean };

type SeedResult = {
  organizationId: Id<'organizations'>;
  applicationId: Id<'applications'>;
  membershipId: Id<'memberships'>;
  created: { organization: boolean; application: boolean; membership: boolean };
};

const organizationNames: Record<OrganizationKey, string> = {
  'fixture-org-1': 'Fixture Org One',
  'fixture-org-2': 'Fixture Org Two',
};

const actorPlan: Array<Pick<Actor, 'key' | 'role' | 'organizationKey' | 'capabilities'>> = [
  { key: 'A', role: 'employee', organizationKey: 'fixture-org-1', capabilities: ['submitRequests'] },
  { key: 'B', role: 'reviewer', organizationKey: 'fixture-org-1', capabilities: ['submitRequests', 'reviewRequests'] },
  { key: 'C', role: 'unrelated employee', organizationKey: 'fixture-org-1', capabilities: ['submitRequests'] },
  { key: 'D', role: 'builder', organizationKey: 'fixture-org-1', capabilities: ['configureApplication'] },
  { key: 'M', role: 'membership admin', organizationKey: 'fixture-org-1', capabilities: ['manageMembers'] },
  {
    key: 'Z',
    role: 'separate organization',
    organizationKey: 'fixture-org-2',
    capabilities: ['submitRequests', 'manageMembers'],
  },
];

const looseMutation = (name: string) => makeFunctionReference<'mutation', Record<string, unknown>, unknown>(name);
const looseQuery = (name: string) => makeFunctionReference<'query', Record<string, unknown>, unknown>(name);

function readPrivate(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8').trim();
}

function convexCli(envFile: string, args: string[]): string {
  return execFileSync('node_modules/.bin/convex', [...args.slice(0, 1), '--env-file', envFile, ...args.slice(1)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function runInternal<T>(envFile: string, name: string, args: Record<string, unknown>): T {
  return JSON.parse(convexCli(envFile, ['run', name, JSON.stringify(args)])) as T;
}

function tableRows(envFile: string, table: string, component?: string): Array<Record<string, unknown>> {
  const output = convexCli(envFile, [
    'data',
    table,
    '--format',
    'jsonLines',
    '--limit',
    '10000',
    ...(component ? ['--component', component] : []),
  ]);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type FixtureTables = Record<'organizations' | 'applications' | 'memberships', Array<Record<string, unknown>>>;

export function countRemainingFixtureRows(
  tables: FixtureTables,
  seededOrganizationIds: ReadonlySet<unknown>,
): { organizations: number; applications: number; memberships: number } {
  const fixtureOrganizations = tables.organizations.filter(
    (row) => seededOrganizationIds.has(row._id) || (typeof row.key === 'string' && row.key.startsWith('fixture-')),
  );
  const organizationIds = new Set<unknown>([...seededOrganizationIds, ...fixtureOrganizations.map((row) => row._id)]);
  return {
    organizations: fixtureOrganizations.length,
    applications: tables.applications.filter((row) => organizationIds.has(row.organizationId)).length,
    memberships: tables.memberships.filter((row) => organizationIds.has(row.organizationId)).length,
  };
}

function outcomeOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === 'string') return data;
    if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') return data.code;
  }
  const message = errorMessage(error);
  if (message.includes('ArgumentValidationError')) return 'ArgumentValidationError';
  if (message.includes('Unauthenticated')) return 'Unauthenticated';
  return `unexpected: ${message.split('\n')[0]}`;
}

async function main(): Promise<void> {
  const dir = process.env.MEMBERSHIP_DIR?.trim();
  assert(dir, 'Set MEMBERSHIP_DIR to the isolated target directory');
  const envFile = join(dir, 'target.env');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  for (const url of [convexUrl, siteUrl]) {
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
      'Membership journey requires local targets',
    );
  }
  const runId = readPrivate(dir, 'run-id');
  const password = readPrivate(dir, 'password');

  const actors = actorPlan.map<Actor>((plan) => ({
    ...plan,
    email: `m14-${plan.key.toLowerCase()}-${runId}@example.test`,
    auth: createDemoAuthClient(siteUrl),
  }));
  const actor = (key: ActorKey): Actor => {
    const found = actors.find((candidate) => candidate.key === key);
    assert(found, `Unknown actor ${key}`);
    return found;
  };
  const client = (key: ActorKey): ConvexHttpClient => {
    const found = actor(key).client;
    assert(found, `Actor ${key} is not signed in`);
    return found;
  };
  const membershipOf = (key: ActorKey): Id<'memberships'> => {
    const found = actor(key).membershipId;
    assert(found, `Actor ${key} has no membership`);
    return found;
  };

  const labels = new Map<string, string>();
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') return labels.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, key === 'updatedAt' ? '<timestamp>' : normalize(entry)]),
      );
    }
    return value;
  };

  const checks: Check[] = [];
  const check = (id: string, expected: unknown, actual: unknown): void => {
    const normalizedExpected = normalize(expected);
    const normalizedActual = normalize(actual);
    const pass = JSON.stringify(normalizedExpected) === JSON.stringify(normalizedActual);
    checks.push({ id, expected: normalizedExpected, actual: normalizedActual, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`);
  };

  let applicationOne: Id<'applications'> | undefined;
  let applicationTwo: Id<'applications'> | undefined;
  const appOne = (): Id<'applications'> => {
    assert(applicationOne, 'Application one is not seeded');
    return applicationOne;
  };
  const appTwo = (): Id<'applications'> => {
    assert(applicationTwo, 'Application two is not seeded');
    return applicationTwo;
  };

  const snapshot = async () => ({
    org1: await client('M').query(api.memberships.listMembers, { applicationId: appOne() }),
    org2: await client('Z').query(api.memberships.listMembers, { applicationId: appTwo() }),
  });

  const deny = async (id: string, expected: string, operation: () => Promise<unknown>): Promise<void> => {
    const before = await snapshot();
    let actual = 'succeeded';
    try {
      await operation();
    } catch (error) {
      actual = outcomeOf(error);
    }
    const after = await snapshot();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    check(id, { outcome: expected, stateUnchanged: true }, { outcome: actual, stateUnchanged: unchanged });
  };

  const seed = (target: Actor): SeedResult => {
    assert(target.authUserId, `Actor ${target.key} has no auth user id`);
    return runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
      organizationKey: target.organizationKey,
      organizationName: organizationNames[target.organizationKey],
      authUserId: target.authUserId,
      capabilities: target.capabilities,
      status: 'active',
    });
  };

  const cleanup: Record<string, unknown> = {};
  const seededOrganizationIds = new Set<unknown>();
  let failure: unknown;
  const authUsersBefore = tableRows(envFile, 'user', 'betterAuth').length;

  try {
    // Step 1: real Better Auth identities; sign up only when this run's account does not exist yet.
    let signedUp = 0;
    for (const target of actors) {
      try {
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      } catch {
        const signup = await target.auth.signUp.email({ name: `M14 ${target.role}`, email: target.email, password });
        assert(!signup.error, `Sign-up failed for actor ${target.key}`);
        signedUp += 1;
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      }
      const viewer = await target.client.query(api.users.getViewer, {});
      assert(viewer.email === target.email, `Viewer mismatch for actor ${target.key}`);
      target.authUserId = viewer.id;
      labels.set(viewer.id, `<authUser:${target.key}>`);
    }
    check(
      'identity.real-better-auth-sign-in',
      actors.map((target) => ({ actor: target.key, signedIn: true })),
      actors.map((target) => ({ actor: target.key, signedIn: Boolean(target.client && target.authUserId) })),
    );
    const authUsersAfterSignIn = tableRows(envFile, 'user', 'betterAuth').length;
    check('identity.no-duplicate-auth-users', authUsersBefore + signedUp, authUsersAfterSignIn);

    // Step 2: idempotent fixture seed.
    const firstSeed = actors.map((target) => ({ target, result: seed(target) }));
    for (const { target, result } of firstSeed) {
      target.membershipId = result.membershipId;
      target.applicationId = result.applicationId;
      labels.set(result.membershipId, `<membership:${target.key}>`);
      labels.set(result.applicationId, `<application:${target.organizationKey}>`);
      labels.set(result.organizationId, `<organization:${target.organizationKey}>`);
    }
    applicationOne = actor('A').applicationId;
    applicationTwo = actor('Z').applicationId;
    const secondSeed = actors.map((target) => ({ actor: target.key, ...seed(target) }));
    check(
      'fixtures.repeat-seed-creates-nothing',
      firstSeed.map(({ target, result }) => ({
        actor: target.key,
        membershipId: result.membershipId,
        created: { organization: false, application: false, membership: false },
      })),
      secondSeed.map((result) => ({ actor: result.actor, membershipId: result.membershipId, created: result.created })),
    );
    const fixtureOrgIds = new Set<unknown>(firstSeed.map(({ result }) => result.organizationId));
    for (const organizationId of fixtureOrgIds) seededOrganizationIds.add(organizationId);
    const countFixtureRows = () => ({
      organizations: tableRows(envFile, 'organizations').filter((row) => fixtureOrgIds.has(row._id)).length,
      applications: tableRows(envFile, 'applications').filter((row) => fixtureOrgIds.has(row.organizationId)).length,
      memberships: tableRows(envFile, 'memberships').filter((row) => fixtureOrgIds.has(row.organizationId)).length,
    });
    check('fixtures.bounded-row-counts', { organizations: 2, applications: 2, memberships: 6 }, countFixtureRows());

    // Disposable organization: yields a well-formed membership and application id that no longer exist.
    const guess = runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
      organizationKey: `fixture-guess-${runId}`,
      organizationName: 'Fixture guessed ids',
      authUserId: `synthetic-guess-${runId}`,
      capabilities: [],
      status: 'active',
    });
    seededOrganizationIds.add(guess.organizationId);
    labels.set(guess.membershipId, '<membership:guessed>');
    labels.set(guess.applicationId, '<application:guessed>');
    cleanup.guessOrganization = runInternal(envFile, 'fixtures:removeOrganization', {
      organizationKey: `fixture-guess-${runId}`,
    });

    // Step 3: positive matrix.
    const capabilityFlags = (capabilities: Capability[]) => ({
      configureApplication: capabilities.includes('configureApplication'),
      readAllRecords: capabilities.includes('readApplicationRecords'),
      submitRequests: capabilities.includes('submitRequests'),
      reviewRequests: capabilities.includes('reviewRequests'),
      manageMembers: capabilities.includes('manageMembers'),
    });
    for (const target of actors) {
      const applicationId = target.organizationKey === 'fixture-org-1' ? appOne() : appTwo();
      check(
        `access.listMine.${target.key}`,
        [
          {
            membershipId: target.membershipId,
            applicationId,
            applicationName: 'Leave requests',
            organizationName: organizationNames[target.organizationKey],
            grants: target.capabilities,
          },
        ],
        await client(target.key).query(api.memberships.listMine, {}),
      );
      check(
        `access.getMyAccess.${target.key}`,
        {
          membershipId: target.membershipId,
          status: 'active',
          grants: target.capabilities,
          organization: { key: target.organizationKey, name: organizationNames[target.organizationKey] },
          application: { key: 'leaveRequests', name: 'Leave requests' },
          capabilities: capabilityFlags(target.capabilities),
        },
        await client(target.key).query(api.memberships.getMyAccess, { applicationId }),
      );
    }
    const orgOneMembers = await client('M').query(api.memberships.listMembers, { applicationId: appOne() });
    check(
      'admin.listMembers.org1-exactly-five',
      ['A', 'B', 'C', 'D', 'M'].map((key) => `<membership:${key}>`).sort(),
      orgOneMembers.map((member) => normalize(member.membershipId)).sort(),
    );
    check(
      'admin.listMembers.no-identity-fields',
      [],
      orgOneMembers.flatMap((member) =>
        Object.keys(member).filter((key) => ['authUserId', 'email', 'name'].includes(key)),
      ),
    );
    check(
      'admin.listMembers.org2-only-Z',
      ['<membership:Z>'],
      (await client('Z').query(api.memberships.listMembers, { applicationId: appTwo() })).map((member) =>
        normalize(member.membershipId),
      ),
    );

    // Step 4: denials, each with a before/after membership snapshot.
    const anonymous = new ConvexHttpClient(convexUrl);
    const targetArgs = { applicationId: appOne(), membershipId: membershipOf('A') };
    await deny('deny.anonymous.listMine', 'Unauthenticated', () => anonymous.query(api.memberships.listMine, {}));
    await deny('deny.anonymous.getMyAccess', 'Unauthenticated', () =>
      anonymous.query(api.memberships.getMyAccess, { applicationId: appOne() }),
    );
    await deny('deny.anonymous.listMembers', 'Unauthenticated', () =>
      anonymous.query(api.memberships.listMembers, { applicationId: appOne() }),
    );
    await deny('deny.anonymous.setMemberStatus', 'Unauthenticated', () =>
      anonymous.mutation(api.memberships.setMemberStatus, { ...targetArgs, status: 'inactive' }),
    );
    await deny('deny.anonymous.assignGrant', 'Unauthenticated', () =>
      anonymous.mutation(api.memberships.assignGrant, { ...targetArgs, capability: 'reviewRequests' }),
    );
    await deny('deny.anonymous.revokeGrant', 'Unauthenticated', () =>
      anonymous.mutation(api.memberships.revokeGrant, { ...targetArgs, capability: 'submitRequests' }),
    );

    await deny('deny.foreign-org.getMyAccess', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').query(api.memberships.getMyAccess, { applicationId: appOne() }),
    );
    await deny('deny.foreign-org.listMembers', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').query(api.memberships.listMembers, { applicationId: appOne() }),
    );
    await deny('deny.foreign-org.setMemberStatus', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').mutation(api.memberships.setMemberStatus, { ...targetArgs, status: 'inactive' }),
    );
    await deny('deny.foreign-org.assignGrant', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').mutation(api.memberships.assignGrant, { ...targetArgs, capability: 'reviewRequests' }),
    );
    await deny('deny.member-on-other-org-application', 'APPLICATION_ACCESS_DENIED', () =>
      client('A').query(api.memberships.getMyAccess, { applicationId: appTwo() }),
    );
    await deny('deny.guessed-application-id', 'APPLICATION_ACCESS_DENIED', () =>
      client('M').query(api.memberships.listMembers, { applicationId: guess.applicationId }),
    );

    await deny('deny.A.self-grant', 'PERMISSION_DENIED', () =>
      client('A').mutation(api.memberships.assignGrant, { ...targetArgs, capability: 'reviewRequests' }),
    );
    await deny('deny.A.self-status', 'PERMISSION_DENIED', () =>
      client('A').mutation(api.memberships.setMemberStatus, { ...targetArgs, status: 'active' }),
    );
    await deny('deny.A.change-C-status', 'PERMISSION_DENIED', () =>
      client('A').mutation(api.memberships.setMemberStatus, {
        applicationId: appOne(),
        membershipId: membershipOf('C'),
        status: 'inactive',
      }),
    );
    for (const key of ['B', 'C', 'D'] as const) {
      await deny(`deny.${key}.listMembers`, 'PERMISSION_DENIED', () =>
        client(key).query(api.memberships.listMembers, { applicationId: appOne() }),
      );
    }

    await deny('deny.M.self-status', 'SELF_ADMINISTRATION_DENIED', () =>
      client('M').mutation(api.memberships.setMemberStatus, {
        applicationId: appOne(),
        membershipId: membershipOf('M'),
        status: 'inactive',
      }),
    );
    await deny('deny.M.self-grant', 'SELF_ADMINISTRATION_DENIED', () =>
      client('M').mutation(api.memberships.assignGrant, {
        applicationId: appOne(),
        membershipId: membershipOf('M'),
        capability: 'configureApplication',
      }),
    );
    await deny('deny.M.known-foreign-membership', 'MEMBERSHIP_NOT_FOUND', () =>
      client('M').mutation(api.memberships.setMemberStatus, {
        applicationId: appOne(),
        membershipId: membershipOf('Z'),
        status: 'inactive',
      }),
    );
    await deny('deny.M.guessed-membership', 'MEMBERSHIP_NOT_FOUND', () =>
      client('M').mutation(api.memberships.assignGrant, {
        applicationId: appOne(),
        membershipId: guess.membershipId,
        capability: 'reviewRequests',
      }),
    );
    await deny('deny.M.malformed-membership-id', 'ArgumentValidationError', () =>
      client('M').mutation(looseMutation('memberships:setMemberStatus'), {
        applicationId: appOne(),
        membershipId: 'memberships:999',
        status: 'inactive',
      }),
    );
    await deny('deny.M.assign-manageMembers', 'ArgumentValidationError', () =>
      client('M').mutation(looseMutation('memberships:assignGrant'), {
        ...targetArgs,
        capability: 'manageMembers',
      }),
    );
    const spoofs: Array<[string, Record<string, unknown>]> = [
      ['role', { role: 'admin' }],
      ['organizationId', { organizationId: appTwo() }],
      ['authUserId', { authUserId: actor('M').authUserId }],
      ['actorId', { actorId: actor('M').authUserId }],
    ];
    for (const [name, extra] of spoofs) {
      await deny(`deny.spoof.${name}.getMyAccess`, 'ArgumentValidationError', () =>
        client('A').query(looseQuery('memberships:getMyAccess'), { applicationId: appOne(), ...extra }),
      );
      await deny(`deny.spoof.${name}.assignGrant`, 'ArgumentValidationError', () =>
        client('A').mutation(looseMutation('memberships:assignGrant'), {
          ...targetArgs,
          capability: 'reviewRequests',
          ...extra,
        }),
      );
    }
    await deny('deny.spoof.authUserId.listMine', 'ArgumentValidationError', () =>
      client('A').query(looseQuery('memberships:listMine'), { authUserId: actor('M').authUserId }),
    );
    await deny('deny.spoof.status.reactivate-via-getMyAccess', 'ArgumentValidationError', () =>
      client('A').query(looseQuery('memberships:getMyAccess'), { applicationId: appOne(), status: 'active' }),
    );

    // Step 5: builder permission is separate from record visibility.
    const builderFlags = async () => {
      const access = await client('D').query(api.memberships.getMyAccess, { applicationId: appOne() });
      return {
        configureApplication: access.capabilities.configureApplication,
        readAllRecords: access.capabilities.readAllRecords,
      };
    };
    const builderGrant = {
      applicationId: appOne(),
      membershipId: membershipOf('D'),
      capability: 'readApplicationRecords' as const,
    };
    check('builder.initial', { configureApplication: true, readAllRecords: false }, await builderFlags());
    await client('M').mutation(api.memberships.assignGrant, builderGrant);
    check('builder.after-record-grant', { configureApplication: true, readAllRecords: true }, await builderFlags());
    await client('M').mutation(api.memberships.revokeGrant, builderGrant);
    check('builder.after-record-revoke', { configureApplication: true, readAllRecords: false }, await builderFlags());

    // Step 6: revocation for an already signed-in reviewer, on the same client and token.
    const reviewer = client('B');
    const reviewerSelf = { applicationId: appOne(), membershipId: membershipOf('B') };
    check(
      'revocation.before.query',
      'allowed',
      (await reviewer.query(api.memberships.getMyAccess, { applicationId: appOne() })) ? 'allowed' : 'missing',
    );
    await deny('revocation.before.self-reactivate-mutation', 'PERMISSION_DENIED', () =>
      reviewer.mutation(api.memberships.setMemberStatus, { ...reviewerSelf, status: 'active' }),
    );
    await client('M').mutation(api.memberships.setMemberStatus, { ...reviewerSelf, status: 'inactive' });
    await deny('revocation.inactive.query', 'APPLICATION_ACCESS_DENIED', () =>
      reviewer.query(api.memberships.getMyAccess, { applicationId: appOne() }),
    );
    await deny('revocation.inactive.self-reactivate-mutation', 'APPLICATION_ACCESS_DENIED', () =>
      reviewer.mutation(api.memberships.setMemberStatus, { ...reviewerSelf, status: 'active' }),
    );
    check('revocation.inactive.listMine', [], await reviewer.query(api.memberships.listMine, {}));
    check('revocation.session-still-valid', actor('B').email, (await reviewer.query(api.users.getViewer, {})).email);
    await client('M').mutation(api.memberships.setMemberStatus, { ...reviewerSelf, status: 'active' });
    check(
      'revocation.reactivated-by-admin.query',
      { reviewRequests: true },
      {
        reviewRequests: (await reviewer.query(api.memberships.getMyAccess, { applicationId: appOne() })).capabilities
          .reviewRequests,
      },
    );
    await client('M').mutation(api.memberships.revokeGrant, { ...reviewerSelf, capability: 'reviewRequests' });
    check(
      'revocation.grant-revoked.query',
      { reviewRequests: false, submitRequests: true },
      await reviewer.query(api.memberships.getMyAccess, { applicationId: appOne() }).then(({ capabilities }) => ({
        reviewRequests: capabilities.reviewRequests,
        submitRequests: capabilities.submitRequests,
      })),
    );
    await client('M').mutation(api.memberships.assignGrant, { ...reviewerSelf, capability: 'reviewRequests' });
    const beforeRepeat = JSON.stringify(await snapshot());
    await client('M').mutation(api.memberships.assignGrant, { ...reviewerSelf, capability: 'reviewRequests' });
    await client('M').mutation(api.memberships.setMemberStatus, { ...reviewerSelf, status: 'active' });
    check('admin.repeat-assign-and-status-write-nothing', true, beforeRepeat === JSON.stringify(await snapshot()));
  } catch (error) {
    failure = error;
  }

  for (const organizationKey of ['fixture-org-1', 'fixture-org-2'] as const) {
    try {
      cleanup[organizationKey] = runInternal(envFile, 'fixtures:removeOrganization', { organizationKey });
    } catch (error) {
      cleanup[organizationKey] = `failed: ${errorMessage(error)}`;
    }
  }
  for (const target of actors) {
    if (!target.client) continue;
    const result = await target.auth.signOut();
    cleanup[`signOut.${target.key}`] = result.error ? 'failed' : 'ok';
  }
  const remainingFixtureRows = countRemainingFixtureRows(
    {
      organizations: tableRows(envFile, 'organizations'),
      applications: tableRows(envFile, 'applications'),
      memberships: tableRows(envFile, 'memberships'),
    },
    seededOrganizationIds,
  );
  check('cleanup.fixture-rows-removed', { organizations: 0, applications: 0, memberships: 0 }, remainingFixtureRows);
  const retained = {
    betterAuthUsers: tableRows(envFile, 'user', 'betterAuth').length,
    betterAuthSessions: tableRows(envFile, 'session', 'betterAuth').length,
  };

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    target: { convexUrl, siteUrl },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    error: failure === undefined ? null : errorMessage(failure),
    checks,
    cleanup,
    retained,
  };
  writeFileSync(join(dir, 'membership-14-results.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `Membership journey: ${report.summary.passed}/${report.summary.checks} checks passed; retained ${retained.betterAuthUsers} auth users and ${retained.betterAuthSessions} sessions.`,
  );
  if (failure !== undefined || failed.length > 0) {
    if (failure !== undefined) console.error(`Membership journey failed: ${errorMessage(failure)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Membership journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
