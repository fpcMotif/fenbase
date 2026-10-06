import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType, TableColumnType, TablePaginationConfig, TableProps, ThemeConfig } from 'antd';
import { useMutation, useQueries } from 'convex/react';
import type { RequestForQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslation } from 'react-i18next';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DefinitionField } from '../../convex/definitionModel';
import { DEFAULT_RECORD_PAGE_SIZE, RECORD_CREATED_SORT_FIELD } from '../../convex/recordQuery';
import { REQUEST_ERROR_CODES, ownValue, validateRequestValues, type RequestIssue } from '../../convex/requestValues';
import { actionErrorData, actionErrorMessage, requestIssueMessage } from './actionErrors';
import { runPendingAction } from './pendingAction';
import { carryOverValues, fieldLabel, toFormValues, toRequestValues, type RequestFormValues } from './requestForm';

type MyApplication = FunctionReturnType<typeof api.memberships.listMine>[number];
type PublishedVersion = FunctionReturnType<typeof api.applicationDefinitions.getPublishedVersion>;
type RequestPage = FunctionReturnType<typeof api.requests.list>;
type RequestView = RequestPage['items'][number];
type Sort = { field: string; direction: 'asc' | 'desc' };
type Browse = { page: number; pageSize: number; sort: Sort };
type ModalState = { kind: 'create' } | { kind: 'edit'; requestId: Id<'requests'> };
type IssueText = Omit<RequestIssue, 'code'> & { code: string };
type SortOrder = TableColumnType<RequestView>['sortOrder'];
type TableSorter = Parameters<NonNullable<TableProps<RequestView>['onChange']>>[2];

const withoutMotion: ThemeConfig = { token: { motion: false } };
const defaultBrowse: Browse = {
  page: 1,
  pageSize: DEFAULT_RECORD_PAGE_SIZE,
  sort: { field: RECORD_CREATED_SORT_FIELD, direction: 'desc' },
};

function membershipReference(membershipId: string): string {
  return membershipId.slice(-6);
}

function controlId(key: string): string {
  return `request-field-${key}`;
}

function isRequestCode(code: string): boolean {
  return REQUEST_ERROR_CODES.some((known) => known === code);
}

export function RequestsPanel({ applications }: { applications: MyApplication[] }) {
  const { t } = useTranslation();
  const [applicationId, setApplicationId] = useState<Id<'applications'>>(applications[0].applicationId);
  const selected = applications.find((item) => item.applicationId === applicationId) ?? applications[0];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {applications.length > 1 && (
        <Form layout="vertical">
          <Form.Item label={t('requests.application')} htmlFor="requests-application">
            <Select
              id="requests-application"
              value={selected.applicationId}
              onChange={setApplicationId}
              options={applications.map((item) => ({
                value: item.applicationId,
                label: `${item.organizationName} · ${item.applicationName}`,
              }))}
            />
          </Form.Item>
        </Form>
      )}
      <ApplicationRequests key={selected.applicationId} application={selected} />
    </Space>
  );
}

function ApplicationRequests({ application }: { application: MyApplication }) {
  const { t, i18n } = useTranslation();
  const canSubmit = application.grants.includes('submitRequests');
  const [browse, setBrowse] = useState<Browse>(defaultBrowse);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [status, setStatus] = useState('');
  const [panelError, setPanelError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const removeRequest = useMutation(api.requests.remove);

  // `useQueries` resubscribes whenever it receives a new request object, and returns errors as values instead of
  // throwing, so an application without a published form shows a message rather than the error boundary.
  const queries = useMemo(
    (): RequestForQueries => ({
      current: {
        query: api.applicationDefinitions.getPublishedVersion,
        args: { applicationId: application.applicationId },
      },
      page: {
        query: api.requests.list,
        args: {
          applicationId: application.applicationId,
          page: browse.page,
          pageSize: browse.pageSize,
          sort: browse.sort,
        },
      },
    }),
    [application.applicationId, browse],
  );
  const results = useQueries(queries);
  const currentResult: PublishedVersion | Error | undefined = results.current;
  const pageResult: RequestPage | Error | undefined = results.page;
  const current = currentResult instanceof Error ? undefined : currentResult;
  const loadedPage = pageResult instanceof Error ? undefined : pageResult;
  // Keep the previous page on screen while the next one loads, and follow the backend when it moves a page past the
  // end back to the last page.
  const [shownPage, setShownPage] = useState<RequestPage | undefined>(undefined);
  if (loadedPage && loadedPage !== shownPage) setShownPage(loadedPage);
  if (loadedPage && loadedPage.page !== browse.page) setBrowse({ ...browse, page: loadedPage.page });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (modal) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      openerRef.current?.focus();
    }
  }, [modal]);

  if (currentResult === undefined && pageResult === undefined && !shownPage) {
    return (
      <div className="demo-centered" style={{ padding: 48 }}>
        <Spin aria-label={t('common.loading')} />
      </div>
    );
  }

  const noDefinition =
    currentResult instanceof Error && actionErrorData(currentResult)?.code === 'DEFINITION_NOT_FOUND';
  const definition = current?.definition;
  const fieldsByKey = new Map((definition?.fields ?? []).map((field) => [field.key, field]));
  const language = i18n.language;
  const page = loadedPage ?? shownPage;

  const openModal = (state: ModalState) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setStatus('');
    setModal(state);
  };

  const deleteRequest = (row: RequestView) => {
    setPanelError(null);
    runPendingAction(
      (pending) => setDeletingId(pending ? row._id : null),
      () =>
        removeRequest({ applicationId: application.applicationId, requestId: row._id, expectedRevision: row.revision }),
    )
      .then(() => setStatus(t('requests.deleted')))
      .catch((error: unknown) => {
        const data = actionErrorData(error);
        setPanelError(data ? requestIssueMessage(data, t, (key) => key) : actionErrorMessage(error, t));
      });
  };

  const renderValue = (row: RequestView, key: string) => {
    if (key === 'requester') {
      return row.requester.isMe
        ? t('requests.me')
        : t('requests.member', { ref: membershipReference(row.requester.membershipId) });
    }
    const value = ownValue(row.values, key);
    if (value === undefined) return t('requests.missingValue');
    if (typeof value === 'boolean') return value ? t('requests.yes') : t('requests.no');
    return String(value);
  };

  const sortOrder = (key: string): SortOrder =>
    browse.sort.field === key ? (browse.sort.direction === 'asc' ? 'ascend' : 'descend') : null;
  const offset = page ? (page.page - 1) * page.pageSize : 0;
  const columns: TableColumnsType<RequestView> = [
    ...(definition?.listColumns ?? []).map((key) => {
      const field = fieldsByKey.get(key);
      return {
        key,
        title: field ? fieldLabel(field, language) : t('builder.systemColumns.requester'),
        sorter: field !== undefined,
        sortOrder: field ? sortOrder(key) : null,
        render: (_value: unknown, row: RequestView) => renderValue(row, key),
      };
    }),
    {
      key: 'version',
      title: t('requests.versionColumn'),
      render: (_value, row) => <Tag>{t('requests.versionLabel', { version: row.version })}</Tag>,
    },
    {
      key: 'actions',
      title: t('requests.actions'),
      render: (_value, row, index) => (
        <ConfigProvider theme={withoutMotion}>
          <Space wrap>
            <Button
              aria-label={t('requests.openRow', { index: offset + index + 1 })}
              onClick={() => openModal({ kind: 'edit', requestId: row._id })}
            >
              {t('requests.open')}
            </Button>
            {row.canEdit && (
              <Popconfirm
                title={t('requests.deleteConfirm')}
                okText={t('requests.delete')}
                cancelText={t('requests.cancel')}
                onConfirm={() => deleteRequest(row)}
              >
                <Button
                  danger
                  aria-label={t('requests.deleteRow', { index: offset + index + 1 })}
                  loading={deletingId === row._id}
                >
                  {t('requests.delete')}
                </Button>
              </Popconfirm>
            )}
          </Space>
        </ConfigProvider>
      ),
    },
  ];

  const onTableChange = (pagination: TablePaginationConfig, _filters: unknown, sorter: TableSorter) => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = typeof single?.columnKey === 'string' && single.order ? single.columnKey : undefined;
    setBrowse({
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? DEFAULT_RECORD_PAGE_SIZE,
      sort: field
        ? { field, direction: single?.order === 'ascend' ? 'asc' : 'desc' }
        : { field: RECORD_CREATED_SORT_FIELD, direction: 'desc' },
    });
  };

  const newButton = canSubmit && current && (
    <Button type="primary" onClick={() => openModal({ kind: 'create' })}>
      {t('requests.new')}
    </Button>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Title level={2} style={{ margin: 0, fontSize: 20 }}>
              {t('requests.title', { application: application.applicationName })}
            </Typography.Title>
            {newButton}
          </Space>
          <Typography.Text className="demo-muted">{t('requests.description')}</Typography.Text>
          <output aria-live="polite">{status}</output>
        </Space>
      </Card>

      {panelError && <Alert role="alert" type="error" showIcon message={panelError} />}
      {pageResult instanceof Error && (
        <Alert role="alert" type="error" showIcon message={actionErrorMessage(pageResult, t)} />
      )}
      {currentResult instanceof Error && !noDefinition && (
        <Alert role="alert" type="error" showIcon message={actionErrorMessage(currentResult, t)} />
      )}

      <Card>
        {noDefinition ? (
          <Empty description={t('requests.noDefinition')} />
        ) : page && page.total === 0 ? (
          <Empty description={t('requests.empty')} />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {page && (
              <Typography.Text className="demo-muted">
                {t('requests.total', { total: page.total })} ·{' '}
                {t(page.scope === 'own' ? 'requests.scopeOwn' : 'requests.scopeApplication')}
              </Typography.Text>
            )}
            <Table<RequestView>
              rowKey="_id"
              columns={columns}
              dataSource={page?.items ?? []}
              loading={pageResult === undefined}
              onChange={onTableChange}
              pagination={{
                current: page?.page ?? browse.page,
                pageSize: page?.pageSize ?? browse.pageSize,
                total: page?.total ?? 0,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
              }}
              scroll={{ x: true }}
            />
          </Space>
        )}
      </Card>

      {modal && (
        <RequestModal
          application={application}
          state={modal}
          currentVersion={current}
          onClose={() => setModal(null)}
          onSaved={(text) => {
            setStatus(text);
            setModal(null);
          }}
        />
      )}
    </Space>
  );
}

function RequestModal({
  application,
  state,
  currentVersion,
  onClose,
  onSaved,
}: {
  application: MyApplication;
  state: ModalState;
  currentVersion: PublishedVersion | undefined;
  onClose: () => void;
  onSaved: (status: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [form] = Form.useForm<RequestFormValues>();
  const createRequest = useMutation(api.requests.create);
  const updateRequest = useMutation(api.requests.update);
  const requestId = state.kind === 'edit' ? state.requestId : undefined;

  // A new request is pinned to the version shown when the form opened; it only moves on "Load new version".
  const [createVersion, setCreateVersion] = useState<PublishedVersion | undefined>(currentVersion);
  const [operationId] = useState(() => crypto.randomUUID());
  const [revisionOverride, setRevisionOverride] = useState<number | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [outdated, setOutdated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);
  const outdatedRef = useRef<HTMLDivElement>(null);

  const queries = useMemo((): RequestForQueries => {
    if (!requestId) return {};
    return { request: { query: api.requests.get, args: { applicationId: application.applicationId, requestId } } };
  }, [application.applicationId, requestId]);
  const results = useQueries(queries);
  const requestResult: RequestView | null | Error | undefined = results.request;
  const request = requestResult instanceof Error ? undefined : requestResult;

  const pinnedVersionId = request?.versionId;
  const versionQueries = useMemo((): RequestForQueries => {
    if (!pinnedVersionId) return {};
    return {
      version: {
        query: api.applicationDefinitions.getPublishedVersion,
        args: { applicationId: application.applicationId, versionId: pinnedVersionId },
      },
    };
  }, [application.applicationId, pinnedVersionId]);
  const versionResults = useQueries(versionQueries);
  const pinnedResult: PublishedVersion | Error | undefined = versionResults.version;
  const pinned = state.kind === 'create' ? createVersion : pinnedResult instanceof Error ? undefined : pinnedResult;
  const definition = pinned?.definition;

  // The form edits the snapshot it opened with; live updates of the request never overwrite unsaved input.
  const [loadedRequest, setLoadedRequest] = useState<RequestView | null>(null);
  if (!loadedRequest && request && definition) setLoadedRequest(request);
  const baseRevision = revisionOverride ?? loadedRequest?.revision ?? null;

  useEffect(() => {
    if (conflictRevision !== null) conflictRef.current?.focus();
  }, [conflictRevision]);
  useEffect(() => {
    if (outdated) outdatedRef.current?.focus();
  }, [outdated]);

  const canEdit = state.kind === 'create' || Boolean(request?.canEdit);
  const labelOf = (key: string) => {
    const field = definition?.fields.find((candidate) => candidate.key === key);
    return field ? fieldLabel(field, i18n.language) : key;
  };

  const showIssue = (issue: IssueText) => {
    const text = requestIssueMessage(issue, t, labelOf);
    if (issue.field && definition?.fields.some((field) => field.key === issue.field)) {
      form.setFields([{ name: issue.field, errors: [text] }]);
      form.focusField(issue.field);
      return;
    }
    setFormError(text);
  };

  const handleError = (error: unknown) => {
    const data = actionErrorData(error);
    if (data?.code === 'RECORD_REVISION_CONFLICT') {
      setConflictRevision(data.currentRevision ?? 0);
      return;
    }
    if (data?.code === 'RECORD_DEFINITION_OUTDATED') {
      setOutdated(true);
      return;
    }
    if (data && isRequestCode(data.code)) {
      showIssue(data);
      return;
    }
    setFormError(actionErrorMessage(error, t));
  };

  const submit = () => {
    if (!definition || !pinned) return;
    setFormError(null);
    const values = toRequestValues(definition, form.getFieldsValue());
    const issue = validateRequestValues(definition, values);
    if (issue) {
      showIssue(issue);
      return;
    }
    if (state.kind === 'create') {
      runPendingAction(setSaving, () =>
        createRequest({
          applicationId: application.applicationId,
          definitionVersionId: pinned.versionId,
          operationId,
          values,
        }),
      )
        .then((result) => onSaved(t('requests.created', { revision: result.revision })))
        .catch(handleError);
      return;
    }
    if (!requestId || baseRevision === null) return;
    runPendingAction(setSaving, () =>
      updateRequest({
        applicationId: application.applicationId,
        requestId,
        expectedRevision: baseRevision,
        values,
      }),
    )
      .then((result) => onSaved(t('requests.saved', { revision: result.revision })))
      .catch(handleError);
  };

  // Clears only fields that show an error: resetting an already empty error list makes rc-field-form compare its shared
  // empty-list constant with itself and log a "circular references" warning.
  const clearErrors = (names: readonly string[]) => {
    const shown = names.filter((name) => form.getFieldError(name).length > 0);
    if (shown.length > 0) form.setFields(shown.map((name) => ({ name, errors: [] })));
  };

  const replaceFormValues = (fields: readonly DefinitionField[], values: RequestFormValues) => {
    const cleared: RequestFormValues = Object.fromEntries(fields.map((field) => [field.key, undefined]));
    form.setFieldsValue({ ...cleared, ...toFormValues({ fields: [...fields] }, values) });
    clearErrors(fields.map((field) => field.key));
  };

  const keepMine = () => {
    if (conflictRevision === null) return;
    setRevisionOverride(conflictRevision);
    setConflictRevision(null);
  };

  const reloadLatest = () => {
    if (!request || !definition) return;
    replaceFormValues(definition.fields, request.values);
    setRevisionOverride(request.revision);
    setConflictRevision(null);
  };

  const loadNewVersion = () => {
    if (!currentVersion) return;
    replaceFormValues(
      currentVersion.definition.fields,
      carryOverValues(currentVersion.definition, form.getFieldsValue()),
    );
    setCreateVersion(currentVersion);
    setOutdated(false);
  };

  const title =
    state.kind === 'create' ? t('requests.createTitle') : canEdit ? t('requests.editTitle') : t('requests.viewTitle');
  const missing = state.kind === 'edit' && request === null;
  const loading = !missing && (!definition || (state.kind === 'edit' && !loadedRequest));

  const control = (field: DefinitionField) => {
    const id = controlId(field.key);
    if (field.type === 'boolean') return <Switch id={id} />;
    if (field.type === 'number') return <InputNumber id={id} style={{ width: '100%' }} />;
    if (field.type === 'date') return <Input id={id} type="date" min="0001-01-01" max="9999-12-31" />;
    if (field.maxLength > 200) {
      return <Input.TextArea id={id} maxLength={field.maxLength} showCount autoSize={{ minRows: 2, maxRows: 6 }} />;
    }
    return <Input id={id} maxLength={field.maxLength} showCount autoComplete="off" />;
  };

  const help = (field: DefinitionField) => {
    if (field.type !== 'number') return undefined;
    return t(field.integer ? 'requests.integerRange' : 'requests.numberRange', { min: field.min, max: field.max });
  };

  return (
    <Modal
      open
      title={
        <Space wrap>
          <span>{title}</span>
          {pinned && <Tag color="blue">{t('requests.versionTag', { version: pinned.version })}</Tag>}
          {request && <Tag>{t('requests.revision', { revision: baseRevision ?? request.revision })}</Tag>}
        </Space>
      }
      onCancel={onClose}
      maskClosable={false}
      footer={
        <ConfigProvider theme={withoutMotion}>
          <Space wrap>
            <Button onClick={onClose}>{canEdit ? t('requests.cancel') : t('requests.close')}</Button>
            {canEdit && !missing && (
              <Button type="primary" loading={saving} disabled={loading} onClick={submit}>
                {t('requests.save')}
              </Button>
            )}
          </Space>
        </ConfigProvider>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {missing && <Alert role="alert" type="warning" showIcon message={t('requests.notFound')} />}
        {!canEdit && !missing && request && <Alert type="info" showIcon message={t('requests.readOnly')} />}
        {conflictRevision !== null && (
          <div ref={conflictRef} tabIndex={-1} aria-label={t('requests.conflictTitle')}>
            <Alert
              role="alert"
              type="warning"
              showIcon
              message={t('requests.conflictTitle')}
              description={t('requests.conflictDescription', { revision: conflictRevision })}
              action={
                <Space direction="vertical">
                  <Button size="small" onClick={keepMine}>
                    {t('requests.keepMine')}
                  </Button>
                  <Button size="small" onClick={reloadLatest} disabled={(request?.revision ?? 0) < conflictRevision}>
                    {t('requests.reloadLatest')}
                  </Button>
                </Space>
              }
            />
          </div>
        )}
        {outdated && (
          <div ref={outdatedRef} tabIndex={-1} aria-label={t('requests.outdatedTitle')}>
            <Alert
              role="alert"
              type="warning"
              showIcon
              message={t('requests.outdatedTitle')}
              description={t('requests.outdatedDescription')}
              action={
                <Button
                  size="small"
                  onClick={loadNewVersion}
                  disabled={!currentVersion || currentVersion.versionId === createVersion?.versionId}
                >
                  {t('requests.loadNewVersion')}
                </Button>
              }
            />
          </div>
        )}
        {formError && <Alert role="alert" type="error" showIcon message={formError} />}
        {loading ? (
          <div className="demo-centered" style={{ padding: 24 }}>
            <Spin aria-label={t('common.loading')} />
          </div>
        ) : (
          definition &&
          !missing && (
            <Form<RequestFormValues>
              form={form}
              name="request"
              layout="vertical"
              disabled={!canEdit}
              initialValues={toFormValues(definition, loadedRequest?.values ?? {})}
              onFinish={submit}
              onValuesChange={(changed) => clearErrors(Object.keys(changed))}
            >
              {definition.fields.map((field) => (
                <Form.Item
                  key={field.key}
                  name={field.key}
                  label={fieldLabel(field, i18n.language)}
                  htmlFor={controlId(field.key)}
                  required={field.required}
                  extra={help(field)}
                  valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
                >
                  {control(field)}
                </Form.Item>
              ))}
            </Form>
          )
        )}
      </Space>
    </Modal>
  );
}
