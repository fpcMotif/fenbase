#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import {
  assert,
  createDemoAuthClient,
  errorMessage,
  expectRejected,
  requiredUrl,
  signInAndCreateConvexClient,
} from './demo-verify';

type Locale = 'en-US' | 'zh-CN';
type Account = { name: string; email: string; password: string };
type Target = { appUrl: string; convexUrl: string; siteUrl: string };
type Journey = {
  locale: Locale;
  account: Account;
  title: string;
  internalName: string;
  renamedTitle: string;
  renamedName: string;
  blockingTitle: string;
  blockingName: string;
  target: Target;
};
type Report = (label: string) => void;
type ExpectedText = {
  welcome: string;
  email: string;
  password: string;
  signOut: string;
  collections: string;
  newCollection: string;
  displayName: string;
  internalName: string;
  fieldName: string;
  addField: string;
  create: string;
  save: string;
  cancel: string;
  delete: string;
  settings: string;
  text: string;
  number: string;
  boolean: string;
  required: string;
  nameInvalid: string;
  nameExists: string;
  renamed: string;
  addRecord: string;
  recordSaved: string;
  recordDeleted: string;
  deleteEmpty: string;
  removeConfirm: string;
  collectionDeleted: string;
};

const expectedText = {
  'en-US': {
    welcome: 'Welcome to Fenbase',
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    collections: 'Collections',
    newCollection: 'New collection',
    displayName: 'Display name',
    internalName: 'Internal name',
    fieldName: 'Field name',
    addField: 'Add field',
    create: 'Create',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    settings: 'Collection settings',
    text: 'Text',
    number: 'Number',
    boolean: 'Yes / no',
    required: 'Required',
    nameInvalid:
      'Start the internal name with a lowercase letter, then use lowercase letters, numbers, or underscores.',
    nameExists: 'A collection with this internal name already exists.',
    renamed: 'Collection renamed',
    addRecord: 'New record',
    recordSaved: 'Record saved',
    recordDeleted: 'Record deleted',
    deleteEmpty: 'Delete empty collection',
    removeConfirm: 'Delete this empty collection?',
    collectionDeleted: 'Collection deleted',
  },
  'zh-CN': {
    welcome: '欢迎使用 Fenbase',
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    collections: '数据集合',
    newCollection: '新建集合',
    displayName: '显示名称',
    internalName: '内部名称',
    fieldName: '字段名称',
    addField: '添加字段',
    // antd inserts a space inside two-character Chinese button labels by default.
    create: '创 建',
    save: '保 存',
    cancel: '取 消',
    delete: '删 除',
    settings: '集合设置',
    text: '文本',
    number: '数字',
    boolean: '是 / 否',
    required: '必填',
    nameInvalid: '内部名称必须以小写字母开头，且只能使用小写字母、数字或下划线。',
    nameExists: '已存在相同内部名称的集合。',
    renamed: '集合已重命名',
    addRecord: '新建记录',
    recordSaved: '记录已保存',
    recordDeleted: '记录已删除',
    deleteEmpty: '删除空集合',
    removeConfirm: '删除这个空集合？',
    collectionDeleted: '集合已删除',
  },
} satisfies Record<Locale, ExpectedText>;

const artifactsDir = join('dist', 'collection-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const popconfirmOk = 'OK';

function assertLocalTarget(...urls: string[]): void {
  for (const url of urls) {
    const { hostname } = new URL(url);
    assert(
      localHosts.has(hostname) || process.env.DEMO_JOURNEY_ALLOW_REMOTE === '1',
      `Refusing to create synthetic users on ${hostname}. Use a local development deployment, or set DEMO_JOURNEY_ALLOW_REMOTE=1.`,
    );
  }
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

const documentLanguage = (page: Page) => page.evaluate(() => document.documentElement.lang);
const activeText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim());

async function pressUntilFocused(
  page: Page,
  description: string,
  isFocused: () => Promise<boolean>,
  maxPresses = 12,
): Promise<number> {
  for (let presses = 1; presses <= maxPresses; presses += 1) {
    await page.keyboard.press('Tab');
    if (await isFocused()) return presses;
  }
  throw new Error(`Keyboard focus did not reach ${description} within ${maxPresses} Tab presses`);
}

async function waitForInputValue(input: Locator, expected: string): Promise<void> {
  await input.waitFor();
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if ((await input.inputValue()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Input did not contain "${expected}"; it contained "${await input.inputValue()}"`);
}

async function configureFieldRow(
  page: Page,
  dialog: Locator,
  text: ExpectedText,
  index: number,
  name: string,
  type: string,
  required: boolean,
): Promise<void> {
  await dialog.getByLabel(text.fieldName, { exact: true }).nth(index).fill(name);
  if (type !== text.text) {
    // The dropdown options render in a portal whose open animation can stall in dev mode, so choose by keyboard: antd Select commits the active option on
    // Enter without needing the dropdown to be visible. Opening activates the current selection, and each ArrowDown moves one position with wrap, so
    // open + one ArrowDown + Enter advances one option.
    const optionOrder = [text.text, text.number, text.boolean];
    for (let attempt = 0; attempt < optionOrder.length; attempt++) {
      const displayed = await dialog.locator('.ant-select-selection-item').nth(index).getAttribute('title');
      if (displayed === type) break;
      await dialog.locator('.ant-select').nth(index).click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }
    const selectedType = await dialog.locator('.ant-select-selection-item').nth(index).getAttribute('title');
    assert(selectedType === type, `Field ${name} was not set to type ${type} (found ${selectedType})`);
  }
  const requiredCheckbox = dialog.getByRole('checkbox', { name: text.required, exact: true }).nth(index);
  if (required && !(await requiredCheckbox.isChecked())) await requiredCheckbox.check();
  if (!required && (await requiredCheckbox.isChecked())) await requiredCheckbox.uncheck();
}

async function signInThroughUi(page: Page, text: ExpectedText, account: Account): Promise<void> {
  await page.getByLabel(text.email, { exact: true }).fill(account.email);
  await page.getByLabel(text.password, { exact: true }).fill(account.password);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: text.signOut }).waitFor();
}

async function confirmPopconfirm(page: Page, text: ExpectedText): Promise<void> {
  const popover = page.locator('.ant-popover:visible');
  await popover.getByText(text.removeConfirm).waitFor();
  await popover.getByRole('button', { name: popconfirmOk }).click();
}

// Delete Collection's onConfirm is async, so antd keeps the popconfirm open with a loading OK button until the mutation settles; wait for that before
// opening the next popconfirm so the locators cannot resolve against a still-animating confirmation.
async function waitForPopconfirmClosed(page: Page): Promise<void> {
  await page.locator('.ant-popover:not(.ant-popover-hidden)').first().waitFor({ state: 'hidden' });
}

async function verifyJourney(
  context: BrowserContext,
  backend: ConvexHttpClient,
  journey: Journey,
  report: Report,
): Promise<void> {
  const { locale, account, target } = journey;
  const text = expectedText[locale];
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      // The duplicate-name create is intentionally rejected by the backend to verify the translated error, and the Convex dev client logs every rejected
      // mutation as a console error. The nameExists toast assertion below proves the rejection had that exact reason, so any other server error on create
      // would still fail the journey there.
      if (/^\[CONVEX M\(collections:create\)\]/.test(message.text())) return;
      pageErrors.push(message.text());
    }
  });
  const capture = (name: string) =>
    page.screenshot({ path: join(artifactsDir, `${locale}-${name}.png`), fullPage: true });

  await page.goto(target.appUrl);
  await page.getByRole('heading', { name: text.welcome }).waitFor();
  await signInThroughUi(page, text, account);
  assert((await documentLanguage(page)) === locale, `Document language is not ${locale}`);
  await page.getByRole('heading', { name: text.collections }).waitFor();
  report(`${locale}: keyboard sign-in opened the collections workspace`);

  const presses = await pressUntilFocused(
    page,
    'the new collection button',
    async () => (await activeText(page)) === text.newCollection,
  );
  await page.keyboard.press('Enter');
  const createDialog = page.getByRole('dialog');
  await createDialog.getByText(text.displayName, { exact: true }).waitFor();
  report(`${locale}: the create dialog opens from the keyboard (focused after ${presses} Tab presses)`);

  await createDialog.getByLabel(text.displayName, { exact: true }).fill(journey.title);
  await createDialog.getByLabel(text.internalName, { exact: true }).fill(journey.internalName);
  await configureFieldRow(page, createDialog, text, 0, 'company', text.text, true);
  await createDialog.getByRole('button', { name: text.addField }).click();
  await configureFieldRow(page, createDialog, text, 1, 'amount', text.number, true);
  await createDialog.getByRole('button', { name: text.addField }).click();
  await configureFieldRow(page, createDialog, text, 2, 'qualified', text.boolean, false);
  await capture('1-create-dialog');

  await createDialog.getByRole('button', { name: text.create, exact: true }).click();
  await page.getByRole('button', { name: journey.title }).waitFor();
  await capture('2-collection-created');
  report(`${locale}: a collection with text, number, and boolean fields is created through the app`);

  const persisted = await backend.query(api.collections.list, {});
  const createdThroughApp = persisted.items.find((item) => item.title === journey.title);
  assert(createdThroughApp, 'Backend does not list the collection created through the app');
  assert(createdThroughApp.name === journey.internalName, 'Backend internal name differs from the app input');
  const reopenedFields = await backend.query(api.collections.get, { collectionId: createdThroughApp._id });
  assert(
    reopenedFields.fields.length === 3 &&
      reopenedFields.fields[0]?.name === 'company' &&
      reopenedFields.fields[0]?.type === 'text' &&
      reopenedFields.fields[0]?.required === true &&
      reopenedFields.fields[1]?.name === 'amount' &&
      reopenedFields.fields[1]?.type === 'number' &&
      reopenedFields.fields[1]?.required === true &&
      reopenedFields.fields[2]?.name === 'qualified' &&
      reopenedFields.fields[2]?.type === 'boolean' &&
      reopenedFields.fields[2]?.required === false,
    'Backend field configuration differs from the fields configured through the app',
  );
  report(`${locale}: persisted backend state matches the collection configured through the app`);

  await page.getByRole('button', { name: text.newCollection }).click();
  await createDialog.getByText(text.displayName, { exact: true }).waitFor();
  await createDialog.getByLabel(text.displayName, { exact: true }).fill(journey.renamedTitle);
  const invalidNameInput = createDialog.getByLabel(text.internalName, { exact: true });
  await invalidNameInput.fill('Bad-Name');
  await createDialog.getByRole('button', { name: text.create, exact: true }).click();
  await createDialog.getByText(text.nameInvalid).waitFor();
  assert((await invalidNameInput.inputValue()) === 'Bad-Name', 'Validation failure lost the typed internal name');
  await capture('3-invalid-name');

  await invalidNameInput.fill(journey.internalName);
  await createDialog.getByRole('button', { name: text.create, exact: true }).click();
  await page.getByText(text.nameExists, { exact: true }).first().waitFor();
  assert(
    (await createDialog.getByLabel(text.displayName, { exact: true }).inputValue()) === journey.renamedTitle,
    'Rejected creation lost the typed display name',
  );
  await capture('4-conflicting-name');
  await createDialog.getByRole('button', { name: text.cancel, exact: true }).click();
  report(
    `${locale}: invalid and conflicting names show translated errors in the dialog without losing the typed input`,
  );

  await page.getByRole('button', { name: journey.title }).click();
  await page.getByRole('button', { name: text.settings }).click();
  const settingsDialog = page.getByRole('dialog');
  await waitForInputValue(settingsDialog.getByLabel(text.internalName, { exact: true }), journey.internalName);
  const settingsSummary = await settingsDialog.locator('ul').innerText();
  assert(settingsSummary.includes('company'), 'Reopened configuration is missing the company field');
  assert(settingsSummary.includes('amount'), 'Reopened configuration is missing the amount field');
  assert(settingsSummary.includes('qualified'), 'Reopened configuration is missing the qualified field');
  assert(
    (await settingsDialog.getByText(text.required, { exact: true }).count()) === 2,
    'Reopened configuration does not show the two required fields',
  );
  assert(settingsSummary.includes(text.text), 'Reopened configuration does not label the text field type');
  assert(settingsSummary.includes(text.number), 'Reopened configuration does not label the number field type');
  assert(settingsSummary.includes(text.boolean), 'Reopened configuration does not label the boolean field type');
  await capture('5-reopened-configuration');
  report(`${locale}: reopening the collection shows its persisted field definitions`);

  await settingsDialog.getByLabel(text.displayName, { exact: true }).fill(journey.renamedTitle);
  await settingsDialog.getByLabel(text.internalName, { exact: true }).fill(journey.renamedName);
  await settingsDialog.getByRole('button', { name: text.save, exact: true }).click();
  await page.getByText(text.renamed, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: journey.renamedTitle }).waitFor();
  await capture('6-renamed');
  report(`${locale}: the collection is renamed through the app`);

  await page.reload();
  await page.getByRole('button', { name: text.signOut }).waitFor();
  await page.getByRole('button', { name: journey.renamedTitle }).waitFor();
  await capture('7-after-reload');
  report(`${locale}: reload keeps the session and shows the renamed collection`);

  await page.getByRole('button', { name: journey.renamedTitle }).click();
  await page.getByRole('button', { name: text.settings }).click();
  await waitForInputValue(settingsDialog.getByLabel(text.internalName, { exact: true }), journey.renamedName);
  await settingsDialog.getByRole('button', { name: text.cancel, exact: true }).click();
  report(`${locale}: reopening after reload shows the persisted rename`);

  await page.getByRole('button', { name: text.newCollection }).click();
  await createDialog.getByText(text.displayName, { exact: true }).waitFor();
  await createDialog.getByLabel(text.displayName, { exact: true }).fill(journey.blockingTitle);
  await createDialog.getByLabel(text.internalName, { exact: true }).fill(journey.blockingName);
  await createDialog.getByRole('button', { name: text.create, exact: true }).click();
  await page.getByRole('button', { name: journey.blockingTitle }).waitFor();

  await page.getByRole('button', { name: text.addRecord }).click();
  await page.getByRole('dialog').getByLabel('title', { exact: true }).fill('Blocks deletion');
  await page.getByRole('dialog').getByRole('button', { name: text.save, exact: true }).click();
  await page.getByText(text.recordSaved, { exact: true }).first().waitFor();
  assert(
    (await page.getByRole('button', { name: text.deleteEmpty }).count()) === 0,
    'The app offers deletion for a collection that still has records',
  );
  await capture('8-nonempty-collection');
  report(`${locale}: a collection with records cannot be deleted from the app, so records are never discarded`);

  await page.getByRole('row').getByRole('button', { name: text.delete, exact: true }).first().click();
  await page.locator('.ant-popover:visible').getByRole('button', { name: popconfirmOk }).click();
  await page.getByText(text.recordDeleted, { exact: true }).first().waitFor();
  await waitForPopconfirmClosed(page);
  await page.getByRole('button', { name: text.deleteEmpty }).waitFor();
  await page.getByRole('button', { name: text.deleteEmpty }).click();
  await confirmPopconfirm(page, text);
  await page.getByText(text.collectionDeleted, { exact: true }).first().waitFor();
  await waitForPopconfirmClosed(page);
  await page.getByRole('button', { name: journey.renamedTitle }).waitFor();
  assert(
    (await page.getByRole('button', { name: journey.blockingTitle }).count()) === 0,
    'Deleted empty collection is still listed in the app',
  );
  await capture('9-blocking-collection-deleted');
  report(`${locale}: after its records are removed, the app deletes the now-empty collection`);

  await page.getByRole('button', { name: text.deleteEmpty }).click();
  await confirmPopconfirm(page, text);
  await page.getByText(text.collectionDeleted, { exact: true }).first().waitFor();
  assert(
    (await page.getByRole('button', { name: journey.renamedTitle }).count()) === 0,
    'Deleted renamed collection is still listed in the app',
  );
  await capture('10-empty-collection-deleted');
  report(`${locale}: the renamed empty collection disappears from the app after deletion`);

  assert(pageErrors.length === 0, `Browser reported errors: ${pageErrors.join(' | ')}`);
  report(`${locale}: no uncaught browser errors during the journey`);
  await page.close();
}

async function verifyPersistedState(backend: ConvexHttpClient, shortSuffix: string, report: Report): Promise<void> {
  const collectionId = await backend.mutation(api.collections.create, {
    name: `api_${shortSuffix}`,
    title: 'API verification collection',
    fields: [
      { name: 'company', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'qualified', type: 'boolean' },
    ],
  });
  const reopened = await backend.query(api.collections.get, { collectionId });
  assert(
    reopened.name === `api_${shortSuffix}` &&
      reopened.title === 'API verification collection' &&
      reopened.fields.length === 3 &&
      reopened.fields[0]?.name === 'company' &&
      reopened.fields[0]?.type === 'text' &&
      reopened.fields[0]?.required === true &&
      reopened.fields[1]?.name === 'amount' &&
      reopened.fields[1]?.type === 'number' &&
      reopened.fields[1]?.required === true &&
      reopened.fields[2]?.name === 'qualified' &&
      reopened.fields[2]?.type === 'boolean' &&
      reopened.fields[2]?.required === undefined,
    'Persisted field configuration differs from the fields created at the backend boundary',
  );
  report('Backend state matches the collection and fields created at the backend boundary');

  await backend.mutation(api.collections.update, {
    collectionId,
    name: `api_renamed_${shortSuffix}`,
    title: 'API verification renamed',
  });
  const renamed = await backend.query(api.collections.get, { collectionId });
  assert(
    renamed.name === `api_renamed_${shortSuffix}` &&
      renamed.title === 'API verification renamed' &&
      renamed.fields.length === 3,
    'Backend rename did not persist the new name and title',
  );
  report('Backend rename persists and keeps the field configuration');

  await backend.mutation(api.collections.remove, { collectionId });
  const afterDelete = await backend.query(api.collections.list, {});
  assert(
    !afterDelete.items.some((item) => item._id === collectionId),
    'Backend still lists the deleted empty collection',
  );
  await expectRejected(
    'Deleted collection is no longer readable at the backend',
    () => backend.query(api.collections.get, { collectionId }),
    'Collection not found',
  );
  report('Backend deletes the empty collection and refuses further reads of it');
}

async function cleanupAccount(backend: ConvexHttpClient): Promise<string[]> {
  const failures: string[] = [];
  const collections = await backend.query(api.collections.list, {});
  const workflows = await backend.query(api.workflows.list, {});
  for (const workflow of workflows.items) {
    await backend.mutation(api.workflows.remove, { workflowId: workflow._id }).catch((error: unknown) => {
      failures.push(`workflow ${workflow._id}: ${errorMessage(error)}`);
    });
  }
  for (const collection of collections.items) {
    const records = await backend.query(api.records.list, { collectionId: collection._id, limit: 100 });
    for (const record of records.items) {
      await backend.mutation(api.records.remove, { recordId: record._id }).catch((error: unknown) => {
        failures.push(`record ${record._id}: ${errorMessage(error)}`);
      });
    }
    await backend.mutation(api.collections.remove, { collectionId: collection._id }).catch((error: unknown) => {
      failures.push(`collection ${collection._id}: ${errorMessage(error)}`);
    });
  }
  return failures;
}

async function main(): Promise<void> {
  const target: Target = {
    siteUrl: requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL'),
    convexUrl: requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL'),
    appUrl: (process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, ''),
  };
  assertLocalTarget(target.siteUrl, target.convexUrl);
  await mkdir(artifactsDir, { recursive: true });

  const suffix = randomUUID();
  const shortSuffix = suffix.replaceAll('-', '').slice(0, 12);
  const account: Account = {
    name: `Collection Journey ${suffix.slice(0, 8)}`,
    email: `collection-journey-${suffix}@example.test`,
    password: `Journey-${randomUUID()}-Aa1!`,
  };
  const journeyBase = {
    account,
    title: `Journey collection ${suffix.slice(0, 8)}`,
    internalName: `journey_${shortSuffix}`,
    renamedTitle: `Renamed collection ${suffix.slice(0, 8)}`,
    renamedName: `renamed_${shortSuffix}`,
    blockingTitle: `Blocking collection ${suffix.slice(0, 8)}`,
    blockingName: `blocking_${shortSuffix}`,
    target,
  };
  let checks = 0;
  const report: Report = (label) => {
    checks += 1;
    console.log(`PASS ${label}`);
  };

  const setupAuth = createDemoAuthClient(target.siteUrl);
  const signUp = await setupAuth.signUp.email(account);
  assert(!signUp.error && signUp.data?.user?.email === account.email, 'Synthetic account signup failed');
  const backend = await signInAndCreateConvexClient(setupAuth, target.convexUrl, account.email, account.password);
  await verifyPersistedState(backend, shortSuffix, report);

  const browser = await chromium.launch({ channel: 'chrome' });
  let failure: unknown;
  const cleanupFailures: string[] = [];
  try {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const context = await browser.newContext({ locale });
      try {
        await verifyJourney(context, backend, { ...journeyBase, locale }, report);
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    cleanupFailures.push(...(await cleanupAccount(backend)));
    const signOut = await setupAuth.signOut();
    if (signOut.error) cleanupFailures.push('setup session sign-out failed');
  }
  await browser.close();

  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorMessage(failure));
  assert(cleanupFailures.length === 0, `Cleanup failed: ${cleanupFailures.join('; ')}`);
  console.log(
    `Collection journey passed ${checks} checks. Screenshots: ${artifactsDir}. Removed: all collections, records, and workflows created by the journey. ` +
      `Retained: one synthetic Better Auth user (${fingerprint(account.email)}) on ${new URL(target.siteUrl).host}.`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Collection journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
