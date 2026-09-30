#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { chromium, type BrowserContext, type Page } from 'playwright';
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
type Journey = { locale: Locale; account: Account; collectionTitle: string; target: Target };
type Report = (label: string) => void;
type CookieJar = Record<string, { value: string; expires: string | null }>;

const expectedText = {
  'en-US': {
    welcome: 'Welcome to Fenbase',
    email: 'Email',
    password: 'Password',
    failed: 'Sign in failed. Check your details and try again.',
    signOut: 'Sign out',
    collections: 'Collections',
    workflows: 'Workflows',
  },
  'zh-CN': {
    welcome: '欢迎使用 Fenbase',
    email: '邮箱',
    password: '密码',
    failed: '登录失败，请检查输入后重试。',
    signOut: '退出登录',
    collections: '数据集合',
    workflows: '工作流',
  },
} satisfies Record<Locale, Record<string, string>>;

const artifactsDir = join('dist', 'demo-journey');
const cookieStorageKey = 'better-auth_cookie';
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

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

function toCookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .filter(([, cookie]) => !cookie.expires || new Date(cookie.expires) >= new Date())
    .map(([key, cookie]) => `${key}=${cookie.value}`)
    .join('; ');
}

function hasSessionToken(jar: CookieJar): boolean {
  return Object.keys(jar).some((key) => key.includes('session_token'));
}

async function readCookieJar(page: Page): Promise<CookieJar> {
  return JSON.parse(await page.evaluate((key) => localStorage.getItem(key) ?? '{}', cookieStorageKey));
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return response.json().catch(() => null);
}

const documentLanguage = (page: Page) => page.evaluate(() => document.documentElement.lang);
const activeLabel = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.labels?.[0]?.textContent?.trim());
const activeText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim());
const activeRole = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('role'));

async function pressUntilFocused(
  page: Page,
  description: string,
  isFocused: () => Promise<boolean>,
  key: 'Tab' | 'Shift+Tab' = 'Tab',
  maxPresses = 8,
): Promise<number> {
  for (let presses = 1; presses <= maxPresses; presses += 1) {
    await page.keyboard.press(key);
    if (await isFocused()) return presses;
  }
  throw new Error(`Keyboard focus did not reach ${description} within ${maxPresses} ${key} presses`);
}

async function expectAbsent(description: string, count: () => Promise<number>): Promise<void> {
  assert((await count()) === 0, `${description} is visible to a signed-out user`);
}

async function verifyProtectedContentHidden(page: Page, { locale, account, collectionTitle }: Journey): Promise<void> {
  const text = expectedText[locale];
  await page.getByRole('heading', { name: text.welcome }).waitFor();
  await expectAbsent('Collections tab', () => page.getByRole('tab', { name: text.collections }).count());
  await expectAbsent('Sign out button', () => page.getByRole('button', { name: text.signOut }).count());
  await expectAbsent('Signed-in identity', () => page.getByText(account.name, { exact: true }).count());
  await expectAbsent('Account collection', () => page.getByText(collectionTitle, { exact: true }).count());
}

async function verifyBackendIdentity({ account, collectionTitle, target }: Journey): Promise<string> {
  const auth = createDemoAuthClient(target.siteUrl);
  const backend = await signInAndCreateConvexClient(auth, target.convexUrl, account.email, account.password);
  const viewer = await backend.query(api.users.getViewer, {});
  assert(viewer.email === account.email && viewer.name === account.name, 'Backend identity differs from the account');
  const collections = await backend.query(api.collections.list, {});
  assert(
    collections.items.some((item) => item.title === collectionTitle),
    'Backend does not list the seeded collection for the account',
  );
  await auth.signOut();
  return fingerprint(viewer.id);
}

async function verifySignedOutBackend(
  { target }: Journey,
  replayHeaders: Record<string, string>,
  issuedToken: string,
): Promise<void> {
  const anonymous = new ConvexHttpClient(target.convexUrl);
  await expectRejected(
    'Anonymous viewer query is rejected',
    () => anonymous.query(api.users.getViewer, {}),
    'Unauthenticated',
  );
  await expectRejected(
    'Anonymous collection list is rejected',
    () => anonymous.query(api.collections.list, {}),
    'Unauthenticated',
  );

  const replayedSession = await readJson(
    await fetch(`${target.siteUrl}/api/auth/get-session`, { headers: replayHeaders }),
  );
  assert(!replayedSession?.user, 'Signed-out session is still accepted by the server');
  const replayedToken = await fetch(`${target.siteUrl}/api/auth/convex/token`, { headers: replayHeaders });
  assert(
    !replayedToken.ok || !(await readJson(replayedToken))?.token,
    'Signed-out session can still obtain a Convex token',
  );

  const stale = new ConvexHttpClient(target.convexUrl);
  stale.setAuth(issuedToken);
  await expectRejected(
    'Token issued before sign-out is rejected',
    () => stale.query(api.users.getViewer, {}),
    'Unauthenticated',
  );
  await expectRejected(
    'Token issued before sign-out cannot list collections',
    () => stale.query(api.collections.list, {}),
    'Unauthenticated',
  );
}

async function verifyJourney(context: BrowserContext, journey: Journey, report: Report): Promise<void> {
  const { locale, account, collectionTitle, target } = journey;
  const text = expectedText[locale];
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      pageErrors.push(message.text());
    }
  });
  const capture = (name: string) =>
    page.screenshot({ path: join(artifactsDir, `${locale}-${name}.png`), fullPage: true });

  await page.goto(target.appUrl);
  const startPath = new URL(page.url()).pathname;
  await verifyProtectedContentHidden(page, journey);
  assert((await documentLanguage(page)) === locale, `Document language is not ${locale}`);
  await capture('1-signed-out');
  report(`${locale}: signed-out visitor sees only the sign-in screen in ${locale}`);

  const emailInput = page.getByLabel(text.email, { exact: true });
  const passwordInput = page.getByLabel(text.password, { exact: true });
  assert((await emailInput.isEditable()) && (await passwordInput.isEditable()), 'Form fields are not labelled inputs');
  await emailInput.fill(account.email);
  await passwordInput.fill(`${account.password}-wrong`);
  await page.keyboard.press('Enter');
  await page.getByRole('alert').getByText(text.failed).waitFor();
  await verifyProtectedContentHidden(page, journey);
  assert(!hasSessionToken(await readCookieJar(page)), 'Invalid credentials stored a session');
  await capture('2-invalid-credentials');
  report(`${locale}: invalid credentials show an announced translated error and keep the protected page closed`);

  await page.reload();
  await page.getByRole('heading', { name: text.welcome }).waitFor();
  const emailPresses = await pressUntilFocused(
    page,
    'the email field',
    async () => (await activeLabel(page)) === text.email,
  );
  await page.keyboard.type(account.email);
  await pressUntilFocused(page, 'the password field', async () => (await activeLabel(page)) === text.password);
  await page.keyboard.type(account.password);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: text.signOut }).waitFor();
  assert(
    await page.getByText(account.name, { exact: true }).isVisible(),
    'Protected page rendered without the identity',
  );
  await page.getByRole('heading', { name: text.collections }).waitFor();
  await page.getByText(collectionTitle, { exact: true }).first().waitFor();
  assert(new URL(page.url()).pathname === startPath, 'Sign-in changed the app path');
  assert((await documentLanguage(page)) === locale, `Signed-in language is not ${locale}`);
  await capture('3-signed-in');
  report(
    `${locale}: keyboard sign-in opened the protected page with identity and data (email focused after ${emailPresses} Tab presses)`,
  );

  const backendId = await verifyBackendIdentity(journey);
  report(`${locale}: backend identity ${backendId} matches the account, the displayed name, and the seeded collection`);

  await page.reload();
  await page.getByRole('button', { name: text.signOut }).waitFor();
  assert(
    await page.getByText(account.name, { exact: true }).isVisible(),
    'Reload rendered the page without the identity',
  );
  await page.getByText(collectionTitle, { exact: true }).first().waitFor();
  const jar = await readCookieJar(page);
  assert(hasSessionToken(jar), 'Session was not retained across reload');
  assert(new URL(page.url()).pathname === startPath, 'Reload changed the app path');
  await capture('4-after-reload');
  report(`${locale}: reload keeps the session, the displayed identity, and the data`);

  const replayHeaders = { 'Better-Auth-Cookie': toCookieHeader(jar), Origin: target.appUrl };
  const issued = await fetch(`${target.siteUrl}/api/auth/convex/token`, { headers: replayHeaders });
  const issuedToken = (await readJson(issued))?.token;
  assert(typeof issuedToken === 'string', 'Signed-in session could not obtain a Convex token');
  const before = new ConvexHttpClient(target.convexUrl);
  before.setAuth(issuedToken);
  assert(
    (await before.query(api.users.getViewer, {})).email === account.email,
    'Token does not authenticate the account',
  );

  await pressUntilFocused(page, 'the selected tab', async () => (await activeRole(page)) === 'tab');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: text.workflows }).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: text.collections }).waitFor();
  report(`${locale}: both navigation tabs work from the keyboard`);

  await pressUntilFocused(
    page,
    'the sign-out button',
    async () => (await activeText(page)) === text.signOut,
    'Shift+Tab',
  );
  await page.keyboard.press('Enter');
  await verifyProtectedContentHidden(page, journey);
  assert(!hasSessionToken(await readCookieJar(page)), 'Sign-out left a session in the browser');
  await capture('5-signed-out');
  await page.reload();
  await verifyProtectedContentHidden(page, journey);
  report(`${locale}: keyboard sign-out hides protected information, clears the stored session, and survives reload`);

  await verifySignedOutBackend(journey, replayHeaders, issuedToken);
  report(
    `${locale}: after sign-out anonymous calls, the replayed session, and the earlier token all fail as Unauthenticated`,
  );

  assert(pageErrors.length === 0, `Browser reported errors: ${pageErrors.join(' | ')}`);
  report(`${locale}: no uncaught browser errors during the journey`);
  await page.close();
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
  const account: Account = {
    name: `Journey ${suffix.slice(0, 8)}`,
    email: `demo-journey-${suffix}@example.test`,
    password: `Journey-${randomUUID()}-Aa1!`,
  };
  const collectionTitle = `Journey collection ${suffix.slice(0, 8)}`;
  let checks = 0;
  const report: Report = (label) => {
    checks += 1;
    console.log(`PASS ${label}`);
  };

  const setupAuth = createDemoAuthClient(target.siteUrl);
  const signUp = await setupAuth.signUp.email(account);
  assert(!signUp.error && signUp.data?.user?.email === account.email, 'Synthetic account signup failed');
  const owner = await signInAndCreateConvexClient(setupAuth, target.convexUrl, account.email, account.password);
  const collectionId = await owner.mutation(api.collections.create, {
    name: `journey_${suffix.slice(0, 8)}`,
    title: collectionTitle,
    fields: [{ name: 'title', type: 'text', required: true }],
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  const cleanupFailures: string[] = [];
  let failure: unknown;
  try {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const context = await browser.newContext({ locale });
      try {
        await verifyJourney(context, { locale, account, collectionTitle, target }, report);
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    failure = error;
  }
  await browser.close();
  await owner.mutation(api.collections.remove, { collectionId }).catch((error: unknown) => {
    cleanupFailures.push(`seeded collection: ${errorMessage(error)}`);
  });
  const signOut = await setupAuth.signOut();
  if (signOut.error) cleanupFailures.push('setup session sign-out failed');

  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorMessage(failure));
  assert(cleanupFailures.length === 0, `Cleanup failed: ${cleanupFailures.join('; ')}`);
  console.log(
    `Journey passed ${checks} checks. Screenshots: ${artifactsDir}. Removed: the seeded collection and setup session. ` +
      `Retained: one synthetic Better Auth user (${fingerprint(account.email)}) on ${new URL(target.siteUrl).host}.`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
