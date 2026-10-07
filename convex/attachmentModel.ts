// The attachment contract: allowed types, server ceilings, type detection, file name rules and the attachment read rule.
// Shared by the Convex functions and the demo client, so it must stay free of server-only imports.

export const ATTACHMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;
export const MAX_ATTACHMENT_EVENTS_PER_REQUEST = 20;
export const MAX_ATTACHMENT_FIELDS = 1;
export const MAX_ATTACHMENT_NAME_LENGTH = 120;
// An unlinked blob younger than this may still belong to an upload that is about to link it.
export const ORPHAN_GRACE_MS = 15 * 60 * 1000;
export const MAX_SWEEP_BATCH = 200;

const EXTENSIONS: Record<AttachmentType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

export function isAttachmentType(value: unknown): value is AttachmentType {
  return ATTACHMENT_TYPES.some((type) => type === value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

// Detects the type from the leading bytes only; a declared MIME type or file extension is never trusted on its own.
export function sniffContentType(bytes: Uint8Array): AttachmentType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

export function extensionMatches(fileName: string, type: AttachmentType): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return EXTENSIONS[type].includes(fileName.slice(dot + 1).toLowerCase());
}

// C0 and C1 control characters, DEL, and both path separators.
function isUnsafeCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || character === '/' || character === '\\';
}

export function sanitizeFileName(fileName: string): string | null {
  // Code points, not UTF-16 units, so a limit never splits a surrogate pair.
  const safe = Array.from(fileName.normalize('NFC'))
    .filter((character) => !isUnsafeCharacter(character))
    .join('');
  const cleaned = safe.trim().replace(/^\.+/u, '').trim();
  if (cleaned === '') return null;
  const characters = Array.from(cleaned);
  if (characters.length <= MAX_ATTACHMENT_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(cleaned.slice(dot)) : [];
  const kept = extension.length < 12 ? extension : [];
  return [...characters.slice(0, MAX_ATTACHMENT_NAME_LENGTH - kept.length), ...kept].join('');
}

function hexToBase64(hex: string): string {
  let binary = '';
  for (let index = 0; index < hex.length; index += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return btoa(binary);
}

// The `_storage` table documents its sha256 as hex; some backends store base64. Both spellings of one digest match.
export function sameSha256(stored: string, hex: string): boolean {
  return stored.toLowerCase() === hex.toLowerCase() || stored === hexToBase64(hex);
}

type AttachmentCaller = { membershipId: string; applicationId: string; grants: ReadonlySet<string> };
type AttachmentRequest = {
  applicationId: string;
  requesterMembershipId: string;
  reviewerMembershipId?: string;
  state: string;
};

// Stricter than reading the request: the requester always, and the assigned reviewer of a submitted request while they
// hold reviewRequests. Readers-preset holders and builders see the request but not its files.
export function canReadAttachments(caller: AttachmentCaller, request: AttachmentRequest): boolean {
  if (request.applicationId !== caller.applicationId) return false;
  if (request.requesterMembershipId === caller.membershipId) return true;
  return (
    request.state !== 'draft' &&
    request.reviewerMembershipId === caller.membershipId &&
    caller.grants.has('reviewRequests')
  );
}
