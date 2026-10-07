import {
  ATTACHMENT_EXTENSIONS,
  extensionMatches,
  isAttachmentType,
  type AttachmentType,
} from '../../convex/attachmentModel';
import type { AttachmentDefinitionField } from '../../convex/definitionModel';
import type { RequestIssue } from '../../convex/requestValues';

function allowedTypes(field: AttachmentDefinitionField): AttachmentType[] {
  return field.accept.filter(isAttachmentType);
}

export function acceptAttribute(field: AttachmentDefinitionField): string {
  return allowedTypes(field)
    .flatMap((type) => [type, ...ATTACHMENT_EXTENSIONS[type].map((extension) => `.${extension}`)])
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

// A size limit reads as a file size, not a raw byte count.
export function withReadableSize<Issue extends { code: string; max?: number }>(
  issue: Issue,
  language: string,
): Omit<Issue, 'max'> & { max?: number | string } {
  if (issue.code !== 'ATTACHMENT_TOO_LARGE' || issue.max === undefined) return issue;
  return { ...issue, max: formatFileSize(issue.max, language) };
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

// Saves bytes the server returned through a short-lived object URL; no storage URL ever reaches the browser.
export function saveBytes(bytes: ArrayBuffer, fileName: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers cancel a download whose object URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
