import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, ConfigProvider, Popconfirm, Space, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { useAction, useMutation, useQueries } from 'convex/react';
import type { RequestForQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslation } from 'react-i18next';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { AttachmentDefinitionField } from '../../convex/definitionModel';
import { isRequestErrorCode } from '../../convex/requestValues';
import { actionErrorData, actionErrorMessage, requestIssueMessage } from './actionErrors';
import { acceptAttribute, formatFileSize, precheckFile, shortHash } from './attachmentView';
import { runPendingAction, withoutMotion } from './pendingAction';
import { fieldLabel } from './requestForm';

type AttachmentList = FunctionReturnType<typeof api.requestAttachments.list>;
type AttachmentView = NonNullable<AttachmentList>[number];
type CustomRequest = NonNullable<UploadProps['customRequest']>;

// Saves bytes the server returned through a short-lived object URL; no storage URL ever reaches the browser.
function saveBytes(bytes: ArrayBuffer, fileName: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function AttachmentField({
  applicationId,
  requestId,
  field,
  canEdit,
  revision,
  onRevision,
  onConflict,
}: {
  applicationId: Id<'applications'>;
  requestId: Id<'requests'> | undefined;
  field: AttachmentDefinitionField;
  canEdit: boolean;
  revision: number | null;
  onRevision: (revision: number) => void;
  onConflict: (currentRevision: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const upload = useAction(api.requestAttachments.upload);
  const download = useAction(api.requestAttachments.download);
  const remove = useMutation(api.requestAttachments.remove);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const label = fieldLabel(field, i18n.language);

  const queries = useMemo((): RequestForQueries => {
    if (!requestId) return {};
    return { list: { query: api.requestAttachments.list, args: { applicationId, requestId } } };
  }, [applicationId, requestId]);
  const listResult: AttachmentList | Error | undefined = useQueries(queries).list;
  const files = (Array.isArray(listResult) ? listResult : []).filter((file) => file.fieldKey === field.key);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const showError = (failure: unknown) => {
    const data = actionErrorData(failure);
    if (data?.code === 'RECORD_REVISION_CONFLICT') {
      onConflict(data.currentRevision ?? 0);
      return;
    }
    if (data && isRequestErrorCode(data.code)) {
      setError(requestIssueMessage(data, t, () => label));
      return;
    }
    setError(data ? actionErrorMessage(failure, t) : t('attachments.interrupted'));
  };

  const customRequest: CustomRequest = ({ file }) => {
    if (!(file instanceof File) || !requestId || revision === null) return;
    setError(null);
    setStatus('');
    const issue = precheckFile(field, file);
    if (issue) {
      setError(requestIssueMessage(issue, t, () => label));
      return;
    }
    const operationId = crypto.randomUUID();
    runPendingAction(setUploading, async () =>
      upload({
        applicationId,
        requestId,
        fieldKey: field.key,
        fileName: file.name,
        bytes: await file.arrayBuffer(),
        expectedRevision: revision,
        operationId,
      }),
    )
      .then((result) => {
        onRevision(result.revision);
        setStatus(t('attachments.uploaded', { name: result.fileName, revision: result.revision }));
      })
      .catch(showError);
  };

  const downloadFile = (file: AttachmentView) => {
    setError(null);
    runPendingAction(
      (pending) => setBusyId(pending ? file._id : null),
      () => download({ applicationId, attachmentId: file._id }),
    )
      .then((result) => {
        saveBytes(result.bytes, result.fileName, result.contentType);
        setStatus(t('attachments.downloaded', { name: result.fileName }));
      })
      .catch(showError);
  };

  const removeFile = (file: AttachmentView) => {
    if (!requestId || revision === null) return;
    setError(null);
    const operationId = crypto.randomUUID();
    runPendingAction(
      (pending) => setBusyId(pending ? file._id : null),
      () => remove({ applicationId, requestId, attachmentId: file._id, expectedRevision: revision, operationId }),
    )
      .then((result) => {
        onRevision(result.revision);
        setStatus(t('attachments.removed', { name: file.fileName, revision: result.revision }));
      })
      .catch(showError);
  };

  const full = files.length >= field.maxFiles;
  return (
    <section aria-label={label} className="demo-attachment-field">
      <Typography.Title level={3} style={{ fontSize: 14 }}>
        {label}
        {field.required && <span aria-hidden="true"> *</span>}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t('attachments.limits', {
          count: field.maxFiles,
          size: formatFileSize(field.maxBytes, i18n.language),
          types: acceptAttribute(field)
            .split(',')
            .filter((part) => part.startsWith('.'))
            .join(' '),
        })}
      </Typography.Text>
      {error && (
        <div ref={errorRef} tabIndex={-1} aria-label={t('attachments.errorTitle')}>
          <Alert role="alert" type="error" showIcon message={error} />
        </div>
      )}
      <ConfigProvider theme={withoutMotion}>
        {listResult instanceof Error && (
          <Alert role="alert" type="error" showIcon message={actionErrorMessage(listResult, t)} />
        )}
        {requestId && files.length === 0 && listResult !== undefined && !(listResult instanceof Error) && (
          <Typography.Paragraph>{t('attachments.none')}</Typography.Paragraph>
        )}
        {files.length > 0 && (
          <ul aria-label={t('attachments.listLabel', { field: label })} className="demo-attachment-list">
            {files.map((file) => (
              <li key={file._id}>
                <Space wrap>
                  <Typography.Text strong>{file.fileName}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t('attachments.meta', {
                      size: formatFileSize(file.size, i18n.language),
                      hash: shortHash(file.sha256),
                    })}
                  </Typography.Text>
                  <Button
                    size="small"
                    aria-label={t('attachments.downloadNamed', { name: file.fileName })}
                    loading={busyId === file._id}
                    disabled={busyId !== null && busyId !== file._id}
                    onClick={() => downloadFile(file)}
                  >
                    {t('attachments.download')}
                  </Button>
                  {canEdit && (
                    <Popconfirm
                      title={t('attachments.removeConfirm', { name: file.fileName })}
                      okText={t('attachments.remove')}
                      cancelText={t('requests.cancel')}
                      onConfirm={() => removeFile(file)}
                      getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
                    >
                      <Button
                        size="small"
                        danger
                        aria-label={t('attachments.removeNamed', { name: file.fileName })}
                        disabled={busyId !== null || uploading}
                      >
                        {t('attachments.remove')}
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <Space direction="vertical" size={4}>
            <Upload
              accept={acceptAttribute(field)}
              customRequest={customRequest}
              showUploadList={false}
              disabled={!requestId || uploading || full || busyId !== null}
            >
              <Button
                aria-label={t('attachments.attachTo', { field: label })}
                loading={uploading}
                disabled={!requestId || full || busyId !== null}
              >
                {t('attachments.attach')}
              </Button>
            </Upload>
            {!requestId && <Typography.Text type="secondary">{t('attachments.saveFirst')}</Typography.Text>}
            {requestId && full && (
              <Typography.Text type="secondary">{t('attachments.full', { count: field.maxFiles })}</Typography.Text>
            )}
          </Space>
        )}
      </ConfigProvider>
      <output aria-live="polite">{status}</output>
    </section>
  );
}
