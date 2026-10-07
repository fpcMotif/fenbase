import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_EVENTS_PER_REQUEST, ORPHAN_GRACE_MS } from '../attachmentModel';
import { removeOrganization, removeRequestAttachments } from '../fixtures';
import {
  attach,
  authorizeDownload,
  authorizeUpload,
  download,
  list,
  remove,
  sweepOrphans,
  upload,
} from '../requestAttachments';
import { approve, submit } from '../requestReviews';
import { create, remove as removeRequest } from '../requests';
import { createActionContext, invokeHandler, type ActionTestContext, type TestContext } from './helpers.support';
import { JPEG_BYTES, PDF_BYTES, PNG_BYTES, bytesOf, hexSha256, toArrayBuffer } from './attachmentFixture.support';
import {
  APP_1,
  APP_2,
  EVIDENCE_MAX_BYTES,
  V1,
  fixtureContext,
  leave,
  rejectionData,
  type Preset,
} from './requestFixture.support';

const auth = vi.hoisted(() => ({ currentUser: null as string | null }));

vi.mock('../auth', () => ({
  requireUser: async () => {
    if (auth.currentUser === null) throw new ConvexError('Unauthenticated');
    return auth.currentUser;
  },
}));

function signIn(authUserId: string | null): void {
  auth.currentUser = authUserId;
}

beforeEach(() => signIn(null));

let operationCounter = 0;
function nextOperationId(): string {
  operationCounter += 1;
  return `att-${String(operationCounter).padStart(6, '0')}`;
}

type Uploaded = {
  attachmentId: string;
  revision: number;
  replayed: boolean;
  fileName: string;
  size: number;
  contentType: string;
  sha256: string;
};
type Downloaded = { fileName: string; contentType: string; size: number; sha256: string; bytes: ArrayBuffer };
type AttachmentView = { _id: string; fieldKey: string; fileName: string; size: number; contentType: string };

const registry = {
  'requestAttachments:authorizeUpload': authorizeUpload,
  'requestAttachments:attach': attach,
  'requestAttachments:authorizeDownload': authorizeDownload,
};

function setup(options: { preset?: Preset; required?: boolean } = {}) {
  const ctx = fixtureContext({ app1Preset: options.preset, evidence: { required: options.required ?? false } });
  return { ctx, action: createActionContext(ctx, registry) };
}

async function draftAs(ctx: TestContext, user: string) {
  signIn(user);
  return (await invokeHandler(create, ctx, {
    applicationId: APP_1,
    definitionVersionId: V1,
    operationId: nextOperationId(),
    values: leave,
  })) as { requestId: string; revision: number };
}

type UploadOptions = {
  fileName?: string;
  bytes?: Uint8Array;
  fieldKey?: string;
  operationId?: string;
  applicationId?: string;
};

function uploadAs(
  action: ActionTestContext,
  user: string | null,
  requestId: string,
  expectedRevision: number,
  options: UploadOptions = {},
) {
  signIn(user);
  return invokeHandler(upload, action, {
    applicationId: options.applicationId ?? APP_1,
    requestId,
    fieldKey: options.fieldKey ?? 'supportingDocument',
    fileName: options.fileName ?? 'medical-note.pdf',
    bytes: toArrayBuffer(options.bytes ?? PDF_BYTES),
    expectedRevision,
    operationId: options.operationId ?? nextOperationId(),
  }) as Promise<Uploaded>;
}

function downloadAs(action: ActionTestContext, user: string | null, attachmentId: string, applicationId = APP_1) {
  signIn(user);
  return invokeHandler(download, action, { applicationId, attachmentId }) as Promise<Downloaded>;
}

function listAs(ctx: TestContext, user: string | null, requestId: string) {
  signIn(user);
  return invokeHandler(list, ctx, { applicationId: APP_1, requestId }) as Promise<AttachmentView[] | null>;
}

function removeAs(
  ctx: TestContext,
  user: string | null,
  requestId: string,
  attachmentId: string,
  expectedRevision: number,
  operationId = nextOperationId(),
) {
  signIn(user);
  return invokeHandler(remove, ctx, {
    applicationId: APP_1,
    requestId,
    attachmentId,
    expectedRevision,
    operationId,
  }) as Promise<{ revision: number; replayed: boolean }>;
}

function deleteDraftAs(ctx: TestContext, user: string, requestId: string, expectedRevision: number) {
  signIn(user);
  return invokeHandler(removeRequest, ctx, { applicationId: APP_1, requestId, expectedRevision });
}

async function command(
  ctx: TestContext,
  fn: typeof submit | typeof approve,
  user: string,
  requestId: string,
  expectedRevision: number,
) {
  signIn(user);
  return (await invokeHandler(fn, ctx, {
    applicationId: APP_1,
    requestId,
    expectedRevision,
    operationId: nextOperationId(),
  })) as { revision: number };
}

async function expectCode(operation: Promise<unknown>, code: string) {
  expect(await rejectionData(operation)).toMatchObject({ code });
}

function snapshot(ctx: TestContext): string {
  return JSON.stringify([
    ctx.rows('requests'),
    ctx.rows('requestAttachments'),
    ctx.rows('attachmentEvents'),
    [...ctx.files.keys()],
  ]);
}

async function expectDenied(ctx: TestContext, operation: () => Promise<unknown>, code: string) {
  const before = snapshot(ctx);
  const writesBefore = ctx.writes.length;
  if (code === 'Unauthenticated') await expect(operation()).rejects.toThrow('Unauthenticated');
  else await expectCode(operation(), code);
  expect(ctx.writes.slice(writesBefore)).toEqual([]);
  expect(snapshot(ctx)).toBe(before);
}

async function draftWithFile(ctx: TestContext, action: ActionTestContext, user = 'user-a') {
  const { requestId } = await draftAs(ctx, user);
  const uploaded = await uploadAs(action, user, requestId, 1);
  return { requestId, attachmentId: uploaded.attachmentId, revision: uploaded.revision };
}

async function pendingWithFile(ctx: TestContext, action: ActionTestContext) {
  const draft = await draftWithFile(ctx, action);
  const submitted = await command(ctx, submit, 'user-a', draft.requestId, draft.revision);
  return { ...draft, revision: submitted.revision };
}

function setGrants(ctx: TestContext, membershipId: string, grants: string[], status = 'active') {
  return ctx.db.patch(membershipId, { grants, status });
}

describe('uploading evidence to a draft', () => {
  it('stores the bytes, links one attachment owned by the caller, raises the revision and audits the metadata', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');

    const result = await uploadAs(action, 'user-a', requestId, 1, { fileName: '../病假证明.pdf' });

    const sha256 = await hexSha256(PDF_BYTES);
    expect(result).toEqual({
      attachmentId: expect.any(String),
      revision: 2,
      replayed: false,
      fileName: '病假证明.pdf',
      size: PDF_BYTES.byteLength,
      contentType: 'application/pdf',
      sha256,
    });
    const [row] = ctx.rows('requestAttachments');
    expect(row).toMatchObject({
      _id: result.attachmentId,
      requestId,
      applicationId: APP_1,
      fieldKey: 'supportingDocument',
      uploaderMembershipId: 'memberships:a',
      fileName: '病假证明.pdf',
      size: PDF_BYTES.byteLength,
      contentType: 'application/pdf',
      sha256,
    });
    expect(ctx.files.get(String(row.storageId))?.sha256).toBe(sha256);
    expect(ctx.read('requests', requestId)).toMatchObject({ revision: 2 });
    expect(ctx.rows('attachmentEvents')).toEqual([
      expect.objectContaining({
        requestId,
        actorMembershipId: 'memberships:a',
        kind: 'attach',
        attachmentId: result.attachmentId,
        fieldKey: 'supportingDocument',
        fileName: '病假证明.pdf',
        size: PDF_BYTES.byteLength,
        sha256,
        contentType: 'application/pdf',
        revision: 2,
      }),
    ]);
    expect(ctx.rows('requestEvents')).toEqual([]);
  });

  it('lets the requester list and retrieve the same bytes without exposing the storage id', async () => {
    const { ctx, action } = setup();
    const { requestId, attachmentId } = await draftWithFile(ctx, action);

    const views = await listAs(ctx, 'user-a', requestId);
    expect(views).toEqual([
      {
        _id: attachmentId,
        fieldKey: 'supportingDocument',
        fileName: 'medical-note.pdf',
        size: PDF_BYTES.byteLength,
        contentType: 'application/pdf',
        sha256: await hexSha256(PDF_BYTES),
        createdAt: expect.any(Number),
      },
    ]);
    const downloaded = await downloadAs(action, 'user-a', attachmentId);
    expect(new Uint8Array(downloaded.bytes)).toEqual(PDF_BYTES);
    expect(downloaded).toMatchObject({ fileName: 'medical-note.pdf', sha256: await hexSha256(PDF_BYTES) });
  });

  it.each([
    ['a PNG', 'scan.png', PNG_BYTES, 'image/png'],
    ['a JPEG', 'photo.jpeg', JPEG_BYTES, 'image/jpeg'],
  ])('accepts %s', async (_label, fileName, bytes, contentType) => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    expect(await uploadAs(action, 'user-a', requestId, 1, { fileName, bytes })).toMatchObject({ contentType });
  });

  it('accepts a file of exactly the field limit and refuses one byte more', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    const atLimit = new Uint8Array(EVIDENCE_MAX_BYTES);
    atLimit.set(PDF_BYTES);
    const overLimit = new Uint8Array(EVIDENCE_MAX_BYTES + 1);
    overLimit.set(PDF_BYTES);

    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', requestId, 1, { bytes: overLimit }),
      'ATTACHMENT_TOO_LARGE',
    );
    expect(await uploadAs(action, 'user-a', requestId, 1, { bytes: atLimit })).toMatchObject({
      size: EVIDENCE_MAX_BYTES,
    });
  });

  it.each([
    ['HTML renamed to .pdf', 'invoice.pdf', bytesOf('<!doctype html><script>alert(1)</script>')],
    ['SVG renamed to .png', 'logo.png', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a PNG named .pdf', 'scan.pdf', PNG_BYTES],
    ['a PDF without an extension', 'medical-note', PDF_BYTES],
    ['an empty file', 'empty.pdf', new Uint8Array()],
  ])('refuses %s without storing anything', async (_label, fileName, bytes) => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', requestId, 1, { fileName, bytes }),
      'ATTACHMENT_TYPE_NOT_ALLOWED',
    );
  });

  it('refuses a file name with nothing usable left', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', requestId, 1, { fileName: '../\u0000.' }),
      'ATTACHMENT_NAME_INVALID',
    );
  });

  it('refuses an unknown field and a field that is not an attachment field', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    for (const fieldKey of ['passport', 'reason']) {
      await expectDenied(ctx, () => uploadAs(action, 'user-a', requestId, 1, { fieldKey }), 'RECORD_FIELD_UNKNOWN');
    }
  });

  it('refuses a third file in a field that holds two', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await uploadAs(action, 'user-a', requestId, 1);
    await uploadAs(action, 'user-a', requestId, 2, { fileName: 'scan.png', bytes: PNG_BYTES });
    await expectDenied(ctx, () => uploadAs(action, 'user-a', requestId, 3), 'ATTACHMENT_LIMIT_REACHED');
  });

  it('stops attaching once a draft has used its attachment event budget', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    let revision = 1;
    for (let index = 0; index < MAX_ATTACHMENT_EVENTS_PER_REQUEST / 2; index += 1) {
      const uploaded = await uploadAs(action, 'user-a', requestId, revision);
      revision = (await removeAs(ctx, 'user-a', requestId, uploaded.attachmentId, uploaded.revision)).revision;
    }
    expect(ctx.rows('attachmentEvents')).toHaveLength(MAX_ATTACHMENT_EVENTS_PER_REQUEST);
    await expectDenied(ctx, () => uploadAs(action, 'user-a', requestId, revision), 'ATTACHMENT_LIMIT_REACHED');
  });

  it('refuses a stale revision with the current one', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await uploadAs(action, 'user-a', requestId, 1);
    await expectDenied(ctx, () => uploadAs(action, 'user-a', requestId, 1), 'RECORD_REVISION_CONFLICT');
  });

  it.each<[string, string | null, string]>([
    ['a signed-out caller', null, 'Unauthenticated'],
    ['another requester', 'user-a2', 'RECORD_NOT_FOUND'],
    ['the reviewer of the form', 'user-b', 'RECORD_NOT_FOUND'],
    ['a builder', 'user-c', 'RECORD_NOT_FOUND'],
    ['a reader', 'user-r', 'RECORD_NOT_FOUND'],
    ['a member without grants', 'user-n', 'RECORD_NOT_FOUND'],
    ['an inactive member', 'user-i', 'APPLICATION_ACCESS_DENIED'],
    ['a member of another organization', 'user-z', 'APPLICATION_ACCESS_DENIED'],
  ])('refuses %s an upload to the draft without storing anything', async (_label, user, code) => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(ctx, () => uploadAs(action, user, requestId, 1), code);
  });

  it('refuses the requester once they lose submitRequests', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await setGrants(ctx, 'memberships:a', []);
    await expectDenied(ctx, () => uploadAs(action, 'user-a', requestId, 1), 'PERMISSION_DENIED');
  });

  it('refuses a request of another application named through an application the caller belongs to', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', requestId, 1, { applicationId: APP_2 }),
      'RECORD_NOT_FOUND',
    );
  });
});

describe('replaying an upload', () => {
  it('returns the first attachment and stores no second blob', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    const first = await uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0001' });
    const writesBefore = ctx.writes.length;

    const again = await uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0001' });

    expect(again).toEqual({ ...first, replayed: true });
    expect(ctx.writes.slice(writesBefore)).toEqual([]);
    expect(ctx.files.size).toBe(1);
  });

  it('refuses the same operation id for a different file', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0002' });
    await expectDenied(
      ctx,
      () =>
        uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0002', bytes: PNG_BYTES, fileName: 'a.png' }),
      'RECORD_OPERATION_CONFLICT',
    );
  });

  it('checks access again before replaying', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    await uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0003' });
    await setGrants(ctx, 'memberships:a', ['submitRequests'], 'inactive');
    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', requestId, 1, { operationId: 'upload-0003' }),
      'APPLICATION_ACCESS_DENIED',
    );
  });
});

describe('a failed upload', () => {
  it('deletes the stored blob when linking fails, so no attachment and no file remain', async () => {
    const ctx = fixtureContext({ evidence: { required: false } });
    const failing = createActionContext(ctx, {
      ...registry,
      'requestAttachments:attach': () => Promise.reject(new Error('link interrupted')),
    });
    const { requestId } = await draftAs(ctx, 'user-a');

    await expect(uploadAs(failing, 'user-a', requestId, 1)).rejects.toThrow('link interrupted');

    expect(ctx.files.size).toBe(0);
    expect(ctx.rows('requestAttachments')).toEqual([]);
    expect(ctx.rows('attachmentEvents')).toEqual([]);
    expect(ctx.read('requests', requestId)).toMatchObject({ revision: 1 });
  });

  it('refuses to link a blob whose stored size or hash differs from what the action measured', async () => {
    const { ctx, action } = setup();
    const { requestId } = await draftAs(ctx, 'user-a');
    const storageId = await action.storage.store(new Blob([PNG_BYTES.slice()]));
    signIn('user-a');
    await expect(
      invokeHandler(attach, ctx, {
        applicationId: APP_1,
        requestId,
        fieldKey: 'supportingDocument',
        expectedRevision: 1,
        operationId: nextOperationId(),
        fingerprint: 'f',
        storageId,
        fileName: 'medical-note.pdf',
        contentType: 'application/pdf',
        size: PDF_BYTES.byteLength,
        sha256: await hexSha256(PDF_BYTES),
      }),
    ).rejects.toThrow(/storage/i);
    expect(ctx.rows('requestAttachments')).toEqual([]);
  });

  it('refuses to link a blob that already belongs to an attachment', async () => {
    const { ctx, action } = setup();
    const { requestId, revision } = await draftWithFile(ctx, action);
    const [row] = ctx.rows('requestAttachments');
    signIn('user-a');
    await expect(
      invokeHandler(attach, ctx, {
        applicationId: APP_1,
        requestId,
        fieldKey: 'supportingDocument',
        expectedRevision: revision,
        operationId: nextOperationId(),
        fingerprint: 'f',
        storageId: row.storageId,
        fileName: 'copy.pdf',
        contentType: 'application/pdf',
        size: row.size,
        sha256: row.sha256,
      }),
    ).rejects.toThrow(/already/i);
    expect(ctx.rows('requestAttachments')).toHaveLength(1);
  });
});

describe('removing evidence from a draft', () => {
  it('deletes the row and its blob, raises the revision, audits the removal and replays', async () => {
    const { ctx, action } = setup();
    const { requestId, attachmentId, revision } = await draftWithFile(ctx, action);

    expect(await removeAs(ctx, 'user-a', requestId, attachmentId, revision, 'remove-0001')).toEqual({
      revision: 3,
      replayed: false,
    });

    expect(ctx.rows('requestAttachments')).toEqual([]);
    expect(ctx.files.size).toBe(0);
    expect(ctx.read('requests', requestId)).toMatchObject({ revision: 3 });
    expect(ctx.rows('attachmentEvents').map((event) => [event.kind, event.revision, event.actorMembershipId])).toEqual([
      ['attach', 2, 'memberships:a'],
      ['remove', 3, 'memberships:a'],
    ]);
    expect(await removeAs(ctx, 'user-a', requestId, attachmentId, revision, 'remove-0001')).toEqual({
      revision: 3,
      replayed: true,
    });
  });

  it('refuses an attachment of another request, even one named through the caller’s own draft', async () => {
    const { ctx, action } = setup();
    const own = await draftAs(ctx, 'user-a');
    const foreign = await draftWithFile(ctx, action, 'user-a2');
    await expectDenied(ctx, () => removeAs(ctx, 'user-a', own.requestId, foreign.attachmentId, 1), 'RECORD_NOT_FOUND');
    await expectDenied(
      ctx,
      () => removeAs(ctx, 'user-a', foreign.requestId, foreign.attachmentId, foreign.revision),
      'RECORD_NOT_FOUND',
    );
  });
});

describe('submitted and decided evidence', () => {
  it('refuses a submit without a required attachment and accepts one with it', async () => {
    const { ctx, action } = setup({ required: true });
    const { requestId } = await draftAs(ctx, 'user-a');
    await expectDenied(ctx, () => command(ctx, submit, 'user-a', requestId, 1), 'ATTACHMENT_REQUIRED');
    await uploadAs(action, 'user-a', requestId, 1);
    expect(await command(ctx, submit, 'user-a', requestId, 2)).toMatchObject({ revision: 3 });
    expect(ctx.rows('requestEvents')).toEqual([expect.objectContaining({ command: 'submit', revision: 3 })]);
  });

  it('freezes the evidence once submitted and after a decision', async () => {
    const { ctx, action } = setup();
    const pending = await pendingWithFile(ctx, action);
    await expectDenied(
      ctx,
      () => uploadAs(action, 'user-a', pending.requestId, pending.revision),
      'REQUEST_STATE_CONFLICT',
    );
    await expectDenied(
      ctx,
      () => removeAs(ctx, 'user-a', pending.requestId, pending.attachmentId, pending.revision),
      'REQUEST_STATE_CONFLICT',
    );
    const approved = await command(ctx, approve, 'user-b', pending.requestId, pending.revision);
    await expectDenied(
      ctx,
      () => removeAs(ctx, 'user-a', pending.requestId, pending.attachmentId, approved.revision),
      'REQUEST_STATE_CONFLICT',
    );
    await expectDenied(
      ctx,
      () => deleteDraftAs(ctx, 'user-a', pending.requestId, approved.revision),
      'REQUEST_STATE_CONFLICT',
    );
  });
});

describe('who can read evidence', () => {
  it('keeps a draft’s evidence to its requester', async () => {
    const { ctx, action } = setup();
    const { requestId, attachmentId } = await draftWithFile(ctx, action);
    expect(await listAs(ctx, 'user-a', requestId)).toHaveLength(1);
    for (const user of ['user-a2', 'user-b', 'user-c', 'user-r', 'user-n']) {
      expect(await listAs(ctx, user, requestId)).toBeNull();
      await expectCode(downloadAs(action, user, attachmentId), 'RECORD_NOT_FOUND');
    }
  });

  it.each(['pending', 'approved'])('lets the requester and the assigned reviewer read %s evidence', async (state) => {
    const { ctx, action } = setup();
    const pending = await pendingWithFile(ctx, action);
    if (state === 'approved') await command(ctx, approve, 'user-b', pending.requestId, pending.revision);
    for (const user of ['user-a', 'user-b']) {
      expect(await listAs(ctx, user, pending.requestId)).toHaveLength(1);
      expect(new Uint8Array((await downloadAs(action, user, pending.attachmentId)).bytes)).toEqual(PDF_BYTES);
    }
  });

  it.each<[string, string | null, string]>([
    ['a reviewer who is not assigned', 'user-v', 'RECORD_NOT_FOUND'],
    ['another requester', 'user-a2', 'RECORD_NOT_FOUND'],
    ['a builder', 'user-c', 'RECORD_NOT_FOUND'],
    ['an inactive member', 'user-i', 'APPLICATION_ACCESS_DENIED'],
    ['a member of another organization', 'user-z', 'APPLICATION_ACCESS_DENIED'],
    ['a signed-out caller', null, 'Unauthenticated'],
  ])('refuses %s a submitted request’s evidence', async (_label, user, code) => {
    const { ctx, action } = setup();
    const pending = await pendingWithFile(ctx, action);
    if (code === 'Unauthenticated') {
      await expect(downloadAs(action, user, pending.attachmentId)).rejects.toThrow('Unauthenticated');
      await expect(listAs(ctx, user, pending.requestId)).rejects.toThrow('Unauthenticated');
      return;
    }
    await expectCode(downloadAs(action, user, pending.attachmentId), code);
    if (code === 'APPLICATION_ACCESS_DENIED') await expectCode(listAs(ctx, user, pending.requestId), code);
    else expect(await listAs(ctx, user, pending.requestId)).toBeNull();
  });

  it('shows a readers-preset holder the request but none of its files', async () => {
    const { ctx, action } = setup({ preset: 'requesterAssignedReviewerAndReaders' });
    const pending = await pendingWithFile(ctx, action);
    expect(await listAs(ctx, 'user-r', pending.requestId)).toEqual([]);
    await expectCode(downloadAs(action, 'user-r', pending.attachmentId), 'RECORD_NOT_FOUND');
  });

  it('denies the first retrieval after the reviewer loses the grant or the requester is deactivated', async () => {
    const { ctx, action } = setup();
    const pending = await pendingWithFile(ctx, action);
    await setGrants(ctx, 'memberships:b', ['submitRequests']);
    await expectCode(downloadAs(action, 'user-b', pending.attachmentId), 'RECORD_NOT_FOUND');
    await setGrants(ctx, 'memberships:a', ['submitRequests'], 'inactive');
    await expectCode(downloadAs(action, 'user-a', pending.attachmentId), 'APPLICATION_ACCESS_DENIED');
  });

  it('refuses an attachment named through another application', async () => {
    const { ctx, action } = setup();
    const { attachmentId } = await draftWithFile(ctx, action);
    await expectCode(downloadAs(action, 'user-a', attachmentId, APP_2), 'RECORD_NOT_FOUND');
  });

  it('never returns bytes that no longer match the stored hash', async () => {
    const { ctx, action } = setup();
    const { attachmentId } = await draftWithFile(ctx, action);
    const [row] = ctx.rows('requestAttachments');
    const file = ctx.files.get(String(row.storageId));
    if (!file) throw new Error('missing file');
    file.bytes = PNG_BYTES;
    await expect(downloadAs(action, 'user-a', attachmentId)).rejects.toThrow(/integrity/i);
  });
});

describe('deleting a draft', () => {
  it('removes its own files, rows and events and leaves another draft’s files', async () => {
    const { ctx, action } = setup();
    const doomed = await draftWithFile(ctx, action);
    const kept = await draftWithFile(ctx, action, 'user-a2');
    const keptRow = ctx.rows('requestAttachments').find((row) => row.requestId === kept.requestId);

    await deleteDraftAs(ctx, 'user-a', doomed.requestId, doomed.revision);

    expect(ctx.rows('requestAttachments')).toEqual([keptRow]);
    expect([...ctx.files.keys()]).toEqual([keptRow?.storageId]);
    expect(ctx.rows('attachmentEvents').map((event) => event.requestId)).toEqual([kept.requestId]);
  });
});

describe('the orphan sweep', () => {
  it('deletes only unlinked blobs older than the grace window', async () => {
    const { ctx, action } = setup();
    await draftWithFile(ctx, action);
    const linked = String(ctx.rows('requestAttachments')[0].storageId);
    const oldOrphan = await action.storage.store(new Blob([PDF_BYTES.slice()]));
    const freshOrphan = await action.storage.store(new Blob([PNG_BYTES.slice()]));
    for (const id of [oldOrphan, linked]) {
      const file = ctx.files.get(id);
      if (!file) throw new Error('missing file');
      file._creationTime = Date.now() - ORPHAN_GRACE_MS - 1000;
    }

    const result = await invokeHandler(sweepOrphans, ctx, { cursor: null });

    expect(result).toEqual({ scanned: 3, deleted: 1, isDone: true });
    expect([...ctx.files.keys()].sort()).toEqual([linked, freshOrphan].sort());
    expect(ctx.scheduled).toEqual([]);
  });

  it('works in bounded batches and schedules the rest', async () => {
    const { ctx, action } = setup();
    for (let index = 0; index < 3; index += 1) await action.storage.store(new Blob([PDF_BYTES.slice()]));
    for (const file of ctx.files.values()) file._creationTime -= 60_000;

    const result = await invokeHandler(sweepOrphans, ctx, { cursor: null, olderThanMs: 0, limit: 2 });

    expect(result).toEqual({ scanned: 2, deleted: 2, isDone: false });
    expect(ctx.scheduled).toEqual([
      {
        delayMs: 0,
        name: 'requestAttachments:sweepOrphans',
        args: { cursor: expect.any(String), olderThanMs: 0, limit: 2 },
      },
    ]);
  });
});

describe('the audit trail', () => {
  it('records actor and file metadata, never contents, storage ids or links', async () => {
    const { ctx, action } = setup();
    const { requestId, attachmentId, revision } = await draftWithFile(ctx, action);
    await removeAs(ctx, 'user-a', requestId, attachmentId, revision);
    const serialized = JSON.stringify(ctx.rows('attachmentEvents'));
    expect(serialized).not.toContain('%PDF');
    expect(serialized).not.toContain(btoa(String.fromCharCode(...PDF_BYTES)).slice(0, 16));
    expect(serialized).not.toContain('_storage');
    expect(serialized).not.toMatch(/https?:/);
    expect(ctx.rows('attachmentEvents')).toEqual([
      expect.objectContaining({ actorMembershipId: 'memberships:a', fileName: 'medical-note.pdf' }),
      expect.objectContaining({ actorMembershipId: 'memberships:a', fileName: 'medical-note.pdf' }),
    ]);
  });
});

describe('fixture cleanup', () => {
  it('refuses to remove an organization while attachment rows remain', async () => {
    const { ctx, action } = setup();
    await draftWithFile(ctx, action);
    await expectCode(
      invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-1' }),
      'FIXTURE_ATTACHMENTS_REMAIN',
    );
  });

  it('removes attachment rows, events and blobs in bounded batches, then lets the organization go', async () => {
    const { ctx, action } = setup();
    await draftWithFile(ctx, action);
    await draftWithFile(ctx, action, 'user-a2');

    expect(await invokeHandler(removeRequestAttachments, ctx, { organizationKey: 'fixture-org-1', limit: 1 })).toEqual({
      attachments: 1,
      attachmentEvents: 1,
      files: 1,
      isDone: false,
    });
    expect(await invokeHandler(removeRequestAttachments, ctx, { organizationKey: 'fixture-org-1' })).toEqual({
      attachments: 1,
      attachmentEvents: 1,
      files: 1,
      isDone: true,
    });
    expect(ctx.files.size).toBe(0);
    expect(await invokeHandler(removeOrganization, ctx, { organizationKey: 'fixture-org-1' })).toMatchObject({
      requests: 2,
    });
  });
});
