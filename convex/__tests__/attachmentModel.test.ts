import { describe, expect, it } from 'vitest';
import {
  canReadAttachments,
  extensionMatches,
  sameSha256,
  sanitizeFileName,
  sniffContentType,
  type AttachmentType,
} from '../attachmentModel';
import { JPEG_BYTES, PDF_BYTES, PNG_BYTES, bytesOf } from './attachmentFixture.support';

describe('sniffContentType', () => {
  it.each([
    ['a PDF', PDF_BYTES, 'application/pdf'],
    ['a PNG', PNG_BYTES, 'image/png'],
    ['a JPEG', JPEG_BYTES, 'image/jpeg'],
  ])('detects %s from its leading bytes', (_name, bytes, type) => {
    expect(sniffContentType(bytes)).toBe(type);
  });

  it.each([
    ['HTML', bytesOf('<!doctype html><script>alert(1)</script>')],
    ['SVG', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['plain text', bytesOf('just some notes')],
    ['an empty file', new Uint8Array()],
    ['a truncated PNG signature', PNG_BYTES.slice(0, 4)],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffContentType(bytes)).toBeNull();
  });
});

describe('extensionMatches', () => {
  it.each<[string, AttachmentType]>([
    ['contract.pdf', 'application/pdf'],
    ['CONTRACT.PDF', 'application/pdf'],
    ['scan.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
  ])('accepts %s as %s', (name, type) => {
    expect(extensionMatches(name, type)).toBe(true);
  });

  it.each<[string, AttachmentType]>([
    ['page.html', 'application/pdf'],
    ['scan.pdf', 'image/png'],
    ['noextension', 'image/png'],
    ['photo.jpg.exe', 'image/jpeg'],
  ])('refuses %s as %s', (name, type) => {
    expect(extensionMatches(name, type)).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFileName('medical-note.pdf')).toBe('medical-note.pdf');
  });

  it('strips path separators, control characters and leading dots', () => {
    expect(sanitizeFileName('../..\\etc/pass\u0000wd\u0085.pdf')).toBe('etcpasswd.pdf');
    expect(sanitizeFileName('...hidden.png')).toBe('hidden.png');
  });

  it('normalizes to NFC and keeps Chinese names', () => {
    expect(sanitizeFileName('é 病假证明.pdf')).toBe('é 病假证明.pdf');
  });

  it('limits a long name to 120 code points while keeping the extension', () => {
    const name = sanitizeFileName(`${'名'.repeat(200)}.pdf`);
    expect(name).not.toBeNull();
    expect(Array.from(name ?? '').length).toBe(120);
    expect(name?.endsWith('.pdf')).toBe(true);
  });

  it('returns null when nothing usable is left', () => {
    expect(sanitizeFileName(' ../\u0000 ')).toBeNull();
    expect(sanitizeFileName('')).toBeNull();
  });
});

describe('sameSha256', () => {
  const hex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  it('matches the same digest written as hex or base64', () => {
    expect(sameSha256(hex, hex)).toBe(true);
    expect(sameSha256('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=', hex)).toBe(true);
  });

  it('refuses a different digest', () => {
    expect(sameSha256(hex.replace('ba', 'bb'), hex)).toBe(false);
    expect(sameSha256('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa1=', hex)).toBe(false);
  });
});

describe('canReadAttachments', () => {
  const caller = (membershipId: string, grants: string[], applicationId = 'applications:1') => ({
    membershipId,
    applicationId,
    grants: new Set(grants),
  });
  const request = (state: string) => ({
    applicationId: 'applications:1',
    requesterMembershipId: 'memberships:a',
    reviewerMembershipId: state === 'draft' ? undefined : 'memberships:v',
    state,
  });

  it.each(['draft', 'pending', 'approved', 'rejected', 'withdrawn'])('lets the requester read in %s', (state) => {
    expect(canReadAttachments(caller('memberships:a', []), request(state))).toBe(true);
  });

  it.each(['pending', 'approved', 'rejected', 'withdrawn'])(
    'lets the assigned reviewer with reviewRequests read in %s',
    (state) => {
      expect(canReadAttachments(caller('memberships:v', ['reviewRequests']), request(state))).toBe(true);
      expect(canReadAttachments(caller('memberships:v', []), request(state))).toBe(false);
    },
  );

  it('keeps a draft private from everyone but the requester', () => {
    const draft = { ...request('draft'), reviewerMembershipId: 'memberships:v' };
    expect(canReadAttachments(caller('memberships:v', ['reviewRequests']), draft)).toBe(false);
  });

  it('gives readers, builders and unrelated members nothing', () => {
    for (const grants of [['readApplicationRecords'], ['configureApplication'], ['submitRequests'], []]) {
      expect(canReadAttachments(caller('memberships:x', grants), request('approved'))).toBe(false);
    }
  });

  it('refuses a caller from another application', () => {
    expect(canReadAttachments(caller('memberships:a', ['submitRequests'], 'applications:2'), request('approved'))).toBe(
      false,
    );
  });
});
