import { describe, expect, it } from 'vitest';
import type { AttachmentDefinitionField } from '../../../convex/definitionModel';
import { acceptAttribute, formatFileSize, precheckFile, shortHash } from '../attachmentView';

const evidence: AttachmentDefinitionField = {
  type: 'attachment',
  key: 'supportingDocument',
  label: { enUS: 'Supporting document', zhCN: '证明材料' },
  required: false,
  maxFiles: 2,
  maxBytes: 2048,
  accept: ['application/pdf', 'image/jpeg'],
};

describe('attachment view helpers', () => {
  it('limits the file picker to the field’s types and their extensions', () => {
    expect(acceptAttribute(evidence)).toBe('application/pdf,.pdf,image/jpeg,.jpg,.jpeg');
  });

  it('refuses an oversize file or a disallowed extension before uploading, and leaves the rest to the server', () => {
    expect(precheckFile(evidence, { name: 'note.pdf', size: 2049 })).toEqual({
      code: 'ATTACHMENT_TOO_LARGE',
      field: 'supportingDocument',
      max: 2048,
    });
    expect(precheckFile(evidence, { name: 'scan.png', size: 10 })).toEqual({
      code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
      field: 'supportingDocument',
    });
    expect(precheckFile(evidence, { name: 'photo.JPG', size: 2048 })).toBeNull();
  });

  it('shows sizes in bytes or KB and the first 12 characters of the hash', () => {
    expect(formatFileSize(512, 'en-US')).toBe('512 B');
    expect(formatFileSize(2048, 'en-US')).toBe('2 KB');
    expect(formatFileSize(1_572_864, 'zh-CN')).toBe('1,536 KB');
    expect(shortHash('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe('ba7816bf8f01');
  });
});
