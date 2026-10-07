import { sameSha256 } from '../convex/attachmentModel';

// Backend and file reconciliation for #18: attachment rows, their `_storage` blobs, the files on disk, the audit events
// and the bytes the verifier retrieved through `requestAttachments:download` must all tell the same story.

export type ReconcileInput = {
  now: number;
  graceMs: number;
  attachments: Array<{
    _id: string;
    requestId: string;
    storageId: string;
    fileName: string;
    size: number;
    sha256: string;
  }>;
  events: Array<{
    attachmentId: string;
    requestId: string;
    kind: string;
    fileName: string;
    size: number;
    sha256: string;
  }>;
  storage: Array<{ _id: string; _creationTime: number; size: number; sha256: string }>;
  retrieved: Array<{ attachmentId: string; fileName: string; size: number; sha256: string }>;
  // Every file under the backend's local file store, hashed as hex.
  diskFiles: Array<{ size: number; sha256: string }>;
};

export type ReconcileResult = {
  ok: boolean;
  problems: string[];
  counts: {
    attachments: number;
    storage: number;
    events: number;
    retrieved: number;
    diskFiles: number;
    orphansInGrace: number;
    retainedDiskFiles: number;
    retainedDiskBytes: number;
  };
};

export function reconcileAttachments(input: ReconcileInput): ReconcileResult {
  const problems: string[] = [];
  const blobs = new Map(input.storage.map((blob) => [blob._id, blob]));
  const linked = new Map<string, number>();

  for (const attachment of input.attachments) {
    linked.set(attachment.storageId, (linked.get(attachment.storageId) ?? 0) + 1);
    const blob = blobs.get(attachment.storageId);
    if (!blob) problems.push(`attachment ${attachment._id} has no stored blob`);
    else if (blob.size !== attachment.size || !sameSha256(blob.sha256, attachment.sha256)) {
      problems.push(`attachment ${attachment._id} differs from its blob`);
    }
    const chain = input.events.filter((event) => event.attachmentId === attachment._id);
    const last = chain.at(-1);
    if (
      !last ||
      last.kind !== 'attach' ||
      last.requestId !== attachment.requestId ||
      last.fileName !== attachment.fileName ||
      last.size !== attachment.size ||
      last.sha256 !== attachment.sha256
    ) {
      problems.push(`attachment ${attachment._id} is not explained by its events`);
    }
  }
  for (const [storageId, count] of linked) {
    if (count > 1) problems.push(`blob ${storageId} is linked to ${count} attachments`);
  }

  let orphansInGrace = 0;
  for (const blob of input.storage) {
    if (linked.has(blob._id)) continue;
    if (input.now - blob._creationTime < input.graceMs) orphansInGrace += 1;
    else problems.push(`blob ${blob._id} is not linked to an attachment`);
  }

  const rows = new Set(input.attachments.map((attachment) => attachment._id));
  const lastKind = new Map<string, string>();
  for (const event of input.events) lastKind.set(event.attachmentId, event.kind);
  for (const [attachmentId, kind] of lastKind) {
    if (kind === 'attach' && !rows.has(attachmentId)) {
      problems.push(`event chain of ${attachmentId} ends in attach but no row exists`);
    }
  }

  const byId = new Map(input.attachments.map((attachment) => [attachment._id, attachment]));
  for (const file of input.retrieved) {
    const row = byId.get(file.attachmentId);
    if (!row || row.fileName !== file.fileName || row.size !== file.size || row.sha256 !== file.sha256) {
      problems.push(`retrieved ${file.attachmentId} does not match its row`);
    }
  }

  // The self-hosted backend keeps a blob's file on disk after the blob is deleted, so files are matched by size and
  // hash: every live blob needs one, and the rest are retained bytes to account for, not problems.
  const unmatched = [...input.diskFiles];
  for (const blob of input.storage) {
    const index = unmatched.findIndex((file) => file.size === blob.size && sameSha256(blob.sha256, file.sha256));
    if (index < 0) problems.push(`blob ${blob._id} has no file on disk with its size and hash`);
    else unmatched.splice(index, 1);
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      attachments: input.attachments.length,
      storage: input.storage.length,
      events: input.events.length,
      retrieved: input.retrieved.length,
      diskFiles: input.diskFiles.length,
      orphansInGrace,
      retainedDiskFiles: unmatched.length,
      retainedDiskBytes: unmatched.reduce((total, file) => total + file.size, 0),
    },
  };
}
