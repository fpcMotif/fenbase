#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { chromium, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import {
  assert,
  createDemoAuthClient,
  errorMessage,
  expectRejected,
  requiredUrl,
  signInAndCreateConvexClient,
} from './demo-verify';

type Owner = {
  account: { name: string; email: string; password: string };
  auth: ReturnType<typeof createDemoAuthClient>;
  client?: ConvexHttpClient;
  collectionIds: Id<'demoCollections'>[];
  recordId?: Id<'demoRecords'>;
  workflowId?: Id<'demoWorkflows'>;
  title: string;
  marker: string;
};

const artifactsDir = join('dist', 'isolation-journey');
const fields = [{ name: 'private_note', type: 'text' as const, required: true }];

async function snapshot(owner: Owner) {
  assert(owner.client, 'Owner is not authenticated');
  const collections = await owner.client.query(api.collections.list, {});
  const details = [];
  for (const collectionId of owner.collectionIds) {
    details.push({
      collection: await owner.client.query(api.collections.get, { collectionId }),
      records: await owner.client.query(api.records.list, { collectionId }),
    });
  }
  return {
    collections,
    details,
    record: owner.recordId ? await owner.client.query(api.records.get, { recordId: owner.recordId }) : null,
    workflows: await owner.client.query(api.workflows.list, {}),
    runs: owner.workflowId ? await owner.client.query(api.workflows.listRuns, { workflowId: owner.workflowId }) : [],
  };
}

async function signIn(page: Page, owner: Owner) {
  await page.getByLabel('Email', { exact: true }).fill(owner.account.email);
  await page.getByLabel('Password', { exact: true }).fill(owner.account.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.getByText(owner.account.name, { exact: true }).waitFor();
}

async function main() {
  const target = {
    convexUrl: requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL'),
    siteUrl: requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL'),
    appUrl: process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173',
  };
  for (const url of Object.values(target)) {
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
      'Isolation journey requires local targets',
    );
  }
  await mkdir(artifactsDir, { recursive: true });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const owners: Owner[] = ['Alpha', 'Beta'].map((name) => ({
    account: {
      name: `Isolation ${name}`,
      email: `isolation-${name.toLowerCase()}-${suffix}@example.test`,
      password: `Isolation-${randomUUID()}-Aa1!`,
    },
    auth: createDemoAuthClient(target.siteUrl),
    collectionIds: [],
    title: `${name} protected collection`,
    marker: `${name} private record ${suffix}`,
  }));
  const outcomes: string[] = [];
  const denials: Array<{ actor: string; owner: string; operation: string; unchanged: boolean }> = [];
  const cleanupFailures: string[] = [];
  const browserErrors: string[] = [];
  const authRequests: Array<{ phase: string; path: string; at: number }> = [];
  const snapshots: unknown[] = [];
  const cleanedOwners = new Set<Owner>();
  const report = (label: string) => {
    outcomes.push(label);
    console.log(`PASS ${label}`);
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let activePage: Page | undefined;
  let failure: unknown;
  try {
    for (const owner of owners) {
      const signup = await owner.auth.signUp.email(owner.account);
      assert(!signup.error && signup.data?.user.email === owner.account.email, 'Independent signup failed');
      owner.client = await signInAndCreateConvexClient(
        owner.auth,
        target.convexUrl,
        owner.account.email,
        owner.account.password,
      );
      assert(
        (await owner.client.query(api.users.getViewer, {})).email === owner.account.email,
        'Wrong authenticated viewer',
      );
      for (const [name, title] of [
        [`private_${suffix}`, owner.title],
        [`empty_${suffix}`, `${owner.title} empty`],
      ]) {
        owner.collectionIds.push(await owner.client.mutation(api.collections.create, { name, title, fields }));
      }
      owner.recordId = await owner.client.mutation(api.records.create, {
        collectionId: owner.collectionIds[0]!,
        values: { private_note: owner.marker },
      });
      owner.workflowId = (
        await owner.client.mutation(api.workflows.create, {
          collectionId: owner.collectionIds[0]!,
          name: `${owner.account.name} relationship`,
          field: 'private_note',
          value: owner.marker,
        })
      ).workflowId;
      await owner.client.mutation(api.workflows.run, { workflowId: owner.workflowId });
      const state = await snapshot(owner);
      assert(
        state.collections.items.length === 2 && state.details[0]!.records.items[0]?._id === owner.recordId,
        'Owned resources missing',
      );
      snapshots.push({ owner: owner.account.name, state });
      report(`${owner.account.name}: real signup, sign-in, owned collections, record, workflow, and run persist`);
    }
    assert(
      owners[0]!.recordId !== owners[1]!.recordId && owners[0]!.collectionIds[0] !== owners[1]!.collectionIds[0],
      'Accounts share resources',
    );
    const anonymous = new ConvexHttpClient(target.convexUrl);
    for (const owner of owners) {
      assert(owner.client && owner.recordId, 'Owner setup incomplete');
      const collectionId = owner.collectionIds[0]!;
      const recordId = owner.recordId;
      const before = JSON.stringify(await snapshot(owner));
      const other = owners.find((candidate) => candidate !== owner)!;
      assert(other.client, 'Other owner setup incomplete');
      const operations = (
        client: ConvexHttpClient,
      ): Array<{ name: string; code: string; call: () => Promise<unknown> }> => [
        {
          name: 'collection detail',
          code: 'COLLECTION_NOT_FOUND',
          call: () => client.query(api.collections.get, { collectionId }),
        },
        {
          name: 'record detail',
          code: 'RECORD_NOT_FOUND',
          call: () => client.query(api.records.get, { recordId }),
        },
        {
          name: 'record list',
          code: 'COLLECTION_NOT_FOUND',
          call: () => client.query(api.records.list, { collectionId }),
        },
        {
          name: 'record create',
          code: 'COLLECTION_NOT_FOUND',
          call: () => client.mutation(api.records.create, { collectionId, values: { private_note: 'Intruder' } }),
        },
        {
          name: 'record edit',
          code: 'RECORD_NOT_FOUND',
          call: () => client.mutation(api.records.update, { recordId, values: { private_note: 'Intruder' } }),
        },
        {
          name: 'record delete',
          code: 'RECORD_NOT_FOUND',
          call: () => client.mutation(api.records.remove, { recordId }),
        },
        {
          name: 'collection rename',
          code: 'COLLECTION_NOT_FOUND',
          call: () => client.mutation(api.collections.update, { collectionId, name: 'intruder', title: 'Intruder' }),
        },
        ...owner.collectionIds.map((id, index) => ({
          name: index === 0 ? 'populated collection delete' : 'empty collection delete',
          code: 'COLLECTION_NOT_FOUND',
          call: () => client.mutation(api.collections.remove, { collectionId: id }),
        })),
      ];
      for (const [actor, client] of [
        [other.account.name, other.client],
        ['anonymous', anonymous],
      ] as const) {
        if (actor !== 'anonymous') {
          const visible = await client.query(api.collections.list, {});
          assert(
            visible.items.length === 2 && visible.items.every((row) => other.collectionIds.includes(row._id)),
            'Collection list discovers another owner',
          );
          report(`${actor}: list exposes only owned collections`);
        }
        const calls = operations(client);
        if (actor === 'anonymous') {
          calls.push({ name: 'collection list', code: '', call: () => client.query(api.collections.list, {}) });
          calls.push({
            name: 'collection create',
            code: '',
            call: () => client.mutation(api.collections.create, { name: 'anonymous', title: 'Anonymous', fields }),
          });
        }
        for (const operation of calls) {
          await expectRejected(
            `${actor}: ${operation.name}`,
            operation.call,
            actor === 'anonymous' ? 'Unauthenticated' : undefined,
            actor === 'anonymous' ? undefined : operation.code,
          );
          assert(
            JSON.stringify(await snapshot(owner)) === before,
            `${operation.name} changed owner data or relationships`,
          );
          denials.push({ actor, owner: owner.account.name, operation: operation.name, unchanged: true });
          report(`${actor} denied ${owner.account.name} ${operation.name}; full owner state unchanged`);
        }
      }
    }
    for (const owner of owners) {
      assert(owner.client && owner.recordId, 'Owner setup incomplete');
      owner.marker += ' edited';
      await owner.client.mutation(api.records.update, {
        recordId: owner.recordId,
        values: { private_note: owner.marker },
      });
      assert(
        (await owner.client.query(api.records.list, { collectionId: owner.collectionIds[0]! })).items[0]?.values
          .private_note === owner.marker,
        'Owner record edit did not persist',
      );
      owner.title += ' renamed';
      await owner.client.mutation(api.collections.update, {
        collectionId: owner.collectionIds[0]!,
        name: `private_${suffix}`,
        title: owner.title,
      });
      assert(
        (await owner.client.query(api.collections.get, { collectionId: owner.collectionIds[0]! })).title ===
          owner.title,
        'Owner collection rename did not persist',
      );
      const emptyId = owner.collectionIds[1]!;
      const temporaryRecord = await owner.client.mutation(api.records.create, {
        collectionId: emptyId,
        values: { private_note: 'Owner temporary record' },
      });
      await owner.client.mutation(api.records.remove, { recordId: temporaryRecord });
      assert(
        (await owner.client.query(api.records.list, { collectionId: emptyId })).items.length === 0,
        'Owner record deletion did not persist',
      );
      await owner.client.mutation(api.collections.remove, { collectionId: emptyId });
      await expectRejected(
        'Owner deleted collection',
        () => owner.client!.query(api.collections.get, { collectionId: emptyId }),
        undefined,
        'COLLECTION_NOT_FOUND',
      );
      owner.collectionIds.pop();
      report(`${owner.account.name}: owner record edit/delete and collection rename/delete persist`);
    }
    browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/auth/'))
        authRequests.push({ phase: 'started', path: new URL(request.url()).pathname, at: Date.now() });
    });
    page.on('requestfinished', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/auth/'))
        authRequests.push({ phase: 'finished', path: new URL(request.url()).pathname, at: Date.now() });
    });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/auth/sign-out', async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ response });
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    const capture = async (name: string) => {
      await page.screenshot({ path: join(artifactsDir, `${name}.png`), fullPage: true, animations: 'disabled' });
    };
    const inspect = async (owner: Owner, other: Owner, step: string) => {
      await page.getByText(owner.account.name, { exact: true }).waitFor();
      await page.getByRole('button', { name: owner.title, exact: true }).click();
      await page.getByRole('cell', { name: owner.marker, exact: true }).waitFor();
      assert(
        (await page.getByRole('button', { name: other.title, exact: true }).count()) === 0,
        'Foreign collection visible',
      );
      assert(!(await page.locator('body').innerText()).includes(other.marker), 'Foreign record visible');
      await capture(`${step}-records`);
      await page.getByRole('button', { name: 'Collection settings', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Display name', { exact: true }).waitFor();
      assert(
        (await dialog.getByLabel('Display name', { exact: true }).inputValue()) === owner.title,
        'Foreign detail or cached form visible',
      );
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished),
        );
      });
      await capture(step);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      report(`${step}: only current owner list, record, and collection detail displayed`);
    };
    await page.goto(target.appUrl);
    const alpha = owners[0]!;
    const beta = owners[1]!;
    await signIn(page, alpha);
    await inspect(alpha, beta, '1-alpha');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).waitFor();
    assert(!(await page.locator('body').innerText()).includes(alpha.marker), 'Signed-out screen exposes prior data');
    await signIn(page, beta);
    await inspect(beta, alpha, '2-beta-same-session');
    await page.reload();
    await inspect(beta, alpha, '3-beta-reloaded');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).waitFor();
    await signIn(page, alpha);
    await inspect(alpha, beta, '4-alpha-returned');
    await page
      .getByRole('row')
      .filter({ hasText: alpha.marker })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await page.getByRole('dialog').getByLabel('private_note', { exact: true }).waitFor();
    const leaks = await page.evaluate(
      async ({ account, title, forbidden }) => {
        const samples: string[] = [];
        let changed = false;
        const observe = () => {
          const text = [
            document.body.innerText,
            ...Array.from(document.querySelectorAll('input, textarea'), (element) =>
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
            ),
          ].join('\n');
          if (text.includes(account.name)) changed = true;
          if (changed && forbidden.some((value) => text.includes(value))) samples.push(text.slice(0, 2000));
        };
        const observer = new MutationObserver(observe);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const modulePath = '/src/lib/auth/client.ts';
        const { authClient } = await import(modulePath);
        const result = await authClient.signIn.email({ email: account.email, password: account.password });
        if (result.error) throw new Error('Session replacement failed');
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => {
            observer.disconnect();
            reject(new Error('Session replacement did not settle'));
          }, 15_000);
          const checkSettled = () => {
            const text = document.body.innerText;
            if (!text.includes(account.name) || !text.includes(title)) return;
            requestAnimationFrame(() => {
              observe();
              clearTimeout(deadline);
              settled.disconnect();
              observer.disconnect();
              resolve();
            });
          };
          const settled = new MutationObserver(checkSettled);
          settled.observe(document.body, { subtree: true, childList: true, characterData: true });
          checkSettled();
        });
        return samples;
      },
      { account: beta.account, title: beta.title, forbidden: [alpha.title, alpha.marker] },
    );
    await capture('5-session-replaced');
    assert(leaks.length === 0, `Prior owner data exposed after session replacement: ${JSON.stringify(leaks)}`);
    assert((await page.getByRole('dialog').count()) === 0, 'Prior owner edit form survived account switch');
    await inspect(beta, alpha, '6-beta-session-replaced');
    report('Direct account replacement clears prior subscriptions, cached results, and open edit form');
    assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join(' | ')}`);
    report('No unexpected browser errors');
    await context.close();
  } catch (error) {
    failure = error;
    if (activePage) {
      await activePage.screenshot({ path: join(artifactsDir, 'failure.png'), fullPage: true });
      await writeFile(join(artifactsDir, 'failure-screen.txt'), await activePage.locator('body').innerText());
    }
  } finally {
    await browser?.close();
    for (const owner of owners) {
      try {
        if (owner.client) {
          if (owner.workflowId) await owner.client.mutation(api.workflows.remove, { workflowId: owner.workflowId });
          for (const collectionId of owner.collectionIds) {
            const records = await owner.client.query(api.records.list, { collectionId });
            assert(!records.hasMore, 'Cleanup exceeds record limit');
            for (const record of records.items)
              await owner.client.mutation(api.records.remove, { recordId: record._id });
            await owner.client.mutation(api.collections.remove, { collectionId });
            await expectRejected(
              'Removed collection detail',
              () => owner.client!.query(api.collections.get, { collectionId }),
              undefined,
              'COLLECTION_NOT_FOUND',
            );
          }
          assert((await owner.client.query(api.collections.list, {})).items.length === 0, 'Cleanup left collections');
          assert((await owner.client.query(api.workflows.list, {})).items.length === 0, 'Cleanup left workflows');
          cleanedOwners.add(owner);
        }
      } catch (error) {
        cleanupFailures.push(`${owner.account.name}: ${errorMessage(error)}`);
      }
      try {
        const result = await owner.auth.signOut();
        if (result.error) cleanupFailures.push(`${owner.account.name}: sign-out failed`);
      } catch (error) {
        cleanupFailures.push(`${owner.account.name}: ${errorMessage(error)}`);
      }
    }
    await writeFile(
      join(artifactsDir, 'results.json'),
      JSON.stringify(
        {
          revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          target,
          outcomes,
          denials,
          snapshots,
          browserErrors,
          authRequests,
          cleanupFailures,
          retainedUsers: owners.map((owner) => owner.account.email),
          retainedResources: owners
            .filter((owner) => !cleanedOwners.has(owner))
            .map((owner) => ({
              owner: owner.account.email,
              collectionIds: owner.collectionIds,
              recordId: owner.recordId,
              workflowId: owner.workflowId,
            })),
          failure: failure === undefined ? null : errorMessage(failure),
        },
        null,
        2,
      ),
    );
  }
  if (failure !== undefined) throw failure;
  assert(cleanupFailures.length === 0, `Cleanup failures: ${cleanupFailures.join('; ')}`);
  console.log(
    `Isolation journey passed ${outcomes.length} checks. Synthetic application resources removed; two local auth users retained. Evidence: ${artifactsDir}`,
  );
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
