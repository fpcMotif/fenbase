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
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType, TableColumnType, TablePaginationConfig, TableProps } from 'antd';
import { useMutation, useQueries } from 'convex/react';
import type { RequestForQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslation } from 'react-i18next';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DefinitionField } from '../../convex/definitionModel';
import { DEFAULT_RECORD_PAGE_SIZE, RECORD_CREATED_SORT_FIELD, type RecordFilter } from '../../convex/recordQuery';
import { isRequestErrorCode, ownValue, validateRequestValues, type RequestIssue } from '../../convex/requestValues';
import { actionErrorData, actionErrorMessage, requestIssueMessage } from './actionErrors';
import { runPendingAction, withoutMotion } from './pendingAction';
import {
  carryOverValues,
  columnTitle,
  dateRangeFilters,
  fieldLabel,
  toFormValues,
  toRequestValues,
  type DateRange,
  type RequestFormValues,
} from './requestForm';
import {
  newCreateAttempt,
  requestActions,
  requestModalStatus,
  staleRequest,
  type ReviewAction,
  type StaleRequest,
} from './requestModal';

type MyApplication = FunctionReturnType<typeof api.memberships.listMine>[number];
type PublishedVersion = FunctionReturnType<typeof api.applicationDefinitions.getPublishedVersion>;
type RequestPage = FunctionReturnType<typeof api.requests.list>;
type RequestView = RequestPage['items'][number];
type RequestState = RequestView['state'];
type Inbox = FunctionReturnType<typeof api.requestReviews.inbox>;
type InboxStatus = 'pending' | 'completed';
type RequestEvents = FunctionReturnType<typeof api.requestReviews.history>;
type PanelView = 'mine' | 'assigned';
type Sort = { field: string; direction: 'asc' | 'desc' };
type Browse = { page: number; pageSize: number; sort: Sort; filters: RecordFilter[] };
type ModalState = { kind: 'create' } | { kind: 'edit'; requestId: Id<'requests'> };
type IssueText = Omit<RequestIssue, 'code'> & { code: string };
type SortOrder = TableColumnType<RequestView>['sortOrder'];
type TableSorter = Parameters<NonNullable<TableProps<RequestView>['onChange']>>[2];

const defaultBrowse: Browse = {
  page: 1,
  pageSize: DEFAULT_RECORD_PAGE_SIZE,
  sort: { field: RECORD_CREATED_SORT_FIELD, direction: 'desc' },
  filters: [],
};

function membershipReference(membershipId: string): string {
  return membershipId.slice(-6);
}

function controlId(key: string): string {
  return `request-field-${key}`;
}

const reviewDoneKeys: Record<ReviewAction, string> = {
  submit: 'submitted',
  withdraw: 'withdrawn',
  approve: 'approved',
  reject: 'rejected',
};

const stateColors: Record<RequestState, string> = {
  draft: 'default',
  pending: 'processing',
  approved: 'success',
  rejected: 'error',
  withdrawn: 'warning',
};

function StateTag({ state }: { state: RequestState }) {
  const { t } = useTranslation();
  return <Tag color={stateColors[state]}>{t(`reviews.states.${state}`)}</Tag>;
}

function useMemberName() {
  const { t } = useTranslation();
  return (member: { membershipId: string; isMe: boolean }) =>
    member.isMe ? t('requests.me') : t('requests.member', { ref: membershipReference(member.membershipId) });
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
  const canReview = application.grants.includes('reviewRequests');
  const [view, setView] = useState<PanelView>(canReview && !canSubmit ? 'assigned' : 'mine');
  const memberName = useMemberName();
  const [browse, setBrowse] = useState<Browse>(defaultBrowse);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [status, setStatus] = useState('');
  const [panelError, setPanelError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>({});
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
          filters: browse.filters,
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
    if (key === 'requester') return memberName(row.requester);
    const value = ownValue(row.values, key);
    if (value === undefined) return t('requests.missingValue');
    if (typeof value === 'boolean') return value ? t('requests.yes') : t('requests.no');
    return String(value);
  };

  const sortOrder = (key: string): SortOrder =>
    browse.sort.field === key ? (browse.sort.direction === 'asc' ? 'ascend' : 'descend') : null;
  const offset = page ? (page.page - 1) * page.pageSize : 0;
  const valueColumns: TableColumnsType<RequestView> = [
    ...(definition?.listColumns ?? []).map((key) => {
      const field = fieldsByKey.get(key);
      return {
        key,
        title: columnTitle(key, field, language, t),
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
      key: 'state',
      title: t('reviews.stateColumn'),
      render: (_value, row) => <StateTag state={row.state} />,
    },
  ];
  const columns: TableColumnsType<RequestView> = [
    ...valueColumns,
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
      filters: browse.filters,
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? DEFAULT_RECORD_PAGE_SIZE,
      sort: field
        ? { field, direction: single?.order === 'ascend' ? 'asc' : 'desc' }
        : { field: RECORD_CREATED_SORT_FIELD, direction: 'desc' },
    });
  };

  const dateRule = definition?.dateRules[0];
  const applyRange = (next: DateRange) => {
    setRange(next);
    if (definition) setBrowse({ ...browse, page: 1, filters: dateRangeFilters(definition, next) });
  };
  const ruleLabel = (key: string) => {
    const field = fieldsByKey.get(key);
    return field ? fieldLabel(field, language) : key;
  };
  const filtered = browse.filters.length > 0;
  const rangeFilter = dateRule && (
    <Form layout="inline" aria-label={t('requests.filterTitle')} onFinish={() => applyRange(range)}>
      <Form.Item
        label={t('requests.filterFrom', { field: ruleLabel(dateRule.startKey) })}
        htmlFor="requests-filter-from"
      >
        <Input
          id="requests-filter-from"
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={range.from ?? ''}
          onChange={(event) => applyRange({ ...range, from: event.target.value })}
        />
      </Form.Item>
      <Form.Item label={t('requests.filterTo', { field: ruleLabel(dateRule.endKey) })} htmlFor="requests-filter-to">
        <Input
          id="requests-filter-to"
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={range.to ?? ''}
          onChange={(event) => applyRange({ ...range, to: event.target.value })}
        />
      </Form.Item>
      <Form.Item>
        <Button onClick={() => applyRange({})} disabled={!range.from && !range.to}>
          {t('requests.clearFilter')}
        </Button>
      </Form.Item>
    </Form>
  );

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
          {canReview && (
            <Segmented<PanelView>
              aria-label={t('reviews.viewLabel')}
              value={view}
              onChange={setView}
              options={[
                { value: 'mine', label: t('reviews.mine') },
                { value: 'assigned', label: t('reviews.assigned') },
              ]}
            />
          )}
          <output aria-live="polite">{status}</output>
        </Space>
      </Card>

      {view === 'assigned' && (
        <ReviewInbox
          application={application}
          columns={valueColumns.map((column) => ({ ...column, sorter: false, sortOrder: null }))}
          onOpen={(requestId) => openModal({ kind: 'edit', requestId })}
        />
      )}
      {view === 'mine' && panelError && <Alert role="alert" type="error" showIcon message={panelError} />}
      {view === 'mine' && pageResult instanceof Error && (
        <Alert role="alert" type="error" showIcon message={actionErrorMessage(pageResult, t)} />
      )}
      {currentResult instanceof Error && !noDefinition && (
        <Alert role="alert" type="error" showIcon message={actionErrorMessage(currentResult, t)} />
      )}

      <Card hidden={view !== 'mine'}>
        {!noDefinition && rangeFilter && <div style={{ marginBottom: 16 }}>{rangeFilter}</div>}
        {noDefinition ? (
          <Empty description={t('requests.noDefinition')} />
        ) : page && page.total === 0 ? (
          <Empty description={t(filtered ? 'requests.noMatches' : 'requests.empty')} />
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

function ReviewInbox({
  application,
  columns,
  onOpen,
}: {
  application: MyApplication;
  columns: TableColumnsType<RequestView>;
  onOpen: (requestId: Id<'requests'>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<InboxStatus>('pending');
  const queries = useMemo(
    (): RequestForQueries => ({
      inbox: { query: api.requestReviews.inbox, args: { applicationId: application.applicationId, status } },
    }),
    [application.applicationId, status],
  );
  const result: Inbox | Error | undefined = useQueries(queries).inbox;
  const inbox = result instanceof Error ? undefined : result;
  const submittedAt = (value: number | null) =>
    value === null ? t('requests.missingValue') : new Date(value).toLocaleString(i18n.language);

  return (
    <Card>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented<InboxStatus>
          aria-label={t('reviews.inboxStatusLabel')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: t('reviews.inboxPending') },
            { value: 'completed', label: t('reviews.inboxCompleted') },
          ]}
        />
        {result instanceof Error && (
          <Alert role="alert" type="error" showIcon message={actionErrorMessage(result, t)} />
        )}
        {inbox?.truncated && <Alert type="info" showIcon message={t('reviews.inboxTruncated')} />}
        {inbox && inbox.items.length === 0 ? (
          <Empty description={t(status === 'pending' ? 'reviews.inboxEmpty' : 'reviews.inboxCompletedEmpty')} />
        ) : (
          <Table<RequestView>
            rowKey="_id"
            loading={result === undefined}
            dataSource={inbox?.items ?? []}
            pagination={false}
            scroll={{ x: true }}
            columns={[
              ...columns,
              {
                key: 'submittedAt',
                title: t('reviews.submittedColumn'),
                render: (_value, row) => submittedAt(row.submittedAt),
              },
              {
                key: 'actions',
                title: t('requests.actions'),
                render: (_value, row, index) => (
                  <Button aria-label={t('requests.openRow', { index: index + 1 })} onClick={() => onOpen(row._id)}>
                    {t('requests.open')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Space>
    </Card>
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
  const reviewCommands = {
    submit: useMutation(api.requestReviews.submit),
    withdraw: useMutation(api.requestReviews.withdraw),
    approve: useMutation(api.requestReviews.approve),
    reject: useMutation(api.requestReviews.reject),
  };
  const memberName = useMemberName();
  const requestId = state.kind === 'edit' ? state.requestId : undefined;

  // A new request is pinned to the version shown when the form opened; it only moves on "Load new version".
  const [attempt, setAttempt] = useState(() => newCreateAttempt(currentVersion));
  const createVersion = attempt.version;
  const [revisionOverride, setRevisionOverride] = useState<number | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [outdated, setOutdated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewPending, setReviewPending] = useState<ReviewAction | null>(null);
  const [stale, setStale] = useState<StaleRequest | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const outdatedRef = useRef<HTMLDivElement>(null);
  const staleRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const queries = useMemo((): RequestForQueries => {
    if (!requestId) return {};
    const args = { applicationId: application.applicationId, requestId };
    return {
      request: { query: api.requests.get, args },
      history: { query: api.requestReviews.history, args },
    };
  }, [application.applicationId, requestId]);
  const results = useQueries(queries);
  const requestResult: RequestView | null | Error | undefined = results.request;
  const request = requestResult instanceof Error ? undefined : requestResult;
  const historyResult: RequestEvents | Error | undefined = results.history;
  const events = historyResult instanceof Error ? null : historyResult;

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
  useEffect(() => {
    if (stale) staleRef.current?.focus();
  }, [stale]);

  const canEdit = state.kind === 'create' || Boolean(request?.canEdit);
  // Review commands follow the snapshot the modal shows, so a decision made on stale content reaches the server and is
  // refused there instead of silently applying to a request that changed.
  const actions = loadedRequest ? requestActions(loadedRequest) : [];
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
    if (data && isRequestErrorCode(data.code)) {
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
          operationId: attempt.operationId,
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

  const runReview = (action: ReviewAction, expectedRevision: () => Promise<number>) => {
    if (!requestId) return;
    setFormError(null);
    const operationId = crypto.randomUUID();
    runPendingAction(
      (pending) => setReviewPending(pending ? action : null),
      async () =>
        reviewCommands[action]({
          applicationId: application.applicationId,
          requestId,
          expectedRevision: await expectedRevision(),
          operationId,
        }),
    )
      .then((result) => onSaved(t(`reviews.${reviewDoneKeys[action]}`, { revision: result.revision })))
      .catch((error: unknown) => {
        const data = actionErrorData(error);
        const stale =
          data?.code === 'REQUEST_STATE_CONFLICT' || (action !== 'submit' && data?.code === 'RECORD_REVISION_CONFLICT')
            ? staleRequest(data, request ?? loadedRequest ?? undefined)
            : null;
        if (stale) {
          setStale(stale);
          return;
        }
        handleError(error);
      });
  };

  const decide = (action: Exclude<ReviewAction, 'submit'>) => {
    if (baseRevision === null) return;
    runReview(action, async () => baseRevision);
  };

  // Saves the form first, so the submitted request holds exactly what the requester sees.
  const submitForReview = () => {
    if (!definition || !requestId || baseRevision === null) return;
    setFormError(null);
    const values = toRequestValues(definition, form.getFieldsValue());
    const issue = validateRequestValues(definition, values);
    if (issue) {
      showIssue(issue);
      return;
    }
    runReview('submit', async () => {
      const saved = await updateRequest({
        applicationId: application.applicationId,
        requestId,
        expectedRevision: baseRevision,
        values,
      });
      setRevisionOverride(saved.revision);
      return saved.revision;
    });
  };

  const showLatest = () => {
    if (!request) return;
    if (definition) replaceFormValues(definition.fields, request.values);
    setLoadedRequest(request);
    setRevisionOverride(null);
    setStale(null);
    // The button that had focus disappears with the alert; keep focus inside the dialog.
    closeRef.current?.focus();
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
    setAttempt(newCreateAttempt(currentVersion));
    setOutdated(false);
  };

  const title =
    state.kind === 'create'
      ? t('requests.createTitle')
      : canEdit
        ? t('requests.editTitle')
        : actions.includes('approve')
          ? t('reviews.reviewTitle')
          : t('requests.viewTitle');
  const status = requestModalStatus({
    mode: state.kind,
    request: requestResult,
    pinnedVersion: state.kind === 'edit' ? pinnedResult : createVersion,
    hasDefinition: definition !== undefined,
    hasSnapshot: loadedRequest !== null,
  });
  const missing = status.kind === 'missing';
  const failed = status.kind === 'failed' ? status.error : null;
  const loading = status.kind === 'loading';

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
          {loadedRequest && <StateTag state={loadedRequest.state} />}
        </Space>
      }
      onCancel={onClose}
      maskClosable={false}
      footer={
        <ConfigProvider theme={withoutMotion}>
          <Space wrap>
            <Button ref={closeRef} onClick={onClose}>
              {canEdit ? t('requests.cancel') : t('requests.close')}
            </Button>
            {canEdit && !missing && !failed && (
              <Button
                type={actions.includes('submit') ? 'default' : 'primary'}
                loading={saving}
                disabled={loading || reviewPending !== null}
                onClick={submit}
              >
                {t('requests.save')}
              </Button>
            )}
            {canEdit && actions.includes('submit') && (
              <Button
                type="primary"
                loading={reviewPending === 'submit'}
                disabled={saving || (reviewPending !== null && reviewPending !== 'submit')}
                onClick={submitForReview}
              >
                {t('reviews.submit')}
              </Button>
            )}
            {actions.includes('withdraw') && (
              <Popconfirm
                title={t('reviews.withdrawConfirm')}
                okText={t('reviews.withdraw')}
                cancelText={t('requests.cancel')}
                onConfirm={() => decide('withdraw')}
                // Inside the modal's focus trap, so the keyboard can reach the confirmation.
                getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
              >
                <Button danger loading={reviewPending === 'withdraw'}>
                  {t('reviews.withdraw')}
                </Button>
              </Popconfirm>
            )}
            {actions.includes('reject') && (
              <Button
                danger
                loading={reviewPending === 'reject'}
                disabled={reviewPending === 'approve'}
                onClick={() => decide('reject')}
              >
                {t('reviews.reject')}
              </Button>
            )}
            {actions.includes('approve') && (
              <Button
                type="primary"
                loading={reviewPending === 'approve'}
                disabled={reviewPending === 'reject'}
                onClick={() => decide('approve')}
              >
                {t('reviews.approve')}
              </Button>
            )}
          </Space>
        </ConfigProvider>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {missing && <Alert role="alert" type="warning" showIcon message={t('requests.notFound')} />}
        {failed && <Alert role="alert" type="error" showIcon message={actionErrorMessage(failed, t)} />}
        {!canEdit && !missing && !failed && request && actions.length === 0 && (
          <Alert type="info" showIcon message={t('requests.readOnly')} />
        )}
        {loadedRequest?.reviewer && (
          <Typography.Text>{t('reviews.reviewer', { name: memberName(loadedRequest.reviewer) })}</Typography.Text>
        )}
        {stale && (
          <div ref={staleRef} tabIndex={-1} aria-label={t('reviews.staleTitle')}>
            <Alert
              role="alert"
              type="warning"
              showIcon
              message={t('reviews.staleTitle')}
              description={t('reviews.staleDescription', {
                state: t(`reviews.states.${stale.state}`),
                revision: stale.revision,
              })}
              action={
                <Button size="small" onClick={showLatest} disabled={!request}>
                  {t('reviews.showLatest')}
                </Button>
              }
            />
          </div>
        )}
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
          status.kind === 'ready' && (
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
        {events && events.length > 0 && (
          <section aria-label={t('reviews.history')}>
            <Typography.Title level={3} style={{ fontSize: 16 }}>
              {t('reviews.history')}
            </Typography.Title>
            <Timeline
              items={events.map((event) => ({
                key: event._id,
                children: (
                  <>
                    <div>{t(`reviews.events.${event.command}`, { actor: memberName(event.actor) })}</div>
                    <Typography.Text type="secondary">
                      {t('reviews.eventMeta', {
                        revision: event.revision,
                        at: new Date(event.at).toLocaleString(i18n.language),
                      })}
                    </Typography.Text>
                  </>
                ),
              }))}
            />
          </section>
        )}
      </Space>
    </Modal>
  );
}
