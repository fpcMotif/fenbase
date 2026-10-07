#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference, type FunctionReturnType } from 'convex/server';
import { chromium, type Locator, type Page } from 'playwright';
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

type Locale = 'en-US' | 'zh-CN';
type Values = Record<string, string | number | boolean>;
type RecordList = FunctionReturnType<typeof api.records.list>;
const artifactsDir = join('dist', 'record-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const fields = [
  { name: 'company', type: 'text', required: true },
  { name: 'amount', type: 'number', required: true },
  { name: 'qualified', type: 'boolean', required: true },
  { name: 'note', type: 'text' },
] as const;
const texts = {
  'en-US': {
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    add: 'New record',
    save: 'Save',
    edit: 'Edit',
    delete: 'Delete',
    cancel: 'Cancel',
    empty: 'No records in this collection yet.',
    saved: 'Record saved',
    deleted: 'Record deleted',
    required: 'This field is required',
    tooLong: 'Use at most 4000 characters for company.',
    confirm: 'Delete this record?',
    yes: 'Yes',
    no: 'No',
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    add: '新建记录',
    save: '保 存',
    edit: '编 辑',
    delete: '删 除',
    cancel: '取 消',
    empty: '此集合中还没有记录。',
    saved: '记录已保存',
    deleted: '记录已删除',
    required: '此项为必填项',
    tooLong: 'company 最多可输入 4000 个字符。',
    confirm: '删除这条记录？',
    yes: '是',
    no: '否',
  },
} satisfies Record<Locale, Record<string, string>>;

async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  for (let presses = 0; presses < 60; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard could not reach the requested control');
}

async function keyboardActivate(page: Page, target: Locator): Promise<void> {
  await keyboardFocus(page, target);
  await page.keyboard.press('Enter');
}

async function keyboardInput(page: Page, target: Locator, value: string): Promise<void> {
  await keyboardFocus(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}

function sameValues(actual: Values, expected: Values): boolean {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, value]) => actual[field] === value)
  );
}

async function main(): Promise<void> {
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Record verification requires an isolated local target');
  }
  await mkdir(artifactsDir, { recursive: true });
  const outcomes: string[] = [];
  const report = (label: string) => {
    outcomes.push(label);
    console.log(`PASS ${label}`);
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const account = {
    name: 'Record Journey',
    email: `record-journey-${suffix}@example.test`,
    password: `Journey-${randomUUID()}-Aa1!`,
  };
  const otherAccount = { ...account, email: `record-other-${suffix}@example.test` };
  const auth = createDemoAuthClient(siteUrl);
  const otherAuth = createDemoAuthClient(siteUrl);
  const collectionIds: Id<'demoCollections'>[] = [];
  const cleanupFailures: string[] = [];
  let backend: ConvexHttpClient | undefined;
  let other: ConvexHttpClient | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let failure: unknown;
  try {
    for (const [client, user] of [
      [auth, account],
      [otherAuth, otherAccount],
    ] as const) {
      const signup = await client.signUp.email(user);
      assert(!signup.error && signup.data?.user.email === user.email, 'Synthetic signup failed');
    }
    backend = await signInAndCreateConvexClient(auth, convexUrl, account.email, account.password);
    other = await signInAndCreateConvexClient(otherAuth, convexUrl, otherAccount.email, otherAccount.password);
    const owner = backend;
    const collectionId = await owner.mutation(api.collections.create, {
      name: `records_${suffix}`,
      title: 'Record verification',
      fields: [...fields],
    });
    collectionIds.push(collectionId);
    const secondId = await owner.mutation(api.collections.create, {
      name: `other_${suffix}`,
      title: 'Other collection',
      fields: [...fields],
    });
    collectionIds.push(secondId);
    const original = { company: 'API original', amount: 0, qualified: false, note: 'Optional note' };
    const recordId = await owner.mutation(api.records.create, { collectionId, values: original });
    const list = () => owner.query(api.records.list, { collectionId });
    const created = await list();
    assert(
      created.items.length === 1 && created.items[0]?._id === recordId && sameValues(created.items[0].values, original),
      'Create/read did not preserve every primitive value',
    );
    report('API creates and reads text, number zero, boolean false, and optional text');
    assert(
      (await owner.query(api.records.list, { collectionId: secondId })).items.length === 0,
      'Record leaked into another collection',
    );
    report('API keeps records associated with their collection');

    const invalid: Array<{ values: Values; code: string }> = [
      { values: {}, code: 'RECORD_FIELD_REQUIRED' },
      { values: { ...original, company: '  ' }, code: 'RECORD_FIELD_REQUIRED' },
      { values: { company: 'Missing number', qualified: false }, code: 'RECORD_FIELD_REQUIRED' },
      { values: { company: 'Missing boolean', amount: 0 }, code: 'RECORD_FIELD_REQUIRED' },
      { values: { ...original, company: 7 }, code: 'RECORD_FIELD_TYPE_INVALID' },
      { values: { ...original, amount: '7' }, code: 'RECORD_FIELD_TYPE_INVALID' },
      { values: { ...original, qualified: 'false' }, code: 'RECORD_FIELD_TYPE_INVALID' },
      { values: { ...original, amount: Number.NaN }, code: 'RECORD_FIELD_TYPE_INVALID' },
      { values: { ...original, company: 'x'.repeat(4001) }, code: 'RECORD_TEXT_TOO_LONG' },
      { values: { ...original, extra: 'outside schema' }, code: 'RECORD_FIELD_UNKNOWN' },
    ];
    for (const { values, code } of invalid) {
      await expectRejected(
        'Invalid create',
        () => owner.mutation(api.records.create, { collectionId, values }),
        undefined,
        code,
      );
      await expectRejected(
        'Invalid update',
        () => owner.mutation(api.records.update, { recordId, values }),
        undefined,
        code,
      );
      const after = await list();
      assert(
        JSON.stringify(after) === JSON.stringify(created),
        'Rejected mutation partially changed persisted records',
      );
      report(`API rejects create/update ${code} without partial writes`);
    }
    const rawCreate = makeFunctionReference<
      'mutation',
      { collectionId: Id<'demoCollections'>; values: Record<string, unknown> }
    >('records:create');
    const rawUpdate = makeFunctionReference<
      'mutation',
      { recordId: Id<'demoRecords'>; values: Record<string, unknown> }
    >('records:update');
    for (const value of [null, [], { nested: true }]) {
      await expectRejected('Malformed create value', () =>
        owner.mutation(rawCreate, { collectionId, values: { ...original, company: value } }),
      );
      await expectRejected('Malformed update value', () =>
        owner.mutation(rawUpdate, { recordId, values: { ...original, company: value } }),
      );
      assert(JSON.stringify(await list()) === JSON.stringify(created), 'Argument rejection changed records');
    }
    report('API argument validators reject null, array, and object values without partial writes');
    for (const [label, client] of [
      ['anonymous', new ConvexHttpClient(convexUrl)],
      ['non-owner', other],
    ] as const) {
      await expectRejected(`${label} list`, () => client.query(api.records.list, { collectionId }));
      await expectRejected(`${label} create`, () =>
        client.mutation(api.records.create, { collectionId, values: original }),
      );
      await expectRejected(`${label} update`, () =>
        client.mutation(api.records.update, { recordId, values: original }),
      );
      await expectRejected(`${label} delete`, () => client.mutation(api.records.remove, { recordId }));
      assert(JSON.stringify(await list()) === JSON.stringify(created), 'Unauthorized operation changed owner records');
      report(`API denies ${label} reads, creates, updates, and deletes using known identifiers`);
    }
    const edited = { company: 'API edited', amount: -12.5, qualified: true };
    await owner.mutation(api.records.update, { recordId, values: edited });
    assert(sameValues((await list()).items[0]!.values, edited), 'Update did not replace persisted values');
    report('API edit persists new values and removes omitted optional fields');
    await owner.mutation(api.records.remove, { recordId });
    assert((await list()).items.length === 0, 'Deleted record remains persisted');
    await expectRejected(
      'Deleted record update',
      () => owner.mutation(api.records.update, { recordId, values: original }),
      undefined,
      'RECORD_NOT_FOUND',
    );
    await expectRejected(
      'Deleted record delete',
      () => owner.mutation(api.records.remove, { recordId }),
      undefined,
      'RECORD_NOT_FOUND',
    );
    report('API deletion removes persisted records and rejects subsequent writes');

    browser = await chromium.launch({ channel: 'chrome' });
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const context = await browser.newContext({ locale });
      const page = await context.newPage();
      await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
      page.setDefaultTimeout(15_000);
      const text = texts[locale];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && !/^\[CONVEX M\(records:(create|update)\)\]/.test(message.text()))
          errors.push(`${message.text()} ${JSON.stringify(message.location())}`);
      });
      const capture = async (step: string) => {
        await page.locator('button.ant-btn-loading').first().waitFor({ state: 'hidden' });
        await page.screenshot({
          path: join(artifactsDir, `${locale}-${step}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      };
      try {
        await page.goto(appUrl);
        await keyboardInput(page, page.getByLabel(text.email, { exact: true }), account.email);
        await keyboardInput(page, page.getByLabel(text.password, { exact: true }), account.password);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: text.signOut }).waitFor();
        await keyboardActivate(page, page.getByRole('button', { name: 'Record verification', exact: true }));
        await page.getByText(text.empty, { exact: true }).waitFor();
        await capture('1-empty');
        report(`${locale}: keyboard sign-in and opening an owned empty collection`);
        const dialog = page.getByRole('dialog');
        await keyboardActivate(page, page.getByRole('button', { name: text.add, exact: true }));
        await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        await dialog.getByText(text.required, { exact: true }).first().waitFor();
        assert((await list()).items.length === 0, 'Required-field UI rejection created a record');
        await capture('2-required-error');
        report(`${locale}: missing required fields show translated errors without writes`);
        await keyboardInput(page, dialog.getByLabel('company', { exact: true }), 'x'.repeat(4001));
        await keyboardInput(page, dialog.getByLabel('amount', { exact: true }), '0');
        await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        await dialog.getByRole('alert').getByText(text.tooLong, { exact: true }).waitFor();
        assert(
          (await dialog.getByLabel('company', { exact: true }).inputValue()).length === 4001,
          'Rejected create lost input',
        );
        assert((await list()).items.length === 0, 'Rejected create wrote a record');
        await capture('3-backend-error');
        report(`${locale}: backend create rejection is translated, preserves input, and writes nothing`);
        const rejectedSaveAttempts = 20;
        let settledAfterRejectedSave = 0;
        for (let attempt = 1; attempt <= rejectedSaveAttempts; attempt += 1) {
          await keyboardInput(page, dialog.getByLabel('company', { exact: true }), 'x'.repeat(4001));
          const rejected = page.waitForEvent('console', (message) =>
            message.text().startsWith('[CONVEX M(records:create)]'),
          );
          await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
          await rejected;
          await dialog.locator('button.ant-btn-loading').waitFor({ state: 'hidden' });
          const settled = await dialog
            .getByRole('button', { name: text.save, exact: true })
            .waitFor({ timeout: 2_000 })
            .then(
              () => true,
              () => false,
            );
          if (!settled) break;
          settledAfterRejectedSave += 1;
        }
        assert(
          settledAfterRejectedSave === rejectedSaveAttempts && (await list()).items.length === 0,
          `Save button settled after ${settledAfterRejectedSave} of ${rejectedSaveAttempts} rejected saves`,
        );
        report(`${locale}: save-button-settles-after-rejected-saves (${rejectedSaveAttempts} rejected creates)`);
        await keyboardInput(page, dialog.getByLabel('company', { exact: true }), `${locale} keyboard lead`);
        await keyboardInput(page, dialog.getByLabel('note', { exact: true }), 'Optional detail');
        await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        await dialog.waitFor({ state: 'hidden' });
        await page.getByText(text.saved, { exact: true }).first().waitFor();
        const row = page.getByRole('row').filter({ hasText: `${locale} keyboard lead` });
        await row.waitFor();
        assert(
          (await row.innerText()).includes('0') &&
            (await row.innerText()).includes(text.no) &&
            (await row.innerText()).includes('Optional detail'),
          'Created row does not display every field',
        );
        const persisted = await list();
        assert(
          persisted.items.length === 1 &&
            sameValues(persisted.items[0]!.values, {
              company: `${locale} keyboard lead`,
              amount: 0,
              qualified: false,
              note: 'Optional detail',
            }),
          'UI create and backend state disagree',
        );
        await capture('4-created');
        report(`${locale}: keyboard create displays and persists every supported type including zero and false`);
        await keyboardActivate(page, row.getByRole('button', { name: text.edit, exact: true }));
        await dialog.getByLabel('company', { exact: true }).waitFor();
        await keyboardInput(page, dialog.getByLabel('company', { exact: true }), 'x'.repeat(4001));
        await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        await dialog.getByRole('alert').getByText(text.tooLong, { exact: true }).waitFor();
        assert(
          (await dialog.getByLabel('company', { exact: true }).inputValue()).length === 4001,
          'Rejected edit lost input',
        );
        assert(JSON.stringify(await list()) === JSON.stringify(persisted), 'Rejected UI edit changed persisted state');
        await capture('5-edit-error');
        report(`${locale}: backend edit rejection is translated and preserves input and persisted state`);
        await keyboardInput(page, dialog.getByLabel('company', { exact: true }), `${locale} edited lead`);
        await keyboardInput(page, dialog.getByLabel('amount', { exact: true }), '-12.5');
        await keyboardFocus(page, dialog.getByRole('switch', { name: 'qualified', exact: true }));
        await page.keyboard.press('Space');
        await keyboardInput(page, dialog.getByLabel('note', { exact: true }), '');
        await keyboardActivate(page, dialog.getByRole('button', { name: text.save, exact: true }));
        await dialog.waitFor({ state: 'hidden' });
        const editedRow = page.getByRole('row').filter({ hasText: `${locale} edited lead` });
        await editedRow.waitFor();
        assert(
          (await editedRow.innerText()).includes('-12.5') && (await editedRow.innerText()).includes(text.yes),
          'Edited values are not displayed',
        );
        assert(
          sameValues((await list()).items[0]!.values, {
            company: `${locale} edited lead`,
            amount: -12.5,
            qualified: true,
            note: '',
          }),
          'UI edit and backend state disagree',
        );
        await capture('6-edited');
        report(`${locale}: keyboard edit updates text, number, boolean, and optional text`);
        await page.reload();
        await page.getByRole('button', { name: text.signOut }).waitFor();
        await keyboardActivate(page, page.getByRole('button', { name: 'Other collection', exact: true }));
        await page.getByText(text.empty, { exact: true }).waitFor();
        await keyboardActivate(page, page.getByRole('button', { name: 'Record verification', exact: true }));
        await editedRow.waitFor();
        await keyboardActivate(page, editedRow.getByRole('button', { name: text.edit, exact: true }));
        const company = dialog.getByLabel('company', { exact: true });
        await company.waitFor();
        assert((await company.inputValue()) === `${locale} edited lead`, 'Reopened edit did not restore saved text');
        assert(
          (await dialog.getByLabel('amount', { exact: true }).inputValue()) === '-12.5',
          'Reopened number changed',
        );
        assert(
          (await dialog.getByRole('switch', { name: 'qualified', exact: true }).getAttribute('aria-checked')) ===
            'true',
          'Reopened boolean changed',
        );
        await capture('7-reloaded-reopened');
        report(`${locale}: reload and collection switching preserve the edited record and restore its form`);
        await keyboardActivate(page, dialog.getByRole('button', { name: text.cancel, exact: true }));
        await dialog.waitFor({ state: 'hidden' });
        await keyboardActivate(page, editedRow.getByRole('button', { name: text.delete, exact: true }));
        const confirmation = page.locator('.ant-popover:visible');
        await confirmation.getByText(text.confirm, { exact: true }).waitFor();
        await keyboardActivate(page, confirmation.getByRole('button', { name: text.cancel, exact: true }));
        await confirmation.waitFor({ state: 'hidden' });
        assert((await list()).items.length === 1, 'Canceling deletion removed a record');
        report(`${locale}: keyboard cancel leaves the record intact`);
        await keyboardActivate(page, editedRow.getByRole('button', { name: text.delete, exact: true }));
        await confirmation.getByText(text.confirm, { exact: true }).waitFor();
        await keyboardActivate(page, confirmation.getByRole('button', { name: text.delete, exact: true }));
        await page.getByText(text.deleted, { exact: true }).first().waitFor();
        await page.getByText(text.empty, { exact: true }).waitFor();
        assert((await list()).items.length === 0, 'UI deletion and persisted state disagree');
        await page.reload();
        await page.getByRole('button', { name: text.signOut }).waitFor();
        await keyboardActivate(page, page.getByRole('button', { name: 'Record verification', exact: true }));
        await page.getByText(text.empty, { exact: true }).waitFor();
        await capture('8-deleted-reloaded');
        report(`${locale}: keyboard deletion agrees with persisted state and remains deleted after reload`);
        assert(errors.length === 0, `Unexpected browser errors: ${errors.join(' | ')}`);
        report(`${locale}: no uncaught or unexpected browser errors`);
      } catch (error) {
        await capture('failure');
        throw error;
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await browser?.close();
    if (backend) {
      for (const collectionId of collectionIds) {
        try {
          const records: RecordList = await backend.query(api.records.list, { collectionId });
          assert(!records.hasMore, 'Cleanup exceeds the existing record limit');
          for (const record of records.items) await backend.mutation(api.records.remove, { recordId: record._id });
          await backend.mutation(api.collections.remove, { collectionId });
          await expectRejected(
            'Cleaned collection read',
            () => backend!.query(api.collections.get, { collectionId }),
            undefined,
            'COLLECTION_NOT_FOUND',
          );
        } catch (error) {
          cleanupFailures.push(errorMessage(error));
        }
      }
    }
    for (const client of [auth, otherAuth]) {
      const result = await client.signOut();
      if (result.error) cleanupFailures.push('Session sign-out failed');
    }
    await writeFile(
      join(artifactsDir, 'results.json'),
      JSON.stringify(
        {
          target: { convexUrl, siteUrl, appUrl },
          outcomes,
          cleanupFailures,
          retainedUsers: [account.email, otherAccount.email].map(
            (email) => `sha256:${createHash('sha256').update(email).digest('hex').slice(0, 8)}`,
          ),
          failure: failure === undefined ? null : errorMessage(failure),
        },
        null,
        2,
      ),
    );
  }
  if (failure !== undefined) throw failure;
  assert(cleanupFailures.length === 0, `Cleanup failed: ${cleanupFailures.join('; ')}`);
  console.log(
    `Record journey passed ${outcomes.length} checks. All synthetic records and collections removed. Two synthetic Better Auth users retained locally. Evidence: ${artifactsDir}.`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Record journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
