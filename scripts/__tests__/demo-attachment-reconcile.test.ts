import { describe, expect, it } from 'vitest';
import { reconcileAttachments, type ReconcileInput } from '../demo-attachment-reconcile';

const HASH_A = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const HASH_A_BASE64 = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';
const HASH_B = '0000000000000000000000000000000000000000000000000000000000000000';
const NOW = 10_000_000;
const GRACE = 1_000;

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    now: NOW,
    graceMs: GRACE,
    attachments: [{ _id: 'att1', requestId: 'req1', storageId: 'st1', fileName: 'note.pdf', size: 10, sha256: HASH_A }],
    events: [
      { attachmentId: 'att1', requestId: 'req1', kind: 'attach', fileName: 'note.pdf', size: 10, sha256: HASH_A },
    ],
    storage: [{ _id: 'st1', _creationTime: NOW - 5_000, size: 10, sha256: HASH_A_BASE64 }],
    retrieved: [{ attachmentId: 'att1', fileName: 'note.pdf', size: 10, sha256: HASH_A }],
    diskFiles: [{ size: 10, sha256: HASH_A }],
    ...overrides,
  };
}

describe('attachment reconciliation', () => {
  it('accepts rows, blobs, events, files on disk and retrieved bytes that agree', () => {
    expect(reconcileAttachments(input())).toEqual({
      ok: true,
      problems: [],
      counts: {
        attachments: 1,
        storage: 1,
        events: 1,
        retrieved: 1,
        diskFiles: 1,
        orphansInGrace: 0,
        retainedDiskFiles: 0,
        retainedDiskBytes: 0,
      },
    });
  });

  it('reports an attachment whose blob is missing or differs', () => {
    expect(reconcileAttachments(input({ storage: [] })).problems).toContain('attachment att1 has no stored blob');
    expect(
      reconcileAttachments(input({ storage: [{ _id: 'st1', _creationTime: 1, size: 11, sha256: HASH_A }] })).problems,
    ).toContain('attachment att1 differs from its blob');
  });

  it('reports an unlinked blob outside the grace window, and counts one inside it', () => {
    const orphan = { _id: 'st2', _creationTime: NOW - 5_000, size: 3, sha256: HASH_B };
    const fresh = { _id: 'st3', _creationTime: NOW - 10, size: 3, sha256: HASH_B };
    const disk = [
      { size: 10, sha256: HASH_A },
      { size: 3, sha256: HASH_B },
      { size: 3, sha256: HASH_B },
    ];
    const result = reconcileAttachments(input({ storage: [...input().storage, orphan, fresh], diskFiles: disk }));
    expect(result.problems).toEqual(['blob st2 is not linked to an attachment']);
    expect(result.counts.orphansInGrace).toBe(1);
  });

  it('reports retrieved bytes that do not match the row', () => {
    expect(
      reconcileAttachments(
        input({ retrieved: [{ attachmentId: 'att1', fileName: 'note.pdf', size: 10, sha256: HASH_B }] }),
      ).problems,
    ).toEqual(['retrieved att1 does not match its row']);
  });

  it('reports a stored blob whose bytes are not on disk', () => {
    expect(reconcileAttachments(input({ diskFiles: [{ size: 10, sha256: HASH_B }] })).problems).toEqual([
      'blob st1 has no file on disk with its size and hash',
    ]);
  });

  it('counts files the backend kept on disk after their blobs were deleted as retained, not as problems', () => {
    const result = reconcileAttachments(
      input({
        diskFiles: [
          { size: 10, sha256: HASH_A },
          { size: 4096, sha256: HASH_B },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ diskFiles: 2, retainedDiskFiles: 1, retainedDiskBytes: 4096 });
  });

  it('reports a row without an attach event and an attach event without a row', () => {
    expect(reconcileAttachments(input({ events: [] })).problems).toEqual([
      'attachment att1 is not explained by its events',
    ]);
    const dangling = {
      attachmentId: 'att9',
      requestId: 'req1',
      kind: 'attach',
      fileName: 'x.pdf',
      size: 1,
      sha256: HASH_B,
    };
    expect(reconcileAttachments(input({ events: [...input().events, dangling] })).problems).toEqual([
      'event chain of att9 ends in attach but no row exists',
    ]);
    const removed = { ...dangling, kind: 'remove' };
    expect(reconcileAttachments(input({ events: [...input().events, dangling, removed] })).ok).toBe(true);
  });
});
