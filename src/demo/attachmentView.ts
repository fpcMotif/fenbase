import { extensionMatches, isAttachmentType, type AttachmentType } from '../../convex/attachmentModel';
import type { AttachmentDefinitionField } from '../../convex/definitionModel';
import type { RequestIssue } from '../../convex/requestValues';

const EXTENSIONS: Record<AttachmentType, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg,.jpeg',
};

function allowedTypes(field: AttachmentDefinitionField): AttachmentType[] {
  return field.accept.filter(isAttachmentType);
}

export function acceptAttribute(field: AttachmentDefinitionField): string {
  return allowedTypes(field)
    .map((type) => `${type},${EXTENSIONS[type]}`)
    .join(',');
}

// Early feedback only: the server measures the bytes and detects the type itself.
export function precheckFile(
  field: AttachmentDefinitionField,
  file: { name: string; size: number },
): RequestIssue | null {
  if (file.size > field.maxBytes) return { code: 'ATTACHMENT_TOO_LARGE', field: field.key, max: field.maxBytes };
  if (!allowedTypes(field).some((type) => extensionMatches(file.name, type))) {
    return { code: 'ATTACHMENT_TYPE_NOT_ALLOWED', field: field.key };
  }
  return null;
}

export function formatFileSize(bytes: number, language: string): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${new Intl.NumberFormat(language).format(Math.ceil(bytes / 1024))} KB`;
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
