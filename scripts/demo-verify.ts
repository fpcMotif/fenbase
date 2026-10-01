#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { createAuthClient } from 'better-auth/client';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { crossDomainClient, convexClient } from '@convex-dev/better-auth/client/plugins';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

type AuthClient = ReturnType<typeof createDemoAuthClient>;

export function createDemoAuthClient(baseURL: string) {
  const values = new Map<string, string>();

  return createAuthClient({
    baseURL,
    plugins: [
      convexClient(),
      crossDomainClient({
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
        },
      }),
    ],
  });
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function requiredUrl(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value.replace(/\/+$/, '');
  }
  throw new Error(`Set one of these environment variables: ${names.join(', ')}`);
}

function passed(label: string): void {
  console.log(`PASS ${label}`);
}

export async function expectRejected(
  label: string,
  operation: () => Promise<unknown>,
  expectedMessage?: string,
  expectedCode?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = errorMessage(error);
    if (expectedMessage && !message.includes(expectedMessage)) {
      throw new Error(`${label} rejected for an unexpected reason: ${message}`);
    }
    if (expectedCode) {
      assert(
        error instanceof ConvexError &&
          typeof error.data === 'object' &&
          error.data !== null &&
          'code' in error.data &&
          error.data.code === expectedCode,
        `${label} did not return application error code ${expectedCode}`,
      );
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

export async function signInAndCreateConvexClient(
  authClient: AuthClient,
  convexUrl: string,
  email: string,
  password: string,
): Promise<ConvexHttpClient> {
  const signInResult = await authClient.signIn.email({ email, password });
  assert(!signInResult.error && signInResult.data?.user?.email === email, 'Email and password sign-in failed');

  const tokenResult = await authClient.convex.token();
  const token = tokenResult.data?.token;
  assert(
    !tokenResult.error && typeof token === 'string' && token.length > 0,
    'Better Auth did not issue a Convex token',
  );

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  return client;
}

async function attemptCleanup(failures: string[], label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(`${label}: ${errorMessage(error)}`);
  }
}

async function main(): Promise<void> {
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const suffix = randomUUID();
  const email = `demo-verify-${suffix}@example.test`;
  const secondEmail = `demo-verify-owner-${suffix}@example.test`;
  const password = `Demo-${randomUUID()}-Aa1!`;
  const authOne = createDemoAuthClient(siteUrl);
  const authTwo = createDemoAuthClient(siteUrl);
  const invalidAuth = createDemoAuthClient(siteUrl);
  let authOneSignedIn = false;
  let authTwoSignedIn = false;
  let ownerClient: ConvexHttpClient | undefined;
  let secondClient: ConvexHttpClient | undefined;
  let collectionId: Id<'demoCollections'> | undefined;
  let workflowId: Id<'demoWorkflows'> | undefined;
  const recordIds: Id<'demoRecords'>[] = [];
  let primaryFailure: unknown;
  const cleanupFailures: string[] = [];
  let checks = 0;

  const recordPass = (label: string): void => {
    checks += 1;
    passed(label);
  };

  try {
    const unauthenticated = new ConvexHttpClient(convexUrl);
    await expectRejected('Unauthenticated Convex collection access is rejected', () =>
      unauthenticated.query(api.collections.list, {}),
    );
    recordPass('Unauthenticated access denial checked');

    const signupOne = await authOne.signUp.email({ name: 'Demo Verification One', email, password });
    assert(!signupOne.error && signupOne.data?.user?.email === email, 'First synthetic user signup failed');
    authOneSignedIn = true;
    recordPass('First synthetic user can sign up');

    const invalidSignIn = await invalidAuth.signIn.email({ email, password: `${password}-wrong` });
    assert(invalidSignIn.error && invalidSignIn.data === null, 'Invalid password was not rejected');
    recordPass('Invalid password is rejected');

    ownerClient = await signInAndCreateConvexClient(authOne, convexUrl, email, password);
    authOneSignedIn = true;
    const viewer = await ownerClient.query(api.users.getViewer, {});
    assert(viewer?.email === email, 'Authenticated Convex viewer does not match the signed-in user');
    recordPass('First synthetic user can sign in and authenticate to Convex');

    const signupTwo = await authTwo.signUp.email({ name: 'Demo Verification Two', email: secondEmail, password });
    assert(!signupTwo.error && signupTwo.data?.user?.email === secondEmail, 'Second synthetic user signup failed');
    authTwoSignedIn = true;
    recordPass('Second synthetic user can sign up');

    secondClient = await signInAndCreateConvexClient(authTwo, convexUrl, secondEmail, password);
    authTwoSignedIn = true;
    const secondViewer = await secondClient.query(api.users.getViewer, {});
    assert(secondViewer?.email === secondEmail, 'Second authenticated Convex viewer does not match the signed-in user');
    recordPass('Second synthetic user can sign in and authenticate to Convex');

    const createdCollectionId = await ownerClient.mutation(api.collections.create, {
      name: `verify_${suffix.replaceAll('-', '_')}`,
      title: 'Demo verification collection',
      fields: [
        { name: 'company', type: 'text', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'qualified', type: 'boolean', required: true },
      ],
    });
    collectionId = createdCollectionId;
    const collections = await ownerClient.query(api.collections.list, {});
    assert(
      collections.items.some((item) => item._id === collectionId),
      'Created collection is missing from its owner list',
    );
    recordPass('Owned collection can be created and listed');

    const invalidCollectionCases = [
      { fields: [], code: 'COLLECTION_FIELD_COUNT_INVALID', message: 'between 1 and 30 fields' },
      {
        fields: [{ name: 'Bad name', type: 'text' as const }],
        code: 'COLLECTION_FIELD_NAME_INVALID',
        message: 'Invalid field name',
      },
      {
        fields: [
          { name: 'note', type: 'text' as const },
          { name: 'note', type: 'number' as const },
        ],
        code: 'COLLECTION_FIELD_NAME_DUPLICATE',
        message: 'Duplicate field name',
      },
    ];
    for (const invalid of invalidCollectionCases) {
      await expectRejected(
        'Invalid collection fields are rejected',
        () =>
          ownerClient.mutation(api.collections.create, {
            name: 'invalid_fields',
            title: 'Invalid',
            fields: invalid.fields,
          }),
        invalid.message,
        invalid.code,
      );
    }
    const createAtBoundary = makeFunctionReference<
      'mutation',
      { name: string; title: string; fields: Array<{ name: string; type: string; required?: boolean | string }> },
      Id<'demoCollections'>
    >('collections:create');
    for (const field of [
      { name: 'note', type: 'date' },
      { name: 'note', type: 'text', required: 'yes' },
    ]) {
      await expectRejected(
        'Unsupported field types and malformed required settings are rejected',
        () => ownerClient.mutation(createAtBoundary, { name: 'invalid_fields', title: 'Invalid', fields: [field] }),
        'ArgumentValidationError',
      );
    }
    const afterInvalidFields = await ownerClient.query(api.collections.list, {});
    assert(afterInvalidFields.items.length === collections.items.length, 'Invalid fields created a collection');
    recordPass('Field names, counts, types, and required settings are validated without creating collections');

    const savedFields = [
      { name: 'company', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'qualified', type: 'boolean', required: true },
    ];
    const reopened = await ownerClient.query(api.collections.get, { collectionId });
    assert(
      reopened?._id === collectionId &&
        reopened.name === `verify_${suffix.replaceAll('-', '_')}` &&
        reopened.title === 'Demo verification collection' &&
        reopened.fields.length === savedFields.length &&
        reopened.fields.every(
          (field, index) =>
            field.name === savedFields[index]?.name &&
            field.type === savedFields[index]?.type &&
            field.required === savedFields[index]?.required,
        ),
      'Reopened collection configuration does not match the persisted fields',
    );
    recordPass('Saved collection can be reopened with its persisted field configuration');

    const renamedName = `verify_renamed_${suffix.replaceAll('-', '_')}`;
    await ownerClient.mutation(api.collections.update, {
      collectionId,
      name: renamedName,
      title: 'Demo verification renamed',
    });
    const reopenedAfterRename = await ownerClient.query(api.collections.get, { collectionId });
    const listAfterRename = await ownerClient.query(api.collections.list, {});
    assert(
      reopenedAfterRename?.name === renamedName &&
        reopenedAfterRename.title === 'Demo verification renamed' &&
        reopenedAfterRename.fields.length === savedFields.length &&
        listAfterRename.items.some((item) => item._id === collectionId && item.name === renamedName),
      'Collection rename was not persisted',
    );
    recordPass('Collection rename is persisted and keeps its field configuration');

    await ownerClient.mutation(api.collections.update, {
      collectionId,
      name: renamedName,
      title: 'Demo verification renamed',
    });
    recordPass('Renaming a collection to its own name is allowed');

    await expectRejected(
      'Invalid collection name rename is rejected',
      () => ownerClient.mutation(api.collections.update, { collectionId, name: 'Bad-Name', title: 'Renamed' }),
      'Collection name must start with a lowercase letter',
      'COLLECTION_NAME_INVALID',
    );
    await expectRejected(
      'Blank collection title rename is rejected',
      () => ownerClient.mutation(api.collections.update, { collectionId, name: renamedName, title: '   ' }),
      'Collection title must contain between 1 and 120 characters',
      'COLLECTION_TITLE_INVALID',
    );
    recordPass('Collection rename validates names and titles at the backend boundary');

    const duplicateName = `verify_duplicate_${suffix.replaceAll('-', '_')}`;
    const duplicateCollectionId = await ownerClient.mutation(api.collections.create, {
      name: duplicateName,
      title: 'Duplicate target',
      fields: [{ name: 'note', type: 'text' }],
    });
    await expectRejected(
      'Duplicate-name collection rename is rejected',
      () => ownerClient.mutation(api.collections.update, { collectionId, name: duplicateName, title: 'Clash' }),
      'Collection name already exists',
      'COLLECTION_NAME_EXISTS',
    );
    recordPass('Collection rename rejects a name already used by the owner');

    await ownerClient.mutation(api.collections.remove, { collectionId: duplicateCollectionId });
    const listAfterDelete = await ownerClient.query(api.collections.list, {});
    assert(
      !listAfterDelete.items.some((item) => item._id === duplicateCollectionId),
      'Deleted empty collection remains in the owner list',
    );
    recordPass('Empty collection deletion removes it from persisted state');

    await expectRejected(
      'Unauthenticated collection reopen is rejected',
      () => unauthenticated.query(api.collections.get, { collectionId }),
      'Unauthenticated',
    );
    await expectRejected(
      'Unauthenticated collection rename is rejected',
      () =>
        unauthenticated.mutation(api.collections.update, { collectionId, name: 'anonymous_leads', title: 'Anonymous' }),
      'Unauthenticated',
    );
    await expectRejected(
      'Unauthenticated collection deletion is rejected',
      () => unauthenticated.mutation(api.collections.remove, { collectionId }),
      'Unauthenticated',
    );
    recordPass('Unauthenticated reopen, rename, and deletion are denied with a known collection id');

    const deletionName = `verify_deletion_${suffix.replaceAll('-', '_')}`;
    const deletionCollectionId = await ownerClient.mutation(api.collections.create, {
      name: deletionName,
      title: 'Deletion behavior',
      fields: [{ name: 'note', type: 'text' }],
    });
    const deletionRecordId = await ownerClient.mutation(api.records.create, {
      collectionId: deletionCollectionId,
      values: { note: 'Blocks deletion' },
    });
    await expectRejected(
      'Deleting a collection with records is rejected',
      () => ownerClient.mutation(api.collections.remove, { collectionId: deletionCollectionId }),
      'Remove all records before deleting this collection',
      'COLLECTION_HAS_RECORDS',
    );
    await ownerClient.mutation(api.records.remove, { recordId: deletionRecordId });
    const deletionWorkflow = await ownerClient.mutation(api.workflows.create, {
      collectionId: deletionCollectionId,
      name: 'Deletion blocker',
      field: 'note',
      value: 'blocks',
    });
    await expectRejected(
      'Deleting a collection with workflows is rejected',
      () => ownerClient.mutation(api.collections.remove, { collectionId: deletionCollectionId }),
      'Delete workflows before deleting this collection',
      'COLLECTION_HAS_WORKFLOWS',
    );
    await ownerClient.mutation(api.workflows.remove, { workflowId: deletionWorkflow.workflowId });
    await ownerClient.mutation(api.collections.remove, { collectionId: deletionCollectionId });
    recordPass('Nonempty collections are never silently deleted; blocking records and workflows are preserved');

    const initialRecords = await ownerClient.query(api.records.list, { collectionId, limit: 10 });
    assert(initialRecords.items.length === 0, 'New collection unexpectedly contains records');

    const firstRecordId = await ownerClient.mutation(api.records.create, {
      collectionId,
      values: { company: 'Aster Labs', amount: 1200, qualified: false },
    });
    recordIds.push(firstRecordId);
    const secondRecordId = await ownerClient.mutation(api.records.create, {
      collectionId,
      values: { company: 'Cedar Studio', amount: 3400, qualified: false },
    });
    recordIds.push(secondRecordId);
    recordPass('Owned records can be created');

    await ownerClient.mutation(api.records.update, {
      recordId: firstRecordId,
      values: { company: 'Aster Labs Revised', amount: 1250, qualified: false },
    });
    const recordsAfterUpdate = await ownerClient.query(api.records.list, { collectionId, limit: 10 });
    const updatedRecord = recordsAfterUpdate.items.find((item) => item._id === firstRecordId);
    assert(updatedRecord?.values.company === 'Aster Labs Revised', 'Record update was not persisted');
    recordPass('Owned records can be updated and listed');

    const workflowsBeforeRun = await ownerClient.query(api.workflows.list, {});
    const workflow = await ownerClient.mutation(api.workflows.create, {
      collectionId,
      name: 'Qualify owned demo records',
      field: 'qualified',
      value: true,
    });
    workflowId = workflow.workflowId;
    const workflowsAfterCreate = await ownerClient.query(api.workflows.list, {});
    assert(
      workflowsAfterCreate.items.length === workflowsBeforeRun.items.length + 1 &&
        workflowsAfterCreate.items.some((item) => item._id === workflowId),
      'Created workflow is missing from its owner list',
    );
    recordPass('Owned manual field-update workflow can be created and listed');

    const otherCollections = await secondClient.query(api.collections.list, {});
    const otherWorkflows = await secondClient.query(api.workflows.list, {});
    assert(
      !otherCollections.items.some((item) => item._id === collectionId),
      'Second user can list the first user’s collection',
    );
    assert(
      !otherWorkflows.items.some((item) => item._id === workflowId),
      'Second user can list the first user’s workflow',
    );
    recordPass('Collection and workflow lists are isolated by owner');

    await expectRejected(
      'Cross-user collection reopen is rejected',
      () => secondClient.query(api.collections.get, { collectionId }),
      'Collection not found',
      'COLLECTION_NOT_FOUND',
    );
    await expectRejected(
      'Cross-user collection rename is rejected',
      () =>
        secondClient.mutation(api.collections.update, {
          collectionId,
          name: 'stolen_collection',
          title: 'Stolen',
        }),
      'Collection not found',
      'COLLECTION_NOT_FOUND',
    );
    await expectRejected(
      'Cross-user collection deletion is rejected',
      () => secondClient.mutation(api.collections.remove, { collectionId }),
      'Collection not found',
      'COLLECTION_NOT_FOUND',
    );
    recordPass('Cross-user collection reopen, rename, and deletion are denied with a known collection id');

    await expectRejected(
      'Cross-user record update is rejected',
      () =>
        secondClient.mutation(api.records.update, {
          recordId: firstRecordId,
          values: { company: 'Unauthorized', amount: 1, qualified: false },
        }),
      'Record not found',
    );
    recordPass('Cross-user record access denied');

    await expectRejected(
      'Cross-user workflow run is rejected',
      () => secondClient.mutation(api.workflows.run, { workflowId }),
      'Workflow not found',
    );
    recordPass('Cross-user workflow access denied');

    const run = await ownerClient.mutation(api.workflows.run, { workflowId });
    assert(
      run.workflowId === workflowId && run.status === 'completed' && run.updatedCount === 2,
      'Manual workflow run returned an unexpected result',
    );
    const recordsAfterRun = await ownerClient.query(api.records.list, { collectionId, limit: 10 });
    assert(
      recordsAfterRun.items.length === 2 && recordsAfterRun.items.every((item) => item.values.qualified === true),
      'Manual workflow did not update both owned records',
    );
    const runHistory = await ownerClient.query(api.workflows.listRuns, { workflowId });
    assert(
      runHistory.length === 1 && runHistory[0]?.status === 'completed' && runHistory[0].updatedCount === 2,
      'Manual workflow run history is missing or incorrect',
    );
    recordPass('Manual workflow updates both records and writes run history');
  } catch (error) {
    primaryFailure = error;
  }

  if (ownerClient && workflowId) {
    await attemptCleanup(cleanupFailures, 'workflow', () =>
      ownerClient!.mutation(api.workflows.remove, { workflowId }),
    );
  }
  if (ownerClient) {
    for (const recordId of recordIds) {
      await attemptCleanup(cleanupFailures, 'record', () => ownerClient!.mutation(api.records.remove, { recordId }));
    }
  }
  if (ownerClient && collectionId) {
    await attemptCleanup(cleanupFailures, 'collection', () =>
      ownerClient!.mutation(api.collections.remove, { collectionId }),
    );
    await attemptCleanup(cleanupFailures, 'collection cleanup verification', async () => {
      const collections = await ownerClient!.query(api.collections.list, {});
      assert(!collections.items.some((item) => item._id === collectionId), 'Owned collection remains after cleanup');
    });
  }
  if (authOneSignedIn) {
    await attemptCleanup(cleanupFailures, 'first user session', async () => {
      const result = await authOne.signOut();
      assert(!result.error, 'First synthetic user sign-out failed');
    });
  }
  if (authTwoSignedIn) {
    await attemptCleanup(cleanupFailures, 'second user session', async () => {
      const result = await authTwo.signOut();
      assert(!result.error, 'Second synthetic user sign-out failed');
    });
  }

  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const messages = [
      primaryFailure === undefined ? undefined : errorMessage(primaryFailure),
      ...cleanupFailures.map((failure) => `Cleanup failed: ${failure}`),
    ].filter((message): message is string => Boolean(message));
    throw new Error(messages.join('\n'));
  }

  console.log(`Demo verification passed ${checks} checks; owned records, workflow, and collection were removed.`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Demo verification failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
