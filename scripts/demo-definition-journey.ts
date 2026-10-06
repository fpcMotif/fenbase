#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Definition, DefinitionField } from '../convex/definitionModel';
import type { Capability } from '../convex/membershipValidators';
import { convexDefinitionSeedApi, seedLeaveDefinition } from './demo-definition-seed';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';
import { leaveDefinition } from './leave-definition';

type Locale = 'en-US' | 'zh-CN';
type ActorKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'Z';
type Row = Record<string, unknown>;
type Check = { id: string; expected: unknown; actual: unknown; pass: boolean };
type SeedResult = {
  organizationId: Id<'organizations'>;
  applicationId: Id<'applications'>;
  membershipId: Id<'memberships'>;
};
type Actor = {
  key: ActorKey;
  organization: 'one' | 'two';
  capabilities: Capability[];
  email: string;
  auth: ReturnType<typeof createDemoAuthClient>;
  client?: ConvexHttpClient;
  authUserId?: string;
  membershipId?: Id<'memberships'>;
  applicationId?: Id<'applications'>;
};

const artifactsDir = join('dist', 'definition-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const viewport = { width: 1280, height: 900 };

const actorPlan: Array<Pick<Actor, 'key' | 'organization' | 'capabilities'>> = [
  { key: 'A', organization: 'one', capabilities: ['submitRequests'] },
  { key: 'B', organization: 'one', capabilities: ['submitRequests', 'reviewRequests'] },
  { key: 'C', organization: 'one', capabilities: ['submitRequests', 'reviewRequests'] },
  { key: 'D', organization: 'one', capabilities: ['configureApplication'] },
  { key: 'E', organization: 'one', capabilities: ['configureApplication'] },
  { key: 'Z', organization: 'two', capabilities: ['configureApplication', 'reviewRequests'] },
];

const texts = {
  'en-US': {
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    builderTab: 'Application builder',
    field: (index: number) => `Field ${index}`,
    key: 'Key',
    type: 'Type',
    labelEnUS: 'Label (English)',
    labelZhCN: 'Label (Chinese)',
    required: 'Required',
    maxLength: 'Maximum length',
    min: 'Minimum',
    max: 'Maximum',
    integer: 'Whole numbers only',
    addField: 'Add field',
    remove: (index: number) => `Remove field ${index}`,
    listColumns: 'List columns',
    dateRuleStart: 'Date range start',
    dateRuleEnd: 'Date range end',
    reviewer: 'Reviewer',
    member: (ref: string) => `Member ${ref}`,
    save: 'Save draft',
    publish: 'Publish',
    fieldsHeading: 'Form fields',
    draft: (revision: number) => `Draft · revision ${revision}`,
    published: (version: number) => `Published v${version} · draft unchanged`,
    types: { text: 'Text', number: 'Number', boolean: 'Yes / no', date: 'Calendar date' },
    duplicate: (key: string) => `Key ${key} is used by more than one field.`,
    conflictTitle: 'Someone else changed this definition',
    reloadLatest: 'Reload latest',
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    builderTab: '应用搭建',
    field: (index: number) => `字段 ${index}`,
    key: '键名',
    type: '类型',
    labelEnUS: '标签（英文）',
    labelZhCN: '标签（中文）',
    required: '必填',
    maxLength: '最大长度',
    min: '最小值',
    max: '最大值',
    integer: '仅限整数',
    addField: '添加字段',
    remove: (index: number) => `删除字段 ${index}`,
    listColumns: '列表列',
    dateRuleStart: '日期范围开始',
    dateRuleEnd: '日期范围结束',
    reviewer: '审批人',
    member: (ref: string) => `成员 ${ref}`,
    save: '保存草稿',
    publish: '发 布',
    fieldsHeading: '表单字段',
    draft: (revision: number) => `草稿 · 修订 ${revision}`,
    published: (version: number) => `已发布 v${version} · 草稿无改动`,
    types: { text: '文本', number: '数字', boolean: '是 / 否', date: '日历日期' },
    duplicate: (key: string) => `键名 ${key} 被多个字段使用。`,
    conflictTitle: '其他人已修改此定义',
    reloadLatest: '加载最新草稿',
  },
} as const;

const looseMutation = (name: string) => makeFunctionReference<'mutation', Record<string, unknown>, unknown>(name);

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

function tableRows(envFile: string, table: string, component?: string): Row[] {
  let output: string;
  try {
    output = convexCli(envFile, [
      'data',
      table,
      '--format',
      'jsonLines',
      '--limit',
      '10000',
      ...(component ? ['--component', component] : []),
    ]);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Row);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function outcomeOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === 'string') return data;
    if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') return data.code;
  }
  const message = errorMessage(error);
  if (message.includes('ArgumentValidationError')) return 'ArgumentValidationError';
  if (message.includes('Could not find public function')) return 'FunctionNotFound';
  return `unexpected: ${message.split('\n')[0]}`;
}

async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible' });
  for (let presses = 0; presses < 250; presses += 1) {
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
  if (value === '') await page.keyboard.press('Backspace');
  else await page.keyboard.insertText(value);
}

async function keyboardChoose(page: Page, select: Locator, search: string, optionLabel: string): Promise<void> {
  await keyboardFocus(page, select);
  await page.keyboard.insertText(search);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: optionLabel })
    .first()
    .waitFor();
  await page.keyboard.press('Enter');
}

async function keyboardToggle(page: Page, checkbox: Locator, checked: boolean): Promise<void> {
  if ((await checkbox.isChecked()) === checked) return;
  await keyboardFocus(page, checkbox);
  await page.keyboard.press('Space');
  assert((await checkbox.isChecked()) === checked, 'Checkbox did not toggle from the keyboard');
}

function formItem(scope: Locator, label: string): Locator {
  return scope.locator('.ant-form-item').filter({ has: scope.page().locator(`label[title="${label}"]`) });
}

async function selectedLabels(scope: Locator, label: string): Promise<string[]> {
  const items = formItem(scope, label).locator('.ant-select-selection-item');
  const titles: string[] = [];
  for (const item of await items.all()) titles.push((await item.getAttribute('title')) ?? (await item.innerText()));
  return titles;
}

async function main(): Promise<void> {
  const mode = process.env.DEFINITION_JOURNEY_MODE === 'red' ? 'red' : 'green';
  const dir = process.env.DEFINITION_DIR?.trim();
  assert(dir, 'Set DEFINITION_DIR to the isolated target directory');
  const envFile = join(dir, 'target.env');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Definition journey requires an isolated local target');
  }
  const runId = readPrivate(dir, 'run-id');
  const password = readPrivate(dir, 'password');
  mkdirSync(artifactsDir, { recursive: true });
  const organizationKeys = {
    one: `fixture-def15-one-${runId}`,
    two: `fixture-def15-two-${runId}`,
    seed: `fixture-def15-seed-${runId}`,
  };

  const actors = actorPlan.map<Actor>((plan) => ({
    ...plan,
    email: `d15-${plan.key.toLowerCase()}-${runId}@example.test`,
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
  const appOne = (): Id<'applications'> => {
    const found = actor('A').applicationId;
    assert(found, 'Application one is not seeded');
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
          .map(([key, entry]) => [
            key,
            ['updatedAt', 'publishedAt', '_creationTime'].includes(key) ? '<timestamp>' : normalize(entry),
          ]),
      );
    }
    return value;
  };

  const checks: Check[] = [];
  const check = (id: string, expected: unknown, actual: unknown): boolean => {
    const normalizedExpected = normalize(expected);
    const normalizedActual = normalize(actual);
    const pass = JSON.stringify(normalizedExpected) === JSON.stringify(normalizedActual);
    checks.push({ id, expected: normalizedExpected, actual: normalizedActual, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`);
    return pass;
  };
  const must = (id: string, expected: unknown, actual: unknown): void => {
    assert(check(id, expected, actual), `Check failed: ${id}`);
  };

  const definitionRows = (applicationId: Id<'applications'>) => ({
    heads: tableRows(envFile, 'applicationDefinitions').filter((row) => row.applicationId === applicationId),
    versions: tableRows(envFile, 'applicationDefinitionVersions')
      .filter((row) => row.applicationId === applicationId)
      .sort((left, right) => Number(left.version) - Number(right.version)),
  });

  const deny = async (id: string, expected: string, operation: () => Promise<unknown>): Promise<void> => {
    const before = JSON.stringify(definitionRows(appOne()));
    let actual = 'succeeded';
    try {
      await operation();
    } catch (error) {
      actual = outcomeOf(error);
    }
    const unchanged = before === JSON.stringify(definitionRows(appOne()));
    check(id, { outcome: expected, stateUnchanged: true }, { outcome: actual, stateUnchanged: unchanged });
  };

  const seededOrganizations = new Set<string>();
  const cleanup: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  let browser: Browser | undefined;
  let failure: unknown;

  try {
    // Real Better Auth identities and fixture memberships.
    for (const target of actors) {
      try {
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      } catch {
        const signup = await target.auth.signUp.email({ name: `D15 ${target.key}`, email: target.email, password });
        assert(!signup.error, `Sign-up failed for actor ${target.key}`);
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      }
      const viewer = await target.client.query(api.users.getViewer, {});
      target.authUserId = viewer.id;
      const organizationKey = organizationKeys[target.organization];
      const seeded = runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
        organizationKey,
        organizationName: `Definition fixture ${target.organization}`,
        authUserId: viewer.id,
        capabilities: target.capabilities,
        status: 'active',
      });
      seededOrganizations.add(organizationKey);
      target.membershipId = seeded.membershipId;
      target.applicationId = seeded.applicationId;
      labels.set(seeded.membershipId, `<membership:${target.key}>`);
      labels.set(seeded.applicationId, `<application:${target.organization}>`);
      labels.set(seeded.organizationId, `<organization:${target.organization}>`);
      labels.set(viewer.id, `<authUser:${target.key}>`);
    }

    // Phase 1: HTTP denials leave the definition tables untouched.
    const v1Definition = leaveDefinition(membershipOf('B'));
    await deny('http.save.member-without-grant', 'PERMISSION_DENIED', () =>
      client('A').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: v1Definition,
      }),
    );
    await deny('http.publish.member-without-grant', 'PERMISSION_DENIED', () =>
      client('A').mutation(looseMutation('applicationDefinitions:publish'), {
        applicationId: appOne(),
        expectedRevision: 0,
      }),
    );
    await deny('http.save.foreign-organization', 'APPLICATION_ACCESS_DENIED', () =>
      client('Z').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: { ...v1Definition, reviewerMembershipId: membershipOf('Z') },
      }),
    );
    await deny('http.save.unknown-field-type', 'ArgumentValidationError', () =>
      client('D').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: {
          ...v1Definition,
          fields: [
            ...v1Definition.fields,
            { type: 'json', key: 'payload', label: { enUS: 'P', zhCN: '载' }, required: false },
          ],
        },
      }),
    );
    await deny('http.save.spoofed-organization-argument', 'ArgumentValidationError', () =>
      client('D').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        organizationId: actor('Z').applicationId,
        expectedRevision: 0,
        definition: v1Definition,
      }),
    );
    await deny('http.save.reviewer-without-review-grant', 'DEFINITION_REVIEWER_INVALID', () =>
      client('D').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: { ...v1Definition, reviewerMembershipId: membershipOf('A') },
      }),
    );
    await deny('http.save.reviewer-from-another-organization', 'DEFINITION_REVIEWER_INVALID', () =>
      client('D').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: { ...v1Definition, reviewerMembershipId: membershipOf('Z') },
      }),
    );
    await deny('http.save.duplicate-key', 'DEFINITION_FIELD_KEY_DUPLICATE', () =>
      client('D').mutation(looseMutation('applicationDefinitions:saveDraft'), {
        applicationId: appOne(),
        expectedRevision: 0,
        definition: { ...v1Definition, fields: [...v1Definition.fields, v1Definition.fields[3]] },
      }),
    );
    check('http.no-definition-rows-after-denials', { heads: [], versions: [] }, definitionRows(appOne()));
    if (mode === 'green') {
      // Phases 2 and 3: the builder UI in both languages, keyboard only, recorded.
      browser = await chromium.launch({ channel: 'chrome' });
      const v2Definition: Definition = {
        ...v1Definition,
        fields: [
          ...v1Definition.fields,
          { type: 'text', key: 'note', label: { enUS: 'Note', zhCN: '备注' }, required: false, maxLength: 500 },
        ],
        listColumns: [...v1Definition.listColumns, 'note'],
        reviewerMembershipId: membershipOf('C'),
      };
      let v1Snapshot: Row | undefined;

      for (const locale of ['en-US', 'zh-CN'] as const) {
        const text = texts[locale];
        const context = await browser.newContext({
          locale,
          viewport,
          recordVideo: { dir: artifactsDir, size: viewport },
        });
        const page = await context.newPage();
        await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
        page.setDefaultTimeout(20_000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const consoleLines: string[] = [];
        page.on('console', (message) => {
          consoleLines.push(`${message.type()}: ${message.text()}`);
          if (message.type() === 'error' && !/\[CONVEX M\(applicationDefinitions:/.test(message.text())) {
            pageErrors.push(message.text());
          }
        });
        const capture = async (step: string) => {
          await page.locator('button.ant-btn-loading').first().waitFor({ state: 'hidden' });
          await page.screenshot({
            path: join(artifactsDir, `${locale}-${step}.png`),
            fullPage: true,
            animations: 'disabled',
          });
        };
        const status = page.locator('output');
        const openBuilder = async () => {
          const target = page.getByRole('tab', { name: text.builderTab });
          await target.waitFor();
          await keyboardFocus(page, page.getByRole('tab', { selected: true }));
          for (let presses = 0; presses < 5; presses += 1) {
            if (await target.evaluate((element) => element === document.activeElement)) break;
            await page.keyboard.press('ArrowRight');
          }
          await page.keyboard.press('Enter');
          await page.getByRole('heading', { name: text.fieldsHeading }).waitFor();
        };
        const field = (index: number) => page.getByRole('group', { name: text.field(index), exact: true });
        const save = async () => keyboardActivate(page, page.getByRole('button', { name: text.save, exact: true }));
        const publishDraft = async () => {
          await keyboardActivate(page, page.getByRole('button', { name: text.publish, exact: true }));
          const confirm = page.locator('.ant-popconfirm').getByRole('button', { name: text.publish, exact: true });
          await keyboardActivate(page, confirm);
        };
        const fillField = async (index: number, value: DefinitionField, isNew: boolean) => {
          if (isNew) await keyboardActivate(page, page.getByRole('button', { name: text.addField, exact: true }));
          const group = field(index);
          await keyboardInput(page, group.getByLabel(text.key, { exact: true }), value.key);
          if (value.type !== 'text') {
            await keyboardChoose(
              page,
              group.getByLabel(text.type, { exact: true }),
              text.types[value.type],
              text.types[value.type],
            );
          }
          await keyboardInput(page, group.getByLabel(text.labelEnUS, { exact: true }), value.label.enUS);
          await keyboardInput(page, group.getByLabel(text.labelZhCN, { exact: true }), value.label.zhCN);
          if (value.type === 'text') {
            await keyboardInput(page, group.getByLabel(text.maxLength, { exact: true }), String(value.maxLength));
          }
          if (value.type === 'number') {
            await keyboardInput(page, group.getByLabel(text.min, { exact: true }), String(value.min));
            await keyboardInput(page, group.getByLabel(text.max, { exact: true }), String(value.max));
            await keyboardToggle(page, group.getByRole('checkbox', { name: text.integer }), value.integer);
          }
          await keyboardToggle(page, group.getByRole('checkbox', { name: text.required }), value.required);
        };
        const readForm = async () => {
          const fields: unknown[] = [];
          for (let index = 1; (await field(index).count()) > 0; index += 1) {
            const group = field(index);
            const type = (await selectedLabels(group, text.type))[0];
            const entry: Row = {
              key: await group.getByLabel(text.key, { exact: true }).inputValue(),
              type,
              labelEnUS: await group.getByLabel(text.labelEnUS, { exact: true }).inputValue(),
              labelZhCN: await group.getByLabel(text.labelZhCN, { exact: true }).inputValue(),
              required: await group.getByRole('checkbox', { name: text.required }).isChecked(),
            };
            if (type === text.types.text) entry.maxLength = await group.getByLabel(text.maxLength).inputValue();
            if (type === text.types.number) {
              entry.min = await group.getByLabel(text.min, { exact: true }).inputValue();
              entry.max = await group.getByLabel(text.max, { exact: true }).inputValue();
              entry.integer = await group.getByRole('checkbox', { name: text.integer }).isChecked();
            }
            fields.push(entry);
          }
          const form = page.locator('form#definition');
          return {
            fields,
            listColumns: await selectedLabels(form, text.listColumns),
            dateRuleStart: await selectedLabels(form, text.dateRuleStart),
            dateRuleEnd: await selectedLabels(form, text.dateRuleEnd),
            reviewer: await selectedLabels(form, text.reviewer),
          };
        };
        const expectedForm = (definition: Definition) => {
          const typeLabel = (type: DefinitionField['type']) => text.types[type];
          const columnLabel = (key: string) => {
            const found = definition.fields.find((entry) => entry.key === key);
            return `${locale === 'zh-CN' ? found?.label.zhCN : found?.label.enUS} (${key})`;
          };
          return {
            fields: definition.fields.map((entry) => ({
              key: entry.key,
              type: typeLabel(entry.type),
              labelEnUS: entry.label.enUS,
              labelZhCN: entry.label.zhCN,
              required: entry.required,
              ...(entry.type === 'text' ? { maxLength: String(entry.maxLength) } : {}),
              ...(entry.type === 'number'
                ? { min: String(entry.min), max: String(entry.max), integer: entry.integer }
                : {}),
            })),
            listColumns: definition.listColumns.map(columnLabel),
            dateRuleStart: definition.dateRules.map((rule) => columnLabel(rule.startKey)),
            dateRuleEnd: definition.dateRules.map((rule) => columnLabel(rule.endKey)),
            reviewer: [text.member(definition.reviewerMembershipId.slice(-6))],
          };
        };
        const persistedDraft = () => definitionRows(appOne()).heads[0]?.draft;

        try {
          await page.goto(appUrl);
          await keyboardInput(page, page.getByLabel(text.email, { exact: true }), actor('D').email);
          await keyboardInput(page, page.getByLabel(text.password, { exact: true }), password);
          await page.keyboard.press('Enter');
          await page.getByRole('button', { name: text.signOut }).waitFor();
          await openBuilder();

          if (locale === 'en-US') {
            await capture('1-empty-builder');
            for (const [index, value] of v1Definition.fields.entries()) await fillField(index + 1, value, index > 0);
            const form = page.locator('form#definition');
            for (const key of v1Definition.listColumns) {
              await keyboardChoose(page, form.getByLabel(text.listColumns, { exact: true }), key, `(${key})`);
            }
            await page.keyboard.press('Escape');
            await keyboardChoose(
              page,
              form.getByLabel(text.dateRuleStart, { exact: true }),
              'startDate',
              '(startDate)',
            );
            await keyboardChoose(page, form.getByLabel(text.dateRuleEnd, { exact: true }), 'endDate', '(endDate)');
            const refB = membershipOf('B').slice(-6);
            await keyboardChoose(page, form.getByLabel(text.reviewer, { exact: true }), refB, text.member(refB));
            await capture('2-v1-filled');
            await save();
            await status.getByText(text.draft(1), { exact: true }).waitFor();
            must('ui.en.v1-saved-persisted', canonical(v1Definition), canonical(persistedDraft()));
            labels.set(String(definitionRows(appOne()).heads[0]?._id), '<definition:one>');

            await page.reload();
            await page.getByRole('button', { name: text.signOut }).waitFor();
            await openBuilder();
            await status.getByText(text.draft(1), { exact: true }).waitFor();
            must('ui.en.v1-reload-reopen-matches', expectedForm(v1Definition), await readForm());
            await capture('3-v1-reopened');

            await publishDraft();
            await status.getByText(text.published(1), { exact: true }).waitFor();
            const afterV1 = definitionRows(appOne());
            v1Snapshot = afterV1.versions[0];
            assert(v1Snapshot, 'V1 row missing');
            labels.set(String(v1Snapshot._id), '<version:1>');
            must(
              'ui.en.v1-published-row',
              { version: 1, sourceRevision: 1, definition: canonical(v1Definition), publishedBy: membershipOf('D') },
              {
                version: v1Snapshot.version,
                sourceRevision: v1Snapshot.sourceRevision,
                definition: canonical(v1Snapshot.definition),
                publishedBy: v1Snapshot.publishedByMembershipId,
              },
            );
            await capture('4-v1-published');

            await fillField(5, v2Definition.fields[4], true);
            await keyboardChoose(page, form.getByLabel(text.listColumns, { exact: true }), 'note', '(note)');
            await page.keyboard.press('Escape');
            const refC = membershipOf('C').slice(-6);
            await keyboardChoose(page, form.getByLabel(text.reviewer, { exact: true }), refC, text.member(refC));
            await save();
            await status.getByText(text.draft(3), { exact: true }).waitFor();
            must('ui.en.v2-saved-persisted', canonical(v2Definition), canonical(persistedDraft()));
            await page.reload();
            await page.getByRole('button', { name: text.signOut }).waitFor();
            await openBuilder();
            await status.getByText(text.draft(3), { exact: true }).waitFor();
            must('ui.en.v2-reload-reopen-matches', expectedForm(v2Definition), await readForm());
            await publishDraft();
            await status.getByText(text.published(2), { exact: true }).waitFor();
            await capture('5-v2-published');

            const afterV2 = definitionRows(appOne());
            const [v1After, v2Row] = afterV2.versions;
            labels.set(String(v2Row?._id), '<version:2>');
            must('persist.v1-byte-for-byte-unchanged', JSON.stringify(v1Snapshot), JSON.stringify(v1After));
            must(
              'persist.pointer-is-v2-same-application',
              { currentVersionId: v2Row?._id, latestVersion: 2, applicationId: appOne(), versions: 2 },
              {
                currentVersionId: afterV2.heads[0]?.currentVersionId,
                latestVersion: afterV2.heads[0]?.latestVersion,
                applicationId: afterV2.heads[0]?.applicationId,
                versions: afterV2.versions.length,
              },
            );
            must('persist.v2-definition', canonical(v2Definition), canonical(v2Row?.definition));
            must(
              'api.published-version-readable-by-requester',
              { version: 2, isCurrent: true, definition: canonical(v2Definition) },
              await client('A')
                .query(api.applicationDefinitions.getPublishedVersion, { applicationId: appOne() })
                .then((result) => ({
                  version: result.version,
                  isCurrent: result.isCurrent,
                  definition: canonical(result.definition),
                })),
            );
            evidence.persistedAfterV2 = normalize(afterV2);
          } else {
            const heading = await page.getByRole('heading', { name: text.fieldsHeading }).count();
            const saveButton = await page.getByRole('button', { name: text.save, exact: true }).count();
            const publishButton = await page.getByRole('button', { name: text.publish, exact: true }).count();
            must(
              'ui.zh.localized-builder-controls',
              { heading: 1, saveButton: 1, publishButton: 1 },
              { heading, saveButton, publishButton },
            );
            must('ui.zh.v2-reopens-in-chinese', expectedForm(v2Definition), await readForm());
            await capture('1-builder');

            await fillField(
              6,
              {
                type: 'text',
                key: 'reason',
                label: { enUS: 'Reason again', zhCN: '再次原因' },
                required: false,
                maxLength: 20,
              },
              true,
            );
            const before = JSON.stringify(definitionRows(appOne()));
            await save();
            const duplicateError = field(6).getByText(text.duplicate('reason'), { exact: true });
            await duplicateError.waitFor();
            must(
              'ui.zh.duplicate-key-localized-and-marked',
              { visible: true, unchanged: true },
              {
                visible: await duplicateError.isVisible(),
                unchanged: before === JSON.stringify(definitionRows(appOne())),
              },
            );
            await capture('2-duplicate-key');
            await keyboardActivate(page, page.getByRole('button', { name: text.remove(6), exact: true }));

            const headBefore = definitionRows(appOne()).heads[0];
            const editedByE: Definition = { ...v2Definition, listColumns: ['startDate', 'endDate', 'note'] };
            const savedByE = await client('E').mutation(api.applicationDefinitions.saveDraft, {
              applicationId: appOne(),
              expectedRevision: Number(headBefore?.revision),
              definition: editedByE,
            });
            await save();
            const alert = page.getByRole('alert').filter({ hasText: text.conflictTitle });
            await alert.waitFor();
            const focusedInsideAlert = await page.evaluate(() =>
              Boolean(document.activeElement?.querySelector('[role="alert"]')),
            );
            await capture('3-conflict');
            await keyboardActivate(page, page.getByRole('button', { name: text.reloadLatest, exact: true }));
            await alert.waitFor({ state: 'hidden' });
            must(
              'ui.zh.conflict-alert-focused-and-reload-restores-server-draft',
              { focusedInsideAlert: true, form: expectedForm(editedByE), revision: savedByE.revision },
              { focusedInsideAlert, form: await readForm(), revision: definitionRows(appOne()).heads[0]?.revision },
            );
            must('persist.browser-stale-save-wrote-nothing', canonical(editedByE), canonical(persistedDraft()));
            await capture('4-reloaded-latest');
          }
          must(`ui.${locale}.no-page-errors`, [], pageErrors);
        } catch (error) {
          await page
            .screenshot({ path: join(artifactsDir, `${locale}-failure.png`), fullPage: true })
            .catch(() => undefined);
          writeFileSync(join(artifactsDir, `${locale}-failure-console.log`), `${consoleLines.join('\n')}\n`);
          throw error;
        } finally {
          const video = page.video();
          await context.close();
          if (video) renameSync(await video.path(), join(artifactsDir, `${locale}-builder.webm`));
        }
      }

      // Phase 4: two builders publish from the same revision at the same time.
      const raceHead = definitionRows(appOne()).heads[0];
      const versionsBefore = definitionRows(appOne()).versions.length;
      const race = await Promise.allSettled(
        (['D', 'E'] as const).map((key) =>
          client(key).mutation(api.applicationDefinitions.publish, {
            applicationId: appOne(),
            expectedRevision: Number(raceHead?.revision),
          }),
        ),
      );
      must(
        'concurrency.one-publish-wins',
        { fulfilled: 1, rejected: ['DEFINITION_REVISION_CONFLICT'], versionsAdded: 1 },
        {
          fulfilled: race.filter((result) => result.status === 'fulfilled').length,
          rejected: race.flatMap((result) => (result.status === 'rejected' ? [outcomeOf(result.reason)] : [])),
          versionsAdded: definitionRows(appOne()).versions.length - versionsBefore,
        },
      );
      must(
        'persist.v1-still-unchanged-after-v3',
        JSON.stringify(v1Snapshot),
        JSON.stringify(definitionRows(appOne()).versions[0]),
      );

      // Phase 5: the seed is idempotent and never overwrites a builder's edits.
      const seedBuilder = runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
        organizationKey: organizationKeys.seed,
        organizationName: 'Definition seed fixture',
        authUserId: actor('D').authUserId,
        capabilities: ['configureApplication'],
        status: 'active',
      });
      seededOrganizations.add(organizationKeys.seed);
      const seedReviewer = runInternal<SeedResult>(envFile, 'fixtures:upsertMember', {
        organizationKey: organizationKeys.seed,
        organizationName: 'Definition seed fixture',
        authUserId: actor('B').authUserId,
        capabilities: ['reviewRequests'],
        status: 'active',
      });
      labels.set(seedBuilder.applicationId, '<application:seed>');
      labels.set(seedBuilder.membershipId, '<membership:seed-D>');
      labels.set(seedReviewer.membershipId, '<membership:seed-B>');
      const seedApi = convexDefinitionSeedApi(client('D'));
      const firstSeed = await seedLeaveDefinition(seedApi, seedBuilder.applicationId, seedReviewer.membershipId);
      const edited: Definition = {
        ...leaveDefinition(seedReviewer.membershipId),
        listColumns: ['startDate', 'endDate'],
      };
      await client('D').mutation(api.applicationDefinitions.saveDraft, {
        applicationId: seedBuilder.applicationId,
        expectedRevision: firstSeed.revision,
        definition: edited,
      });
      const editedRows = JSON.stringify(definitionRows(seedBuilder.applicationId));
      const secondSeed = JSON.parse(
        execFileSync('bun', ['--tsconfig-override', 'tsconfig.demo.json', 'scripts/demo-definition-seed.ts'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DEFINITION_SEED_EMAIL: actor('D').email,
            DEFINITION_SEED_PASSWORD: password,
            DEFINITION_SEED_APPLICATION_ID: seedBuilder.applicationId,
            DEFINITION_SEED_REVIEWER_MEMBERSHIP_ID: seedReviewer.membershipId,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
      must(
        'seed.creates-once-then-skips-without-overwriting-edits',
        {
          first: { status: 'created', revision: 2, version: 1 },
          second: { status: 'skipped', revision: 3, version: 1 },
          rowsUnchanged: true,
        },
        {
          first: firstSeed,
          second: secondSeed,
          rowsUnchanged: editedRows === JSON.stringify(definitionRows(seedBuilder.applicationId)),
        },
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    await browser?.close();
  }

  const fixtureApplicationIds = new Set<unknown>(
    tableRows(envFile, 'applications')
      .filter((row) => {
        const organization = tableRows(envFile, 'organizations').find((entry) => entry._id === row.organizationId);
        return typeof organization?.key === 'string' && seededOrganizations.has(organization.key);
      })
      .map((row) => row._id),
  );
  for (const organizationKey of seededOrganizations) {
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
  check(
    'cleanup.fixture-and-definition-rows-removed',
    { organizations: 0, applications: 0, memberships: 0, definitions: 0, definitionVersions: 0 },
    {
      organizations: tableRows(envFile, 'organizations').filter(
        (row) => typeof row.key === 'string' && seededOrganizations.has(row.key),
      ).length,
      applications: tableRows(envFile, 'applications').filter((row) => fixtureApplicationIds.has(row._id)).length,
      memberships: tableRows(envFile, 'memberships').filter((row) => fixtureApplicationIds.has(row.applicationId))
        .length,
      definitions: tableRows(envFile, 'applicationDefinitions').filter((row) =>
        fixtureApplicationIds.has(row.applicationId),
      ).length,
      definitionVersions: tableRows(envFile, 'applicationDefinitionVersions').filter((row) =>
        fixtureApplicationIds.has(row.applicationId),
      ).length,
    },
  );

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    mode,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    target: { convexUrl, siteUrl, appUrl },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    error: failure === undefined ? null : errorMessage(failure),
    checks,
    cleanup: normalize(cleanup),
    retained: {
      betterAuthUsers: tableRows(envFile, 'user', 'betterAuth').length,
      betterAuthSessions: tableRows(envFile, 'session', 'betterAuth').length,
    },
  };
  const resultsName = mode === 'red' ? 'results-red.json' : 'results.json';
  writeFileSync(join(artifactsDir, resultsName), `${JSON.stringify(report, null, 2)}\n`);
  if (evidence.persistedAfterV2) {
    writeFileSync(
      join(artifactsDir, 'persisted-definition.json'),
      `${JSON.stringify(evidence.persistedAfterV2, null, 2)}\n`,
    );
  }
  console.log(`Definition journey (${mode}): ${report.summary.passed}/${report.summary.checks} checks passed.`);
  if (failure !== undefined || failed.length > 0) {
    if (failure !== undefined) console.error(`Definition journey failed: ${errorMessage(failure)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Definition journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
