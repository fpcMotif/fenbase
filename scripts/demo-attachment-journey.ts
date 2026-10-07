#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { MAX_ATTACHMENT_BYTES, ORPHAN_GRACE_MS } from '../convex/attachmentModel';
import type { Definition } from '../convex/definitionModel';
import type { Capability } from '../convex/membershipValidators';
import { reconcileAttachments } from './demo-attachment-reconcile';
import {
  convexCli,
  keyboardActivate,
  keyboardDate,
  keyboardFocus,
  keyboardInput,
  outcomeOf,
  readPrivate,
  runInternal,
  tableRows,
} from './demo-request-journey';
import { assert, createDemoAuthClient, errorMessage, requiredUrl, signInAndCreateConvexClient } from './demo-verify';
import { leaveDefinition } from './leave-definition';

// Issue #18 verifier: protected attachments against an isolated local Convex backend started with --local-storage.
// Modes:
//   red      the backend phase only, written to results-red.json (run against functions without attachments)
//   backend  the backend phase only
//   full     the backend phase and keyboard-only browser sessions in en-US and zh-CN, recorded as video
// Every run ends with a reconciliation of attachment rows, `_storage` blobs, files on disk, audit events and retrieved
// bytes, then removes its fixtures and checks that no row, blob or file is left.

type Mode = 'red' | 'backend' | 'full';
type Locale = 'en-US' | 'zh-CN';
type ActorKey = 'A' | 'A2' | 'B' | 'R' | 'C' | 'I' | 'Z';
type OrganizationKey = 'one' | 'two';
type Row = Record<string, unknown>;
type Check = { id: string; expected: unknown; actual: unknown; pass: boolean };
type Membership = {
  organizationId: Id<'organizations'>;
  applicationId: Id<'applications'>;
  membershipId: Id<'memberships'>;
};
type Actor = {
  key: ActorKey;
  organization: OrganizationKey;
  capabilities: Capability[];
  status: 'active' | 'inactive';
  email: string;
  auth: ReturnType<typeof createDemoAuthClient>;
  client?: ConvexHttpClient;
  authUserId?: string;
  membership?: Membership;
};
type Uploaded = {
  attachmentId: Id<'requestAttachments'>;
  revision: number;
  replayed: boolean;
  fileName: string;
  size: number;
  contentType: string;
  sha256: string;
};
type Downloaded = { fileName: string; contentType: string; size: number; sha256: string; bytes: ArrayBuffer };

const artifactsDir = join('dist', 'attachment-journey');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const viewport = { width: 1280, height: 900 };

const actorPlan: Array<Pick<Actor, 'key' | 'organization' | 'capabilities' | 'status'>> = [
  { key: 'A', organization: 'one', capabilities: ['submitRequests'], status: 'active' },
  { key: 'A2', organization: 'one', capabilities: ['submitRequests'], status: 'active' },
  { key: 'B', organization: 'one', capabilities: ['reviewRequests'], status: 'active' },
  { key: 'R', organization: 'one', capabilities: ['readApplicationRecords'], status: 'active' },
  { key: 'C', organization: 'one', capabilities: ['configureApplication'], status: 'active' },
  { key: 'I', organization: 'one', capabilities: ['submitRequests'], status: 'inactive' },
  {
    key: 'Z',
    organization: 'two',
    capabilities: ['submitRequests', 'reviewRequests', 'readApplicationRecords', 'configureApplication'],
    status: 'active',
  },
];

const texts = {
  'en-US': {
    email: 'Email',
    password: 'Password',
    signOut: 'Sign out',
    requestsTab: 'Requests',
    newRequest: 'New request',
    save: 'Save draft',
    submit: 'Submit for review',
    assigned: 'Assigned to me',
    openRow: 'Open request',
    labels: { startDate: 'Start date', endDate: 'End date', days: 'Days', reason: 'Reason' },
    field: 'Supporting document',
    created: (revision: number) => `Draft created · revision ${revision}`,
    submitted: (revision: number) => `Request submitted · revision ${revision}`,
    attachTo: 'Attach a file to Supporting document',
    attached: (name: string, revision: number) => `Attached ${name} · revision ${revision}`,
    removed: (name: string, revision: number) => `Removed ${name} · revision ${revision}`,
    downloaded: (name: string) => `Downloaded ${name}`,
    download: (name: string) => `Download ${name}`,
    remove: (name: string) => `Remove ${name}`,
    removeOk: 'Remove',
    meta: (size: string, hash: string) => `${size} · SHA-256 ${hash}`,
    none: 'No files attached.',
    interrupted:
      'The connection dropped before the server confirmed this file action. Nothing is shown as attached until the list below includes it.',
    tooLarge: 'Choose a file of at most 2097152 bytes for Supporting document.',
    dates: { first: '2026-06-01', interrupted: '2026-06-15' },
    fileName: 'medical-note.pdf',
    extraName: 'scan.png',
  },
  'zh-CN': {
    email: '邮箱',
    password: '密码',
    signOut: '退出登录',
    requestsTab: '申请',
    newRequest: '新建申请',
    save: '保存草稿',
    submit: '提交审批',
    assigned: '待我审批',
    openRow: '打开申请',
    labels: { startDate: '开始日期', endDate: '结束日期', days: '天数', reason: '原因' },
    field: '证明材料',
    created: (revision: number) => `草稿已创建 · 修订 ${revision}`,
    submitted: (revision: number) => `申请已提交 · 修订 ${revision}`,
    attachTo: '为 证明材料 上传文件',
    attached: (name: string, revision: number) => `已上传 ${name} · 修订 ${revision}`,
    removed: (name: string, revision: number) => `已删除 ${name} · 修订 ${revision}`,
    downloaded: (name: string) => `已下载 ${name}`,
    download: (name: string) => `下载 ${name}`,
    remove: (name: string) => `删除 ${name}`,
    removeOk: '删 除',
    meta: (size: string, hash: string) => `${size} · SHA-256 ${hash}`,
    none: '尚未上传文件。',
    interrupted: '服务器确认前连接已中断。只有下方列表中出现的文件才算已上传。',
    tooLarge: '证明材料 的文件不能超过 2097152 字节。',
    dates: { first: '2026-07-01', interrupted: '2026-07-15' },
    fileName: '病假证明.pdf',
    extraName: '扫描件.png',
  },
} as const;

const looseMutation = (name: string) => makeFunctionReference<'mutation', Record<string, unknown>, unknown>(name);
const looseQuery = (name: string) => makeFunctionReference<'query', Record<string, unknown>, unknown>(name);
const looseAction = (name: string) => makeFunctionReference<'action', Record<string, unknown>, unknown>(name);

function sha256Hex(bytes: Uint8Array | ArrayBuffer): string {
  return createHash('sha256')
    .update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
    .digest('hex');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

// A synthetic PDF of `size` bytes: a valid header and trailer around deterministic filler.
function syntheticPdf(label: string, size = 4096): Uint8Array {
  const head = new TextEncoder().encode(`%PDF-1.4\n% synthetic evidence ${label}\n`);
  const tail = new TextEncoder().encode('\n%%EOF\n');
  const bytes = new Uint8Array(size);
  bytes.set(head);
  for (let index = head.length; index < size - tail.length; index += 1) bytes[index] = 0x20 + (index % 90);
  bytes.set(tail, size - tail.length);
  return bytes;
}

function syntheticPng(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

// The blob files of the backend's local file store (`--local-storage DIR` keeps them in DIR/files).
function diskFiles(directory: string): Array<{ size: number; sha256: string }> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return diskFiles(path);
    if (!entry.isFile()) return [];
    const bytes = readFileSync(path);
    return [{ size: bytes.byteLength, sha256: sha256Hex(bytes) }];
  });
}

function memberRef(membershipId: string): string {
  return membershipId.slice(-6);
}

function formatKb(bytes: number, language: string): string {
  return bytes < 1024 ? `${bytes} B` : `${new Intl.NumberFormat(language).format(Math.ceil(bytes / 1024))} KB`;
}

// The Convex sync protocol frame of a `requestAttachments:upload` action, if this frame is one.
function isUploadFrame(payload: string | Buffer): boolean {
  if (typeof payload !== 'string') return false;
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return false;
  }
  if (typeof message !== 'object' || message === null) return false;
  const udfPath: unknown = Reflect.get(message, 'udfPath');
  return (
    Reflect.get(message, 'type') === 'Action' &&
    typeof udfPath === 'string' &&
    /^requestAttachments(\.js)?:upload$/.test(udfPath)
  );
}

async function main(): Promise<void> {
  const requestedMode = process.env.ATTACHMENT_JOURNEY_MODE?.trim() ?? 'full';
  assert(['red', 'backend', 'full'].includes(requestedMode), 'ATTACHMENT_JOURNEY_MODE is red, backend or full');
  const mode = requestedMode as Mode;
  const dir = process.env.ATTACHMENT_DIR?.trim();
  assert(dir, 'Set ATTACHMENT_DIR to the isolated target directory');
  const envFile = join(dir, 'target.env');
  const convexUrl = requiredUrl('VITE_CONVEX_URL', 'CONVEX_URL');
  const siteUrl = requiredUrl('VITE_CONVEX_SITE_URL', 'CONVEX_SITE_URL');
  const appUrl = process.env.DEMO_APP_URL?.trim() || 'http://localhost:5173';
  for (const url of [convexUrl, siteUrl, appUrl]) {
    assert(localHosts.has(new URL(url).hostname), 'Attachment journey requires an isolated local target');
  }
  const runId = readPrivate(dir, 'run-id');
  const password = readPrivate(dir, 'password');
  const filesDir = join(dir, 'files');
  mkdirSync(artifactsDir, { recursive: true });
  const organizationKeys: Record<OrganizationKey, string> = {
    one: `fixture-at18-one-${runId}`,
    two: `fixture-at18-two-${runId}`,
  };

  const actors = actorPlan.map<Actor>((plan) => ({
    ...plan,
    email: `at18-${plan.key.toLowerCase()}-${runId}@example.test`,
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
  const membership = (key: ActorKey): Membership => {
    const found = actor(key).membership;
    assert(found, `Actor ${key} has no membership`);
    return found;
  };
  const appOne = (): Id<'applications'> => membership('C').applicationId;
  const appTwo = (): Id<'applications'> => membership('Z').applicationId;

  const labels = new Map<string, string>();
  const memberReferences = new Map<string, string>();
  const timeKeys = new Set(['updatedAt', 'publishedAt', '_creationTime', 'createdAt', 'submittedAt', 'decidedAt']);
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const labelled = labels.get(value);
      if (labelled) return labelled;
      let text = value.replaceAll(runId, '<run>');
      for (const [reference, label] of memberReferences) text = text.replaceAll(reference, label);
      return text;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, timeKeys.has(key) ? `<${key}>` : normalize(entry)]),
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

  const fixtureApplications = new Set<unknown>();
  const rowsOf = (table: 'requests' | 'requestAttachments' | 'attachmentEvents' | 'requestEvents') =>
    tableRows(envFile, table)
      .filter((row) => fixtureApplications.has(row.applicationId))
      .sort((left, right) => Number(left._creationTime) - Number(right._creationTime));
  const storageRows = () => tableRows(envFile, '_storage');
  const fileState = () =>
    JSON.stringify([
      rowsOf('requests').map((row) => [row._id, row.revision, row.state]),
      rowsOf('requestAttachments').map((row) => row._id),
      rowsOf('attachmentEvents').map((row) => row._id),
      storageRows().map((row) => row._id),
    ]);
  const attachmentsOf = (requestId: string) =>
    rowsOf('requestAttachments').filter((row) => row.requestId === requestId);

  const deny = async (id: string, expected: string, operation: () => Promise<unknown>): Promise<void> => {
    const before = fileState();
    let actual = 'succeeded';
    try {
      await operation();
    } catch (error) {
      actual = outcomeOf(error);
    }
    check(id, { outcome: expected, unchanged: true }, { outcome: actual, unchanged: before === fileState() });
  };
  const outcome = async (promise: Promise<unknown>) =>
    promise.then(
      (value) => value,
      (error: unknown) => outcomeOf(error),
    );

  let operationCounter = 0;
  const operationId = (label: string) => {
    operationCounter += 1;
    return `at18-${label}-${operationCounter}-${runId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  };
  const setMember = (key: ActorKey, status: 'active' | 'inactive', capabilities?: Capability[]) => {
    runInternal(envFile, 'fixtures:upsertMember', {
      organizationKey: organizationKeys[actor(key).organization],
      organizationName: `Attachment fixture ${actor(key).organization}`,
      authUserId: actor(key).authUserId,
      capabilities: capabilities ?? actor(key).capabilities,
      status,
    });
  };

  const publishDefinition = async (key: ActorKey, applicationId: Id<'applications'>, definition: Definition) => {
    const state = await client(key).query(api.applicationDefinitions.getBuilderState, { applicationId });
    const saved = await client(key).mutation(api.applicationDefinitions.saveDraft, {
      applicationId,
      expectedRevision: state.head?.revision ?? 0,
      definition,
    });
    return client(key).mutation(api.applicationDefinitions.publish, {
      applicationId,
      expectedRevision: saved.revision,
    });
  };

  const leave = { startDate: '2026-03-02', endDate: '2026-03-04', days: 3, reason: 'Medical leave' };
  let versionId = '' as Id<'applicationDefinitionVersions'>;
  let zVersionId = '' as Id<'applicationDefinitionVersions'>;
  const draft = async (key: ActorKey, label: string, applicationId = appOne(), version = versionId) => {
    const created = (await client(key).mutation(looseMutation('requests:create'), {
      applicationId,
      definitionVersionId: version,
      operationId: operationId(`create-${label}`),
      values: leave,
    })) as { requestId: Id<'requests'> };
    labels.set(created.requestId, `<request:${label}>`);
    return created.requestId;
  };
  const upload = (
    key: ActorKey,
    requestId: string,
    expectedRevision: number,
    fileName: string,
    bytes: Uint8Array,
    extra: Record<string, unknown> = {},
  ) =>
    client(key).action(looseAction('requestAttachments:upload'), {
      applicationId: appOne(),
      requestId,
      fieldKey: 'supportingDocument',
      fileName,
      bytes: toArrayBuffer(bytes),
      expectedRevision,
      operationId: operationId('upload'),
      ...extra,
    }) as Promise<Uploaded>;
  const download = (key: ActorKey, attachmentId: string, applicationId = appOne()) =>
    client(key).action(looseAction('requestAttachments:download'), {
      applicationId,
      attachmentId,
    }) as Promise<Downloaded>;
  const list = (key: ActorKey, requestId: string) =>
    client(key).query(looseQuery('requestAttachments:list'), { applicationId: appOne(), requestId }) as Promise<Array<{
      fileName: string;
    }> | null>;
  const removeFile = (key: ActorKey, requestId: string, attachmentId: string, expectedRevision: number) =>
    client(key).mutation(looseMutation('requestAttachments:remove'), {
      applicationId: appOne(),
      requestId,
      attachmentId,
      expectedRevision,
      operationId: operationId('remove'),
    }) as Promise<{ revision: number; replayed: boolean }>;
  const command = (key: ActorKey, name: 'submit' | 'approve', requestId: string, expectedRevision: number) =>
    client(key).mutation(looseMutation(`requestReviews:${name}`), {
      applicationId: appOne(),
      requestId,
      expectedRevision,
      operationId: operationId(name),
    }) as Promise<{ revision: number; state: string }>;

  const seededOrganizations = new Set<string>();
  const retrieved: Array<{ attachmentId: string; fileName: string; size: number; sha256: string }> = [];
  const cleanup: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  let browser: Browser | undefined;
  let failure: unknown;

  try {
    for (const target of actors) {
      try {
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      } catch {
        const signup = await target.auth.signUp.email({ name: `AT18 ${target.key}`, email: target.email, password });
        assert(!signup.error, `Sign-up failed for actor ${target.key}`);
        target.client = await signInAndCreateConvexClient(target.auth, convexUrl, target.email, password);
      }
      const viewer = await target.client.query(api.users.getViewer, {});
      target.authUserId = viewer.id;
      labels.set(viewer.id, `<authUser:${target.key}>`);
      const organizationKey = organizationKeys[target.organization];
      const seeded = runInternal<Membership>(envFile, 'fixtures:upsertMember', {
        organizationKey,
        organizationName: `Attachment fixture ${target.organization}`,
        authUserId: viewer.id,
        capabilities: target.capabilities,
        status: target.status,
      });
      seededOrganizations.add(organizationKey);
      fixtureApplications.add(seeded.applicationId);
      target.membership = seeded;
      labels.set(seeded.membershipId, `<membership:${target.key}>`);
      memberReferences.set(memberRef(seeded.membershipId), `<ref:${target.key}>`);
      labels.set(seeded.applicationId, `<application:${target.organization}>`);
      labels.set(seeded.organizationId, `<organization:${target.organization}>`);
    }

    // SETUP: the HR reference with its attachment field, under the readers preset so a reader sees the request.
    const hrReference: Definition = {
      ...leaveDefinition(membership('B').membershipId),
      listColumns: ['requester', 'startDate', 'endDate', 'days'],
      policyPreset: 'requesterAssignedReviewerAndReaders',
    };
    const published = await outcome(publishDefinition('C', appOne(), hrReference));
    check(
      'SETUP.publish-hr-reference-with-attachment-field',
      'published',
      typeof published === 'string' ? published : 'published',
    );
    const withoutAttachment = {
      ...hrReference,
      fields: hrReference.fields.filter((field) => field.type !== 'attachment'),
    };
    const v1 =
      typeof published === 'string'
        ? await publishDefinition('C', appOne(), withoutAttachment)
        : (published as { versionId: Id<'applicationDefinitionVersions'> });
    versionId = v1.versionId;
    labels.set(versionId, '<version:one:1>');
    const zDefinition = { ...leaveDefinition(membership('Z').membershipId) };
    const zPublished = await outcome(publishDefinition('Z', appTwo(), zDefinition));
    zVersionId = (
      typeof zPublished === 'string'
        ? await publishDefinition('Z', appTwo(), {
            ...zDefinition,
            fields: zDefinition.fields.filter((field) => field.type !== 'attachment'),
          })
        : zPublished
    ).versionId as Id<'applicationDefinitionVersions'>;
    labels.set(zVersionId, '<version:two:1>');

    // FILE-01: the bytes, size and hash round-trip, including a file of exactly the 2 MiB ceiling.
    const r1 = await draft('A', 'r1');
    const pdf = syntheticPdf('r1');
    const first = await outcome(upload('A', r1, 1, 'medical-note.pdf', pdf));
    const firstOk = typeof first === 'object' && first !== null ? (first as Uploaded) : null;
    if (firstOk) labels.set(firstOk.attachmentId, '<attachment:r1-pdf>');
    check(
      'FILE-01.upload-returns-server-measured-metadata',
      {
        revision: 2,
        replayed: false,
        fileName: 'medical-note.pdf',
        size: pdf.byteLength,
        contentType: 'application/pdf',
        sha256: sha256Hex(pdf),
      },
      firstOk
        ? {
            revision: firstOk.revision,
            replayed: firstOk.replayed,
            fileName: firstOk.fileName,
            size: firstOk.size,
            contentType: firstOk.contentType,
            sha256: firstOk.sha256,
          }
        : first,
    );
    const firstRow = attachmentsOf(r1)[0];
    const firstBlob = storageRows().find((row) => row._id === firstRow?.storageId);
    evidence.storageSha256Encoding =
      typeof firstBlob?.sha256 === 'string' ? (/^[0-9a-f]{64}$/.test(firstBlob.sha256) ? 'hex' : 'base64') : 'missing';
    check(
      'FILE-01.row-and-blob-agree',
      { uploader: membership('A').membershipId, size: pdf.byteLength, blobSize: pdf.byteLength, blobMatchesHash: true },
      {
        uploader: firstRow?.uploaderMembershipId,
        size: firstRow?.size,
        blobSize: firstBlob?.size,
        blobMatchesHash:
          firstBlob?.sha256 === sha256Hex(pdf) ||
          firstBlob?.sha256 === Buffer.from(sha256Hex(pdf), 'hex').toString('base64'),
      },
    );
    const fetched = firstOk ? await outcome(download('A', firstOk.attachmentId)) : 'no attachment';
    const fetchedOk = typeof fetched === 'object' && fetched !== null ? (fetched as Downloaded) : null;
    if (firstOk && fetchedOk) {
      retrieved.push({
        attachmentId: firstOk.attachmentId,
        fileName: fetchedOk.fileName,
        size: fetchedOk.bytes.byteLength,
        sha256: sha256Hex(fetchedOk.bytes),
      });
    }
    check(
      'FILE-01.download-returns-identical-bytes',
      { fileName: 'medical-note.pdf', size: pdf.byteLength, sha256: sha256Hex(pdf) },
      fetchedOk
        ? { fileName: fetchedOk.fileName, size: fetchedOk.bytes.byteLength, sha256: sha256Hex(fetchedOk.bytes) }
        : fetched,
    );
    const ceiling = syntheticPng(MAX_ATTACHMENT_BYTES);
    const atCeiling = await outcome(upload('A', r1, 2, 'scan-at-ceiling.png', ceiling));
    const atCeilingOk = typeof atCeiling === 'object' && atCeiling !== null ? (atCeiling as Uploaded) : null;
    if (atCeilingOk) labels.set(atCeilingOk.attachmentId, '<attachment:r1-png>');
    check(
      'FILE-01.two-mebibyte-file-round-trips-through-the-action',
      { size: MAX_ATTACHMENT_BYTES, sha256: sha256Hex(ceiling), downloadedSha256: sha256Hex(ceiling) },
      atCeilingOk
        ? {
            size: atCeilingOk.size,
            sha256: atCeilingOk.sha256,
            downloadedSha256: await download('A', atCeilingOk.attachmentId).then((file) => {
              retrieved.push({
                attachmentId: atCeilingOk.attachmentId,
                fileName: file.fileName,
                size: file.bytes.byteLength,
                sha256: sha256Hex(file.bytes),
              });
              return sha256Hex(file.bytes);
            }, outcomeOf),
          }
        : atCeiling,
    );

    // FILE-03: limits and types are measured on the server, never taken from the client.
    const r2 = await draft('A', 'r2');
    await deny('FILE-03.one-byte-over-the-ceiling', 'ATTACHMENT_TOO_LARGE', () =>
      upload('A', r2, 1, 'big.pdf', syntheticPdf('big', MAX_ATTACHMENT_BYTES + 1)),
    );
    await deny('FILE-03.html-renamed-to-pdf', 'ATTACHMENT_TYPE_NOT_ALLOWED', () =>
      upload('A', r2, 1, 'invoice.pdf', new TextEncoder().encode('<!doctype html><script>alert(1)</script>')),
    );
    await deny('FILE-03.png-named-pdf', 'ATTACHMENT_TYPE_NOT_ALLOWED', () =>
      upload('A', r2, 1, 'scan.pdf', syntheticPng(64)),
    );
    await deny('FILE-03.third-file-in-a-two-file-field', 'ATTACHMENT_LIMIT_REACHED', () =>
      upload('A', r1, 3, 'third.pdf', syntheticPdf('third')),
    );
    for (const [name, value] of [
      ['contentType', 'application/pdf'],
      ['size', 10],
      ['sha256', sha256Hex(pdf)],
      ['uploaderMembershipId', membership('B').membershipId],
      ['storageId', String(firstRow?.storageId)],
    ] as const) {
      await deny(`FILE-03.client-supplied-${name}-rejected`, 'ArgumentValidationError', () =>
        upload('A', r2, 1, 'note.pdf', syntheticPdf('forged'), { [name]: value }),
      );
    }

    // FILE-02: storage ids are never accepted, and attachments of other requests stay unreachable.
    await deny('FILE-02.internal-attach-is-not-public', 'FunctionNotFound', () =>
      client('A').mutation(looseMutation('requestAttachments:attach'), {
        applicationId: appOne(),
        requestId: r2,
        fieldKey: 'supportingDocument',
        expectedRevision: 1,
        operationId: operationId('attach'),
        fingerprint: 'forged',
        storageId: String(firstRow?.storageId),
        fileName: 'stolen.pdf',
        contentType: 'application/pdf',
        size: pdf.byteLength,
        sha256: sha256Hex(pdf),
      }),
    );
    await deny('FILE-02.download-by-storage-id', 'ArgumentValidationError', () =>
      download('A', String(firstRow?.storageId)),
    );
    const zDraft = await draft('Z', 'z-draft', appTwo(), zVersionId);
    const zUpload = (await client('Z')
      .action(looseAction('requestAttachments:upload'), {
        applicationId: appTwo(),
        requestId: zDraft,
        fieldKey: 'supportingDocument',
        fileName: 'other-org.pdf',
        bytes: toArrayBuffer(syntheticPdf('z')),
        expectedRevision: 1,
        operationId: operationId('z-upload'),
      })
      .then(
        (value) => value as Uploaded,
        () => null,
      )) as Uploaded | null;
    if (zUpload) labels.set(zUpload.attachmentId, '<attachment:z>');
    await deny('FILE-02.foreign-organization-attachment', 'RECORD_NOT_FOUND', () =>
      zUpload ? download('A', zUpload.attachmentId) : Promise.reject(new Error('no foreign attachment')),
    );
    const a2Draft = await draft('A2', 'a2-draft');
    const a2Upload = await upload('A2', a2Draft, 1, 'a2.pdf', syntheticPdf('a2')).catch(() => null);
    if (a2Upload) labels.set(a2Upload.attachmentId, '<attachment:a2>');
    await deny('FILE-02.remove-another-requests-attachment-through-own-draft', 'RECORD_NOT_FOUND', () =>
      a2Upload ? removeFile('A', r2, a2Upload.attachmentId, 1) : Promise.reject(new Error('no attachment')),
    );

    // FILE-09: a repeated upload with the same operation id returns the first attachment and stores nothing new.
    const replayId = operationId('replay');
    const replayBytes = syntheticPdf('replay');
    const replayFirst = await upload('A', r2, 1, 'replay.pdf', replayBytes, { operationId: replayId }).catch(outcomeOf);
    const blobsBefore = storageRows().length;
    const replaySecond = await upload('A', r2, 1, 'replay.pdf', replayBytes, { operationId: replayId }).catch(
      outcomeOf,
    );
    check(
      'FILE-09.replayed-upload-returns-first-attachment',
      { replayed: true, same: true, blobsAdded: 0 },
      {
        replayed: typeof replaySecond === 'object' ? replaySecond.replayed : replaySecond,
        same:
          typeof replayFirst === 'object' &&
          typeof replaySecond === 'object' &&
          replayFirst.attachmentId === replaySecond.attachmentId,
        blobsAdded: storageRows().length - blobsBefore,
      },
    );

    // FILE-04 and FILE-05: submit pins the evidence; the requester and the assigned reviewer read it, nobody else.
    const submitted = await outcome(command('A', 'submit', r1, 3));
    check(
      'FILE-04.submit-with-evidence',
      'pending',
      typeof submitted === 'object' ? (submitted as { state: string }).state : submitted,
    );
    const firstAttachment = String(firstOk?.attachmentId);
    await deny('FILE-04.upload-after-submit', 'REQUEST_STATE_CONFLICT', () =>
      upload('A', r1, 4, 'late.pdf', syntheticPdf('late')),
    );
    await deny('FILE-04.remove-after-submit', 'REQUEST_STATE_CONFLICT', () => removeFile('A', r1, firstAttachment, 4));
    const anonymous = new ConvexHttpClient(convexUrl);
    const readOutcome = async (key: ActorKey | 'anonymous') => {
      const reader = key === 'anonymous' ? anonymous : client(key);
      const listed = await outcome(
        reader.query(looseQuery('requestAttachments:list'), { applicationId: appOne(), requestId: r1 }),
      );
      const fetchedBytes = await outcome(
        reader
          .action(looseAction('requestAttachments:download'), {
            applicationId: appOne(),
            attachmentId: firstAttachment,
          })
          .then((file) => sha256Hex((file as Downloaded).bytes)),
      );
      return {
        list: Array.isArray(listed) ? listed.length : listed,
        download: fetchedBytes === sha256Hex(pdf) ? 'bytes' : fetchedBytes,
      };
    };
    const matrix: Record<string, unknown> = {};
    for (const key of ['A', 'B', 'R', 'C', 'A2', 'I', 'Z', 'anonymous'] as const) matrix[key] = await readOutcome(key);
    check(
      'FILE-05.read-matrix-on-pending-request',
      {
        A: { list: 2, download: 'bytes' },
        B: { list: 2, download: 'bytes' },
        R: { list: 0, download: 'RECORD_NOT_FOUND' },
        C: { list: null, download: 'RECORD_NOT_FOUND' },
        A2: { list: null, download: 'RECORD_NOT_FOUND' },
        I: { list: 'APPLICATION_ACCESS_DENIED', download: 'APPLICATION_ACCESS_DENIED' },
        Z: { list: 'APPLICATION_ACCESS_DENIED', download: 'APPLICATION_ACCESS_DENIED' },
        anonymous: { list: 'Unauthenticated', download: 'Unauthenticated' },
      },
      matrix,
    );
    check(
      'FILE-05.draft-evidence-private-to-requester',
      { requester: 1, reviewer: null },
      {
        requester: await outcome(list('A', r2).then((files) => files?.length ?? null)),
        reviewer: await outcome(list('B', r2).then((files) => files?.length ?? null)),
      },
    );
    const approved = await outcome(command('B', 'approve', r1, 4));
    check(
      'FILE-04.decided-evidence-still-readable-and-frozen',
      { state: 'approved', reviewerBytes: true, removal: 'REQUEST_STATE_CONFLICT' },
      {
        state: typeof approved === 'object' ? (approved as { state: string }).state : approved,
        reviewerBytes: await download('B', firstAttachment).then(
          (file) => sha256Hex(file.bytes) === sha256Hex(pdf),
          outcomeOf,
        ),
        removal: await outcome(removeFile('A', r1, firstAttachment, 5)),
      },
    );

    // FILE-06: revoking access is effective on the first retrieval after it commits; no link outlives it.
    const revocations: Record<string, unknown> = {};
    const timeDenial = async (label: string, key: ActorKey, revoke: () => Promise<void> | void) => {
      await revoke();
      const committed = Date.now();
      const result = await outcome(download(key, firstAttachment).then(() => 'bytes'));
      revocations[label] = { firstCallAfterRevocation: result, elapsedMs: Date.now() - committed };
      return result;
    };
    const lostGrant = await timeDenial('reviewer-loses-reviewRequests', 'B', () => setMember('B', 'active', []));
    setMember('B', 'active');
    const deactivated = await timeDenial('requester-deactivated', 'A', () => setMember('A', 'inactive'));
    setMember('A', 'active');
    const signedOut = await timeDenial('reviewer-signs-out', 'B', async () => {
      await actor('B').auth.signOut();
    });
    actor('B').client = await signInAndCreateConvexClient(actor('B').auth, convexUrl, actor('B').email, password);
    evidence.revocations = revocations;
    check(
      'FILE-06.first-retrieval-after-revocation-is-denied',
      {
        lostGrant: 'RECORD_NOT_FOUND',
        deactivated: 'APPLICATION_ACCESS_DENIED',
        signedOut: 'Unauthenticated',
        restored: true,
      },
      {
        lostGrant,
        deactivated,
        signedOut,
        restored: await download('B', firstAttachment).then(
          (file) => sha256Hex(file.bytes) === sha256Hex(pdf),
          outcomeOf,
        ),
      },
    );

    // FILE-08: deleting a draft removes its own files only.
    const r3 = await draft('A', 'r3');
    const r4 = await draft('A', 'r4');
    const r3Upload = await upload('A', r3, 1, 'r3.pdf', syntheticPdf('r3')).catch(outcomeOf);
    const r4Upload = await upload('A', r4, 1, 'r4.pdf', syntheticPdf('r4')).catch(outcomeOf);
    const r4Row = attachmentsOf(r4)[0];
    const beforeDelete = storageRows().length;
    const deleted = await outcome(
      client('A').mutation(looseMutation('requests:remove'), {
        applicationId: appOne(),
        requestId: r3,
        expectedRevision: typeof r3Upload === 'object' ? r3Upload.revision : 2,
      }),
    );
    check(
      'FILE-08.draft-delete-removes-only-its-files',
      { deleted: null, r3Rows: 0, r3Events: 0, r4Rows: 1, r4Blob: true, blobsRemoved: 1, r4Upload: true },
      {
        deleted,
        r3Rows: attachmentsOf(r3).length,
        r3Events: rowsOf('attachmentEvents').filter((row) => row.requestId === r3).length,
        r4Rows: attachmentsOf(r4).length,
        r4Blob: storageRows().some((row) => row._id === r4Row?.storageId),
        blobsRemoved: beforeDelete - storageRows().length,
        r4Upload: typeof r4Upload === 'object',
      },
    );

    // FILE-07: a blob left by an upload that stopped between storing and linking is found and swept.
    const beforeOrphan = storageRows().length;
    const orphanStored = await outcome(
      Promise.resolve().then(() => {
        convexCli(envFile, ['run', 'fixtures:storeOrphanFile', JSON.stringify({ text: `%PDF-1.4 orphan ${runId}` })]);
        return 'stored';
      }),
    );
    const withOrphan = storageRows().length;
    const sweepRun = (args: Record<string, unknown>) =>
      outcome(
        Promise.resolve().then(() =>
          runInternal<{ deleted: number; isDone: boolean }>(envFile, 'requestAttachments:sweepOrphans', args),
        ),
      );
    const withinGrace = await sweepRun({ cursor: null });
    const swept = await outcome(
      Promise.resolve().then(() =>
        runInternal<{ deleted: number; isDone: boolean }>(envFile, 'requestAttachments:sweepOrphans', {
          cursor: null,
          olderThanMs: 0,
        }),
      ),
    );
    check(
      'FILE-07.orphan-blob-swept',
      { stored: 'stored', added: 1, keptInsideGrace: 0, deleted: 1, isDone: true, remaining: beforeOrphan },
      {
        stored: orphanStored,
        added: withOrphan - beforeOrphan,
        keptInsideGrace: typeof withinGrace === 'object' && withinGrace !== null ? withinGrace.deleted : withinGrace,
        deleted: typeof swept === 'object' && swept !== null ? swept.deleted : swept,
        isDone: typeof swept === 'object' && swept !== null ? swept.isDone : swept,
        remaining: storageRows().length,
      },
    );
    evidence.sweep = { graceMs: ORPHAN_GRACE_MS, cadence: 'every 30 minutes (convex/crons.ts)' };

    if (mode === 'full') {
      browser = await chromium.launch({ channel: 'chrome' });
      const activeBrowser = browser;
      const openSession = async (key: ActorKey, locale: Locale, name: string, dropUploads?: { next: boolean }) => {
        const context = await activeBrowser.newContext({
          locale,
          viewport,
          acceptDownloads: true,
          recordVideo: { dir: artifactsDir, size: viewport },
        });
        const page = await context.newPage();
        await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
        if (dropUploads) {
          // Drops the next upload frame and closes the socket, the way a lost connection interrupts an upload.
          await page.routeWebSocket(/\/sync$/, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              if (dropUploads.next && isUploadFrame(message)) {
                dropUploads.next = false;
                Promise.all([socket.close({ code: 4000, reason: 'interrupted by the journey' }), server.close()]).catch(
                  (error: unknown) => console.error(`Could not interrupt the socket: ${errorMessage(error)}`),
                );
                return;
              }
              server.send(message);
            });
          });
        }
        page.setDefaultTimeout(20_000);
        const errors: string[] = [];
        const consoleLines: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          consoleLines.push(`${message.type()}: ${message.text()}`);
          if (message.type() === 'error' && !/\[CONVEX A\(requestAttachments:|WebSocket/.test(message.text())) {
            errors.push(message.text());
          }
        });
        const text = texts[locale];
        await page.goto(appUrl);
        await keyboardInput(page, page.getByLabel(text.email, { exact: true }), actor(key).email);
        await keyboardInput(page, page.getByLabel(text.password, { exact: true }), password);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: text.signOut }).waitFor();
        return { context, page, errors, consoleLines, name, locale };
      };
      type Session = Awaited<ReturnType<typeof openSession>>;
      const closeSession = async (session: Session) => {
        writeFileSync(join(artifactsDir, `${session.name}-console.log`), `${session.consoleLines.join('\n')}\n`);
        const video = session.page.video();
        await session.context.close();
        if (video) renameSync(await video.path(), join(artifactsDir, `${session.name}.webm`));
      };
      const capture = async (session: Session, step: string) => {
        await session.page.locator('button.ant-btn-loading').first().waitFor({ state: 'hidden' });
        await session.page.screenshot({
          path: join(artifactsDir, `${session.name}-${step}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      };
      const openRequests = async (page: Page, locale: Locale) => {
        const target = page.getByRole('tab', { name: texts[locale].requestsTab });
        await target.waitFor();
        await keyboardFocus(page, page.getByRole('tab', { selected: true }));
        for (let presses = 0; presses < 5; presses += 1) {
          if (await target.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: `${texts[locale].requestsTab} · Leave requests` }).waitFor();
      };
      const chooseRadio = async (page: Page, name: string) => {
        const radio = page.getByRole('radio', { name, exact: true });
        if (await radio.isChecked()) return;
        const group = radio.locator('xpath=ancestor::*[@role="radiogroup"][1]');
        await group.waitFor();
        for (let presses = 0; presses < 250; presses += 1) {
          const inside = await group.evaluate(
            (element) => element !== document.activeElement && element.contains(document.activeElement),
          );
          if (inside) break;
          await page.keyboard.press('Tab');
        }
        for (let presses = 0; presses < 4 && !(await radio.isChecked()); presses += 1) {
          await page.keyboard.press('ArrowRight');
        }
        assert(await radio.isChecked(), `Keyboard could not select ${name}`);
      };
      const dialogOf = (page: Page) => page.getByRole('dialog');
      const rowWith = (page: Page, value: string) => page.getByRole('row').filter({ hasText: value });
      const button = (scope: Page | Locator, name: string) => scope.getByRole('button', { name, exact: true });
      const evidenceSection = (page: Page, locale: Locale) =>
        dialogOf(page).getByRole('region', { name: texts[locale].field, exact: true });
      const fileItems = (page: Page, locale: Locale) => evidenceSection(page, locale).getByRole('listitem');
      const openRow = async (page: Page, locale: Locale, startDate: string) => {
        await keyboardActivate(page, rowWith(page, startDate).getByRole('button', { name: texts[locale].openRow }));
        await dialogOf(page).waitFor();
        await page.waitForFunction(() => Boolean(document.activeElement?.closest('.ant-modal-wrap')));
      };
      const closeDialog = async (page: Page) => {
        await page.waitForFunction(() => Boolean(document.activeElement?.closest('.ant-modal-wrap')));
        await page.keyboard.press('Escape');
        await dialogOf(page).waitFor({ state: 'hidden' });
      };
      const createDraft = async (session: Session, startDate: string, reason: string) => {
        const { page, locale } = session;
        const text = texts[locale];
        const dialog = dialogOf(page);
        await keyboardActivate(page, button(page, text.newRequest));
        await keyboardDate(
          page,
          dialog.getByLabel(text.labels.startDate, { exact: true }),
          startDate.replaceAll('-', ''),
        );
        await keyboardDate(
          page,
          dialog.getByLabel(text.labels.endDate, { exact: true }),
          startDate.replaceAll('-', ''),
        );
        await keyboardInput(page, dialog.getByLabel(text.labels.days, { exact: true }), '1');
        await keyboardInput(page, dialog.getByLabel(text.labels.reason, { exact: true }), reason);
        await keyboardActivate(page, button(dialog, text.save));
        await page.locator('output').getByText(text.created(1), { exact: true }).waitFor();
        await rowWith(page, startDate).waitFor();
      };
      const attachByKeyboard = async (
        page: Page,
        locale: Locale,
        name: string,
        mimeType: string,
        bytes: Uint8Array,
      ) => {
        const chooser = page.waitForEvent('filechooser');
        await keyboardActivate(page, dialogOf(page).getByRole('button', { name: texts[locale].attachTo, exact: true }));
        await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(bytes) });
      };
      const downloadByKeyboard = async (page: Page, locale: Locale, name: string) => {
        const pending = page.waitForEvent('download');
        await keyboardActivate(
          page,
          dialogOf(page).getByRole('button', { name: texts[locale].download(name), exact: true }),
        );
        const file = await pending;
        const path = await file.path();
        const bytes = readFileSync(path);
        return { suggested: file.suggestedFilename(), sha256: sha256Hex(bytes), size: bytes.byteLength };
      };
      const requestByDate = (startDate: string) =>
        rowsOf('requests').find(
          (row) =>
            row.requesterMembershipId === membership('A').membershipId &&
            (row.values as Row | undefined)?.startDate === startDate,
        );

      for (const locale of ['en-US', 'zh-CN'] as const) {
        const text = texts[locale];
        const tag = locale === 'en-US' ? 'en' : 'zh';
        const dropUploads = { next: false };
        const requester = await openSession('A', locale, `${locale}-requester`, dropUploads);
        const sessions: Session[] = [requester];
        try {
          const { page } = requester;
          await openRequests(page, locale);
          await createDraft(requester, text.dates.first, `Clinic ${tag}`);
          await openRow(page, locale, text.dates.first);
          const evidencePdf = syntheticPdf(`ui-${tag}`, 6000);
          const evidenceHash = sha256Hex(evidencePdf);

          // An oversize file is refused in the browser before any byte is sent.
          await attachByKeyboard(
            page,
            locale,
            'too-big.pdf',
            'application/pdf',
            syntheticPdf('ui-big', MAX_ATTACHMENT_BYTES + 1),
          );
          const tooLarge = evidenceSection(page, locale).getByRole('alert').filter({ hasText: text.tooLarge });
          await tooLarge.waitFor();
          await capture(requester, '1-too-large-refused');

          await attachByKeyboard(page, locale, text.fileName, 'application/pdf', evidencePdf);
          await evidenceSection(page, locale)
            .locator('output')
            .getByText(text.attached(text.fileName, 2), { exact: true })
            .waitFor();
          await attachByKeyboard(page, locale, text.extraName, 'image/png', syntheticPng(512));
          await evidenceSection(page, locale)
            .locator('output')
            .getByText(text.attached(text.extraName, 3), { exact: true })
            .waitFor();
          await keyboardActivate(
            page,
            dialogOf(page).getByRole('button', { name: text.remove(text.extraName), exact: true }),
          );
          await keyboardActivate(
            page,
            dialogOf(page).locator('.ant-popconfirm').getByRole('button', { name: text.removeOk, exact: true }),
          );
          await evidenceSection(page, locale)
            .locator('output')
            .getByText(text.removed(text.extraName, 4), { exact: true })
            .waitFor();
          await capture(requester, '2-attached');
          const draftId = String(requestByDate(text.dates.first)?._id);
          labels.set(draftId, `<request:ui-${tag}>`);
          must(
            `ui.${tag}.attach-and-remove-persist`,
            {
              revision: 4,
              files: [[text.fileName, evidencePdf.byteLength, evidenceHash]],
              events: ['attach', 'attach', 'remove'],
            },
            {
              revision: rowsOf('requests').find((row) => row._id === draftId)?.revision,
              files: attachmentsOf(draftId).map((row) => [row.fileName, row.size, row.sha256]),
              events: rowsOf('attachmentEvents')
                .filter((row) => row.requestId === draftId)
                .map((row) => row.kind),
            },
          );

          // Reload: the file comes back from the backend with its name, size and hash.
          await page.reload();
          await openRequests(page, locale);
          await openRow(page, locale, text.dates.first);
          await fileItems(page, locale).first().waitFor();
          must(
            `ui.${tag}.file-listed-after-reload`,
            [[text.fileName, text.meta(formatKb(evidencePdf.byteLength, locale), evidenceHash.slice(0, 12))]],
            await fileItems(page, locale).evaluateAll((items) =>
              items.map((item) => [
                item.querySelector('strong')?.textContent ?? '',
                item.querySelector('.ant-typography-secondary')?.textContent ?? '',
              ]),
            ),
          );
          const own = await downloadByKeyboard(page, locale, text.fileName);
          must(
            `ui.${tag}.requester-download-matches`,
            { suggested: text.fileName, sha256: evidenceHash },
            {
              suggested: own.suggested,
              sha256: own.sha256,
            },
          );
          await capture(requester, '3-after-reload');
          await keyboardActivate(page, button(dialogOf(page), text.submit));
          await page.locator('output').getByText(text.submitted(5), { exact: true }).waitFor();

          // The assigned reviewer retrieves the same bytes; a reader sees the request but not its files.
          const reviewer = await openSession('B', locale, `${locale}-reviewer`);
          sessions.push(reviewer);
          await openRequests(reviewer.page, locale);
          await chooseRadio(reviewer.page, text.assigned);
          await rowWith(reviewer.page, text.dates.first).waitFor();
          await openRow(reviewer.page, locale, text.dates.first);
          await fileItems(reviewer.page, locale).first().waitFor();
          const reviewed = await downloadByKeyboard(reviewer.page, locale, text.fileName);
          must(
            `ui.${tag}.reviewer-download-matches-and-is-read-only`,
            { sha256: evidenceHash, attach: 0, remove: 0 },
            {
              sha256: reviewed.sha256,
              attach: await dialogOf(reviewer.page).getByRole('button', { name: text.attachTo }).count(),
              remove: await dialogOf(reviewer.page)
                .getByRole('button', { name: text.remove(text.fileName) })
                .count(),
            },
          );
          await capture(reviewer, '1-reviewer-download');
          await closeDialog(reviewer.page);

          const reader = await openSession('R', locale, `${locale}-reader`);
          sessions.push(reader);
          await openRequests(reader.page, locale);
          await rowWith(reader.page, text.dates.first).waitFor();
          await openRow(reader.page, locale, text.dates.first);
          await evidenceSection(reader.page, locale).getByText(text.none, { exact: true }).waitFor();
          must(
            `ui.${tag}.reader-sees-no-files`,
            { items: 0, downloads: 0 },
            {
              items: await fileItems(reader.page, locale).count(),
              downloads: await dialogOf(reader.page)
                .getByRole('button', { name: text.download(text.fileName) })
                .count(),
            },
          );
          await capture(reader, '1-reader-no-files');
          await closeDialog(reader.page);

          // An upload interrupted by a lost connection shows an alert and leaves no attachment and no blob. Submitting
          // closed the requester's dialog.
          await createDraft(requester, text.dates.interrupted, `Interrupted ${tag}`);
          await openRow(page, locale, text.dates.interrupted);
          const blobsBeforeInterrupt = storageRows().length;
          dropUploads.next = true;
          await attachByKeyboard(page, locale, 'interrupted.pdf', 'application/pdf', syntheticPdf(`cut-${tag}`));
          await evidenceSection(page, locale).getByRole('alert').filter({ hasText: text.interrupted }).waitFor();
          await capture(requester, '4-interrupted');
          await page.reload();
          await openRequests(page, locale);
          await openRow(page, locale, text.dates.interrupted);
          await evidenceSection(page, locale).getByText(text.none, { exact: true }).waitFor();
          const interruptedId = String(requestByDate(text.dates.interrupted)?._id);
          labels.set(interruptedId, `<request:ui-${tag}-interrupted>`);
          must(
            `ui.${tag}.interrupted-upload-leaves-nothing`,
            { rows: 0, events: 0, revision: 1, blobsAdded: 0 },
            {
              rows: attachmentsOf(interruptedId).length,
              events: rowsOf('attachmentEvents').filter((row) => row.requestId === interruptedId).length,
              revision: rowsOf('requests').find((row) => row._id === interruptedId)?.revision,
              blobsAdded: storageRows().length - blobsBeforeInterrupt,
            },
          );
          await capture(requester, '5-after-interrupted-reload');
          await closeDialog(page);
          must(
            `ui.${tag}.no-page-errors`,
            { requester: [], reviewer: [], reader: [] },
            {
              requester: requester.errors,
              reviewer: reviewer.errors,
              reader: reader.errors,
            },
          );
        } catch (error) {
          await Promise.all(
            sessions.map((session) =>
              session.page
                .screenshot({ path: join(artifactsDir, `${session.name}-failure.png`), fullPage: true })
                .catch(() => undefined),
            ),
          );
          throw error;
        } finally {
          for (const session of sessions) await closeSession(session);
        }
      }
    }

    // AUDIT-01: events carry the actor and file metadata, never bytes, storage ids or links.
    const events = rowsOf('attachmentEvents');
    const serialized = JSON.stringify(events);
    check(
      'AUDIT-01.events-carry-metadata-only',
      { everyEventHasActorAndHash: true, noStorageIds: true, noLinks: true, noPdfBytes: true },
      {
        everyEventHasActorAndHash: events.every(
          (event) => typeof event.actorMembershipId === 'string' && /^[0-9a-f]{64}$/.test(String(event.sha256)),
        ),
        noStorageIds:
          storageRows().every((row) => !serialized.includes(String(row._id))) && !serialized.includes('storageId'),
        noLinks: !/https?:\/\//.test(serialized),
        noPdfBytes: !serialized.includes('%PDF'),
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    await browser?.close();
  }

  // RECON-01: rows, blobs, files on disk, events and retrieved bytes agree before cleanup.
  const reconcile = (label: string, retrievedFiles: typeof retrieved) => {
    const result = reconcileAttachments({
      now: Date.now(),
      graceMs: ORPHAN_GRACE_MS,
      attachments: tableRows(envFile, 'requestAttachments').map((row) => ({
        _id: String(row._id),
        requestId: String(row.requestId),
        storageId: String(row.storageId),
        fileName: String(row.fileName),
        size: Number(row.size),
        sha256: String(row.sha256),
      })),
      events: tableRows(envFile, 'attachmentEvents')
        .sort((left, right) => Number(left._creationTime) - Number(right._creationTime))
        .map((row) => ({
          attachmentId: String(row.attachmentId),
          requestId: String(row.requestId),
          kind: String(row.kind),
          fileName: String(row.fileName),
          size: Number(row.size),
          sha256: String(row.sha256),
        })),
      storage: storageRows().map((row) => ({
        _id: String(row._id),
        _creationTime: Number(row._creationTime),
        size: Number(row.size),
        sha256: String(row.sha256),
      })),
      retrieved: retrievedFiles,
      diskFiles: diskFiles(join(filesDir, 'files')),
    });
    evidence[`reconcile.${label}`] = result;
    return result;
  };
  const before = reconcile('before-cleanup', retrieved);
  check('RECON-01.backend-and-files-agree', { ok: true, problems: [] }, { ok: before.ok, problems: before.problems });

  // CLEANUP-01: attachments go first, in bounded batches, then the organizations; nothing is left behind.
  for (const organizationKey of seededOrganizations) {
    try {
      const batches: unknown[] = [];
      for (let round = 0; round < 50; round += 1) {
        const batch = runInternal<{ isDone: boolean }>(envFile, 'fixtures:removeRequestAttachments', {
          organizationKey,
        });
        batches.push(batch);
        if (batch.isDone) break;
      }
      cleanup[`${organizationKey}.attachments`] = batches;
    } catch (error) {
      cleanup[`${organizationKey}.attachments`] = `failed: ${errorMessage(error)}`;
    }
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
  const after = reconcile('after-cleanup', []);
  check(
    'CLEANUP-01.no-rows-or-blobs-remain-and-disk-files-are-retained-deleted-blobs',
    { requests: 0, attachments: 0, events: 0, storage: 0, everyDiskFileRetained: true, memberships: 0, problems: [] },
    {
      requests: rowsOf('requests').length,
      attachments: after.counts.attachments,
      events: after.counts.events,
      storage: after.counts.storage,
      everyDiskFileRetained: after.counts.retainedDiskFiles === after.counts.diskFiles,
      memberships: tableRows(envFile, 'memberships').filter((row) => fixtureApplications.has(row.applicationId)).length,
      problems: after.problems,
    },
  );

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    mode,
    target: { convexUrl, siteUrl, appUrl },
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    error: failure === undefined ? null : normalize(errorMessage(failure)),
    checks,
    cleanup: normalize(cleanup),
  };
  writeFileSync(join(artifactsDir, `results-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(artifactsDir, `evidence-${mode}.json`),
    `${JSON.stringify(
      {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        ...evidence,
        retained: {
          betterAuthUsers: tableRows(envFile, 'user', 'betterAuth').length,
          betterAuthSessions: tableRows(envFile, 'session', 'betterAuth').length,
          storageBlobs: storageRows().length,
          diskFiles: after.counts.diskFiles,
          diskBytes: after.counts.retainedDiskBytes,
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Attachment journey (${mode}): ${report.summary.passed}/${report.summary.checks} checks passed.`);
  if (failure !== undefined || failed.length > 0) {
    if (failure !== undefined) console.error(`Attachment journey failed: ${errorMessage(failure)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`Attachment journey failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
