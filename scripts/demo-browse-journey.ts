#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
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
type BrowseArgs = FunctionArgs<typeof api.records.browse>;
// One seeded record as the journey models it; `order` is the creation order, which breaks sort ties (newest first).
type ModelRecord = { id: Id<'demoRecords'>; order: number; values: Values };

const artifactsDir = join('dist', 'browse-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const fields = [
  { name: 'company', type: 'text', required: true },
  { name: 'amount', type: 'number', required: true },
  { name: 'qualified', type: 'boolean', required: true },
  { name: 'note', type: 'text' },
] as const;
const seedCount = 25;
const texts = {
  'en-US': {
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    apply: 'Apply',
    reset: 'Reset',
    addFilter: 'Add filter',
    delete: 'Delete',
    confirm: 'Delete this record?',
    noMatches: 'No records match these filters.',
    invalidValue: 'Enter a valid filter value for company.',
    count: (count: number) => `${count} records`,
    matching: (count: number, total: number) => `${count} of ${total} records`,
    perPage: (size: number) => `${size} / page`,
    gte: 'at least',
    isFalsy: 'is no',
    includes: 'contains',
    eq: 'is',
    ascending: 'Ascending',
    descending: 'Descending',
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    apply: '应 用',
    reset: '重 置',
    addFilter: '添加筛选',
    delete: '删 除',
    confirm: '删除这条记录？',
    noMatches: '没有符合筛选条件的记录。',
    invalidValue: '请为 company 输入有效的筛选值。',
    count: (count: number) => `${count} 条记录`,
    matching: (count: number, total: number) => `${total} 条记录中有 ${count} 条符合`,
    perPage: (size: number) => `${size} 条/页`,
    gte: '大于等于',
    isFalsy: '为否',
    includes: '包含',
    eq: '等于',
    ascending: '升序',
    descending: '降序',
  },
} as const;

function seedValues(index: number): Values {
  const values: Values = {
    company: `Lead ${String(index).padStart(2, '0')}`,
    amount: (index % 5) * 100,
    qualified: index % 3 === 0,
  };
  if (index % 4 !== 0) values.note = `note ${index}`;
  return values;
}

// The expected order, written from the documented contract rather than from the implementation: a missing value is the
// largest, text ignores letter case, and ties are newest first.
function expectedIds(
  model: readonly ModelRecord[],
  keep: (values: Values) => boolean,
  sort?: { field: string; direction: 'asc' | 'desc' },
): Id<'demoRecords'>[] {
  const key = (record: ModelRecord) => {
    const value = sort ? record.values[sort.field] : undefined;
    return typeof value === 'string' ? value.toLowerCase() : value;
  };
  return model
    .filter((record) => keep(record.values))
    .sort((left, right) => {
      if (sort) {
        const [a, b] = [key(left), key(right)];
        if (a !== b) {
          const order = a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1;
          return sort.direction === 'asc' ? order : -order;
        }
      }
      return right.order - left.order;
    })
    .map((record) => record.id);
}

async function rowIds(page: Page): Promise<string[]> {
  return await page
    .locator('.ant-table-tbody tr[data-row-key]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key') ?? ''));
}

async function waitForRows(page: Page, expected: readonly string[], label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let actual: string[] = [];
  while (Date.now() < deadline) {
    actual = await rowIds(page);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${label}: visible rows ${JSON.stringify(actual)} differ from expected ${JSON.stringify(expected)}`);
}

async function chooseOption(page: Page, select: Locator, label: string): Promise<void> {
  // The selected value overlays the search input, so click through it.
  await select.click({ force: true });
  const option = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) });
  await option.first().click();
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
}

async function activePage(page: Page): Promise<string> {
  return await page.locator('.ant-pagination-item-active').innerText();
}

async function main(): Promise<void> {
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Browse verification requires an isolated local target');
  }
  await mkdir(artifactsDir, { recursive: true });
  const outcomes: string[] = [];
  const report = (label: string) => {
    outcomes.push(label);
    console.log(`PASS ${label}`);
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const account = {
    name: 'Browse Journey',
    email: `browse-journey-${suffix}@example.test`,
    password: `Journey-${randomUUID()}-Aa1!`,
  };
  const otherAccount = { ...account, email: `browse-other-${suffix}@example.test` };
  const auth = createDemoAuthClient(siteUrl);
  const otherAuth = createDemoAuthClient(siteUrl);
  const owned: Array<{ client: () => ConvexHttpClient | undefined; collectionId: Id<'demoCollections'> }> = [];
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
    const intruder = other;
    const collectionId = await owner.mutation(api.collections.create, {
      name: `browse_${suffix}`,
      title: 'Browse verification',
      fields: [...fields],
    });
    owned.push({ client: () => backend, collectionId });
    const otherCollectionId = await intruder.mutation(api.collections.create, {
      name: `browse_${suffix}`,
      title: 'Browse verification',
      fields: [...fields],
    });
    owned.push({ client: () => other, collectionId: otherCollectionId });
    for (let index = 1; index <= 3; index += 1) {
      await intruder.mutation(api.records.create, {
        collectionId: otherCollectionId,
        values: { ...seedValues(index), company: `Other lead ${index}` },
      });
    }

    let model: ModelRecord[] = [];
    let order = 0;
    const createModelRecord = async (values: Values) => {
      const id = await owner.mutation(api.records.create, { collectionId, values });
      order += 1;
      model.push({ id, order, values });
      return id;
    };
    for (let index = 1; index <= seedCount; index += 1) await createModelRecord(seedValues(index));
    const browse = (args: Omit<BrowseArgs, 'collectionId'> = {}) =>
      owner.query(api.records.browse, { collectionId, ...args });
    const traverse = async (args: Omit<BrowseArgs, 'collectionId' | 'page'>) => {
      const first = await browse({ ...args, page: 1 });
      const pages = [first];
      for (let page = 2; page <= first.pageCount; page += 1) pages.push(await browse({ ...args, page }));
      return { first, ids: pages.flatMap((page) => page.items.map((item) => item._id)) };
    };
    report(`seeded ${seedCount} owner records and 3 records owned by another user through real authentication`);

    const all = await traverse({ pageSize: 10 });
    assert(all.first.total === seedCount && all.first.pageCount === 3, 'Unexpected page count for the seeded fixture');
    assert(JSON.stringify(all.ids) === JSON.stringify(expectedIds(model, () => true)), 'Paged ids do not reconcile');
    report('API: three pages of 10 reconcile to exactly the 25 seeded ids, newest first, with no duplicates or gaps');

    const combined = {
      filters: [
        { field: 'amount', operator: '$gte', value: 200 },
        { field: 'qualified', operator: '$isFalsy' },
      ],
      sort: { field: 'amount', direction: 'asc' as const },
    };
    const keepCombined = (values: Values) => Number(values.amount) >= 200 && values.qualified !== true;
    const combinedRun = await traverse({ ...combined, pageSize: 4 });
    const expectedCombined = expectedIds(model, keepCombined, combined.sort);
    assert(expectedCombined.length === 10, 'Fixture no longer produces ten combined matches');
    assert(JSON.stringify(combinedRun.ids) === JSON.stringify(expectedCombined), 'Combined filter/sort order differs');
    assert(combinedRun.first.collectionTotal === seedCount, 'Collection total ignores the unfiltered count');
    report(
      'API: two filters plus an amount sort include and exclude correctly; tied amounts stay newest first across pages of 4',
    );

    const noteDescending = await traverse({ sort: { field: 'note', direction: 'desc' }, pageSize: 10 });
    assert(
      JSON.stringify(noteDescending.ids) ===
        JSON.stringify(expectedIds(model, () => true, { field: 'note', direction: 'desc' })),
      'Missing values or text order differ from the contract',
    );
    report('API: a descending text sort lists records without a note first and keeps the order stable');

    const text = await browse({
      filters: [{ field: 'company', operator: '$includes', value: 'LEAD 1' }],
      pageSize: 100,
    });
    assert(
      JSON.stringify(text.items.map((item) => item._id)) ===
        JSON.stringify(expectedIds(model, (values) => String(values.company).toLowerCase().includes('lead 1'))),
      'Case-insensitive contains filter differs',
    );
    const empty = await browse({ filters: [{ field: 'company', operator: '$eq', value: 'No such company' }], page: 3 });
    assert(empty.total === 0 && empty.items.length === 0 && empty.page === 1, 'Empty result is not one empty page');
    report('API: case-insensitive contains filter matches; an empty result is a single empty page');

    const rejected: Array<[string, Omit<BrowseArgs, 'collectionId'>, string]> = [
      ['unknown field', { filters: [{ field: 'owner', operator: '$eq', value: 'x' }] }, 'RECORD_QUERY_FIELD_UNKNOWN'],
      [
        'wrong operator',
        { filters: [{ field: 'company', operator: '$gt', value: 'a' }] },
        'RECORD_QUERY_OPERATOR_INVALID',
      ],
      [
        'wrong value type',
        { filters: [{ field: 'amount', operator: '$gt', value: '5' }] },
        'RECORD_QUERY_VALUE_INVALID',
      ],
      [
        'empty contains',
        { filters: [{ field: 'company', operator: '$includes', value: '' }] },
        'RECORD_QUERY_VALUE_INVALID',
      ],
      [
        'eleven filters',
        { filters: Array.from({ length: 11 }, () => ({ field: 'amount', operator: '$notEmpty' })) },
        'RECORD_QUERY_FILTER_COUNT_INVALID',
      ],
      ['bad direction', { sort: { field: 'amount', direction: 'up' } }, 'RECORD_QUERY_SORT_INVALID'],
      ['page zero', { page: 0 }, 'RECORD_QUERY_PAGE_INVALID'],
      ['page size 101', { pageSize: 101 }, 'RECORD_QUERY_PAGE_INVALID'],
    ];
    for (const [label, args, code] of rejected) {
      await expectRejected(`Malformed browse (${label})`, () => browse(args), undefined, code);
    }
    report(`API: rejects ${rejected.length} malformed or unsupported queries with coded, translatable errors`);

    const anonymous = new ConvexHttpClient(convexUrl);
    await expectRejected(
      'Anonymous browse',
      () => anonymous.query(api.records.browse, { collectionId }),
      'Unauthenticated',
    );
    await expectRejected(
      'Non-owner browse',
      () => intruder.query(api.records.browse, { collectionId, filters: combined.filters }),
      undefined,
      'COLLECTION_NOT_FOUND',
    );
    const intruderOwn = await intruder.query(api.records.browse, { collectionId: otherCollectionId, pageSize: 100 });
    const ownerIds = new Set(model.map((record) => record.id));
    assert(
      intruderOwn.total === 3 && intruderOwn.items.every((item) => !ownerIds.has(item._id)),
      'Another user saw the owner records',
    );
    report(
      'API: anonymous and non-owner browsing of the owner collection fail on the backend; the other user sees only their 3 records',
    );

    const before = await traverse({ pageSize: 10 });
    const added: Id<'demoRecords'>[] = [];
    for (let index = 0; index < 6; index += 1) added.push(await createModelRecord(seedValues(100 + index)));
    const grown = await browse({ pageSize: 10, page: 4 });
    assert(grown.pageCount === 4 && grown.items.length === 1, 'Creating records did not add a page');
    assert(grown.items[0]?._id === before.ids.at(-1), 'The oldest record did not move to the new last page');
    for (const id of added) await owner.mutation(api.records.remove, { recordId: id });
    model = model.filter((record) => !added.includes(record.id));
    const shrunk = await browse({ pageSize: 10, page: 4 });
    assert(shrunk.page === 3 && shrunk.pageCount === 3, 'A page past the end was not moved back to the last page');
    report(
      'API: creating records pushes the oldest onto a new last page; deleting them moves a stale page back to the last page',
    );

    const launchOptions = process.env.DEMO_CHROMIUM_PATH
      ? { executablePath: process.env.DEMO_CHROMIUM_PATH }
      : { channel: 'chrome' };
    browser = await chromium.launch(launchOptions);
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
      page.setDefaultTimeout(15_000);
      const text = texts[locale];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${message.text()} ${JSON.stringify(message.location())}`);
      });
      const capture = async (step: string) => {
        await page.screenshot({
          path: join(artifactsDir, `${locale}-${step}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      };
      const tag = () => page.locator('.ant-card-head .ant-tag');
      try {
        await page.goto(appUrl);
        await page.getByLabel(text.email, { exact: true }).fill(account.email);
        await page.getByLabel(text.password, { exact: true }).fill(account.password);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: text.signOut }).waitFor();
        await page.getByRole('button', { name: 'Browse verification', exact: true }).click();
        await tag().getByText(text.count(model.length), { exact: true }).waitFor();
        const query = page.locator('form[id="record-query"]');

        if (locale === 'en-US') {
          await waitForRows(page, expectedIds(model, () => true).slice(0, 20), 'Default first page');
          await chooseOption(page, page.locator('.ant-pagination-options .ant-select'), text.perPage(10));
          const unfiltered = expectedIds(model, () => true);
          const visited: string[] = [];
          for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            if (pageNumber > 1) await page.locator(`.ant-pagination-item-${pageNumber}`).click();
            const expected = unfiltered.slice((pageNumber - 1) * 10, pageNumber * 10);
            await waitForRows(page, expected, `Unfiltered page ${pageNumber}`);
            visited.push(...expected);
            await capture(`1-page-${pageNumber}`);
          }
          assert(new Set(visited).size === seedCount && visited.length === seedCount, 'UI traversal missed records');
          report(
            `${locale}: the app traverses 3 pages of 10 and the visible ids reconcile with all ${seedCount} seeded records`,
          );

          await query.getByRole('button', { name: text.addFilter }).click();
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 1 field' }), 'amount');
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 1 condition' }), text.gte);
          await page.getByLabel('Filter 1 value').fill('100');
          await query.getByRole('button', { name: text.addFilter }).click();
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 2 field' }), 'qualified');
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 2 condition' }), text.isFalsy);
          await chooseOption(page, query.getByRole('combobox', { name: 'Sort by' }), 'amount');
          await chooseOption(page, query.getByRole('combobox', { name: 'Order' }), text.descending);
          assert((await activePage(page)) === '3', 'Expected to start filtering from page 3');
          await query.getByRole('button', { name: text.apply }).click();
          const keepUi = (values: Values) => Number(values.amount) >= 100 && values.qualified !== true;
          const filtered = expectedIds(model, keepUi, { field: 'amount', direction: 'desc' });
          await waitForRows(page, filtered.slice(0, 10), 'Filtered first page');
          assert((await activePage(page)) === '1', 'Applying filters did not reset to page 1');
          await tag().getByText(text.matching(filtered.length, model.length), { exact: true }).waitFor();
          await capture('2-filtered-sorted');
          await page.locator('.ant-pagination-item-2').click();
          await waitForRows(page, filtered.slice(10, 20), 'Filtered second page');
          report(
            `${locale}: combined filters and a descending amount sort show ${filtered.length} matches over 2 pages with ties newest first`,
          );

          await chooseOption(page, query.getByRole('combobox', { name: 'Order' }), text.ascending);
          await query.getByRole('button', { name: text.apply }).click();
          const ascending = expectedIds(model, keepUi, { field: 'amount', direction: 'asc' });
          await waitForRows(page, ascending.slice(0, 10), 'Re-sorted first page');
          assert((await activePage(page)) === '1', 'Changing the sort did not reset to page 1');
          report(`${locale}: changing the sort from page 2 returns to page 1 in the new order`);

          await query.getByRole('button', { name: text.addFilter }).click();
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 3 field' }), 'company');
          await chooseOption(page, page.getByRole('combobox', { name: 'Filter 3 condition' }), text.includes);
          await query.getByRole('button', { name: text.apply }).click();
          await query.getByRole('alert').getByText(text.invalidValue, { exact: true }).waitFor();
          await waitForRows(page, ascending.slice(0, 10), 'Rows after a rejected filter');
          await capture('3-invalid-filter');
          report(`${locale}: an empty contains value shows a translated error and keeps the applied results`);

          await page.getByLabel('Filter 3 value').fill('no such company');
          await query.getByRole('button', { name: text.apply }).click();
          await page.getByText(text.noMatches, { exact: true }).waitFor();
          await tag().getByText(text.matching(0, model.length), { exact: true }).waitFor();
          await capture('4-no-matches');
          await query.getByRole('button', { name: text.reset }).click();
          await waitForRows(page, unfiltered.slice(0, 10), 'Rows after reset');
          await tag().getByText(text.count(model.length), { exact: true }).waitFor();
          report(`${locale}: a filter without matches shows the translated empty state; reset restores every record`);

          await page.locator('.ant-pagination-item-3').click();
          const lastPage = unfiltered.slice(20);
          await waitForRows(page, lastPage, 'Last page before deletion');
          for (const recordId of lastPage) {
            await page.locator(`tr[data-row-key="${recordId}"]`).getByRole('button', { name: text.delete }).click();
            const confirmation = page.locator('.ant-popover:visible');
            await confirmation.getByText(text.confirm, { exact: true }).waitFor();
            await confirmation.getByRole('button', { name: text.delete }).click();
            await page.locator(`tr[data-row-key="${recordId}"]`).waitFor({ state: 'detached' });
          }
          model = model.filter((record) => !lastPage.includes(record.id));
          const remaining = expectedIds(model, () => true);
          await waitForRows(page, remaining.slice(10, 20), 'Page after its records were deleted');
          assert((await activePage(page)) === '2', 'Deleting the last page did not move to the new last page');
          assert(
            JSON.stringify((await traverse({ pageSize: 10 })).ids) === JSON.stringify(remaining),
            'UI deletion and persisted records disagree',
          );
          await capture('5-after-deleting-last-page');
          report(
            `${locale}: deleting every record on the last page moves the view to the new last page; backend agrees`,
          );

          const boundaryId = await createModelRecord({ company: 'Boundary lead', amount: 50, qualified: true });
          await waitForRows(page, expectedIds(model, () => true).slice(10, 20), 'Page 2 after a new record');
          await page.locator('.ant-pagination-item-3').click();
          await waitForRows(page, expectedIds(model, () => true).slice(20), 'New last page after creation');
          assert(
            !(await rowIds(page)).includes(boundaryId) && (await rowIds(page)).length === 1,
            'Creation did not push exactly one record onto a new page',
          );
          await capture('6-after-creation');
          report(`${locale}: a new record pushes the oldest record onto a new third page in the live view`);
        } else {
          await page.getByText(text.perPage(20), { exact: true }).waitFor();
          await query.getByRole('button', { name: text.addFilter }).click();
          await chooseOption(page, page.getByRole('combobox', { name: '筛选 1 字段' }), 'company');
          await chooseOption(page, page.getByRole('combobox', { name: '筛选 1 条件' }), text.includes);
          await query.getByRole('button', { name: text.apply }).click();
          await query.getByRole('alert').getByText(text.invalidValue, { exact: true }).waitFor();
          await capture('1-invalid-filter');
          await chooseOption(page, page.getByRole('combobox', { name: '筛选 1 条件' }), text.eq);
          await page.getByLabel('筛选 1 值').fill('no such company');
          await query.getByRole('button', { name: text.apply }).click();
          await page.getByText(text.noMatches, { exact: true }).waitFor();
          await tag().getByText(text.matching(0, model.length), { exact: true }).waitFor();
          await capture('2-no-matches');
          await query.getByRole('button', { name: text.reset }).click();
          await waitForRows(page, expectedIds(model, () => true).slice(0, 20), 'Chinese reset first page');
          await capture('3-reset');
          report(`${locale}: pagination, filter errors, empty results, and record counts are translated`);
        }
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
    for (const { client, collectionId } of owned) {
      const owner = client();
      if (!owner) continue;
      try {
        for (;;) {
          const page = await owner.query(api.records.browse, { collectionId, pageSize: 100 });
          if (page.items.length === 0) break;
          for (const record of page.items) await owner.mutation(api.records.remove, { recordId: record._id });
        }
        await owner.mutation(api.collections.remove, { collectionId });
        await expectRejected(
          'Cleaned collection read',
          () => owner.query(api.collections.get, { collectionId }),
          undefined,
          'COLLECTION_NOT_FOUND',
        );
      } catch (error) {
        cleanupFailures.push(errorMessage(error));
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
    `Browse journey passed ${outcomes.length} checks. All synthetic records and collections removed. Two synthetic Better Auth users retained locally. Evidence: ${artifactsDir}.`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Browse journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
