import React, { Component, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Col,
  ConfigProvider,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useConvexAuth, useMutation, useQueries, useQuery } from 'convex/react';
import type { RequestForQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import {
  RECORD_CREATED_SORT_FIELD,
  RECORD_FILTER_OPERATORS,
  DEFAULT_RECORD_PAGE_SIZE,
  MAX_RECORD_FILTERS,
  filterTakesValue,
  validateRecordQuery,
} from '../../convex/recordQuery';
import type { RecordFilter, RecordSort } from '../../convex/recordQuery';
import { authClient } from '../lib/auth/client';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { actionErrorMessage } from './actionErrors';
import { DefinitionBuilder } from './DefinitionBuilder';
import { runPendingAction, withoutMotion } from './pendingAction';
import { RequestsPanel } from './RequestsPanel';

type DemoValue = string | number | boolean;
type Collection = FunctionReturnType<typeof api.collections.list>['items'][number];
type SavedCollection = FunctionReturnType<typeof api.collections.get>;
type RecordPage = FunctionReturnType<typeof api.records.browse>;
type DemoRecord = RecordPage['items'][number];
type Workflow = FunctionReturnType<typeof api.workflows.list>['items'][number];
type WorkflowRun = FunctionReturnType<typeof api.workflows.listRuns>[number];
type DemoField = Collection['fields'][number];
type CollectionFormValues = { name: string; title: string; fields: DemoField[] };
type CollectionSettingsValues = { name: string; title: string };
type RecordFormValues = Record<string, DemoValue | null | undefined>;
type RecordQueryFormValues = {
  filters: Array<{ field?: string; operator?: string; value?: DemoValue | null }>;
  sortField: string;
  sortDirection: 'asc' | 'desc';
};
type AppliedRecordQuery = { filters: RecordFilter[]; sort: RecordSort };
type RecordBrowseState = AppliedRecordQuery & { collectionId?: Collection['_id']; page: number; pageSize: number };
type WorkflowFormValues = { name: string; collectionId: Collection['_id']; field: string; value: DemoValue | null };

const defaultRecordQuery: AppliedRecordQuery = {
  filters: [],
  sort: { field: RECORD_CREATED_SORT_FIELD, direction: 'desc' },
};

export default function DemoApp() {
  return (
    <DemoErrorBoundary>
      <DemoAppContent />
    </DemoErrorBoundary>
  );
}

class DemoErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="demo-page">
          <Alert type="error" showIcon message={i18n.t('common.error')} />
        </main>
      );
    }
    return this.props.children;
  }
}

function DemoAppContent() {
  const { t, i18n } = useTranslation();
  const { message } = AntdApp.useApp();
  const { data: session, isPending, isRefetching, error: sessionError } = authClient.useSession();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.getViewer, session && isAuthenticated ? {} : 'skip');
  const myMemberships = useQuery(api.memberships.listMine, session && isAuthenticated ? {} : 'skip');
  const builderApplications = (myMemberships ?? []).filter((item) => item.grants.includes('configureApplication'));
  const [activeTab, setActiveTab] = useState('data');
  const seed = useMutation(api.demo.seed);
  const [seeding, setSeeding] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) await message.error(t('common.actionFailed'));
    } catch {
      await message.error(t('common.actionFailed'));
    } finally {
      setSigningOut(false);
    }
  };

  if (
    isPending ||
    signingOut ||
    convexAuthLoading ||
    (!session && (isAuthenticated || isRefetching)) ||
    (session && isAuthenticated && viewer?.id !== session.user.id)
  ) {
    return (
      <div className="demo-page demo-centered">
        <Spin size="large" />
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  if (!isAuthenticated) {
    return (
      <main className="demo-page demo-centered">
        <Card className="demo-auth-card">
          <Alert type="warning" showIcon message={t('auth.sessionSync')} />
          <Button block style={{ marginTop: 16 }} onClick={signOut}>
            {t('nav.signOut')}
          </Button>
        </Card>
      </main>
    );
  }

  const loadSample = async () => {
    setSeeding(true);
    try {
      const result = await seed({ locale: i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US' });
      await message.success(t('collections.sampleLoaded'));
      setActiveTab('data');
      return result.collectionId;
    } catch {
      await message.error(t('common.actionFailed'));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <main className="demo-page">
      <header className="demo-header">
        <div className="demo-brand">
          <div className="demo-brand-mark">F</div>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t('app.name')}
            </Typography.Title>
            <Typography.Text className="demo-muted">{t('app.subtitle')}</Typography.Text>
          </div>
          <Tag color="blue">{t('app.demo')}</Tag>
        </div>
        <Space wrap>
          <Button onClick={() => i18n.changeLanguage(i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN')}>
            {t('common.language')}
          </Button>
          <Typography.Text className="demo-muted">{viewer?.name || viewer?.email}</Typography.Text>
          <Button onClick={signOut}>{t('nav.signOut')}</Button>
        </Space>
      </header>
      {sessionError && <Alert className="demo-content" type="error" showIcon message={t('common.error')} />}
      <section className="demo-content">
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'data',
              label: t('nav.data'),
              children: <CollectionsPanel onLoadSample={loadSample} seeding={seeding} />,
            },
            { key: 'workflows', label: t('nav.workflows'), children: <WorkflowsPanel /> },
            ...(myMemberships && myMemberships.length > 0
              ? [
                  {
                    key: 'requests',
                    label: t('nav.requests'),
                    children: <RequestsPanel applications={myMemberships} />,
                  },
                ]
              : []),
            ...(builderApplications.length > 0
              ? [
                  {
                    key: 'builder',
                    label: t('nav.builder'),
                    children: <DefinitionBuilder applications={builderApplications} />,
                  },
                ]
              : []),
          ]}
        />
      </section>
    </main>
  );
}

function AuthScreen() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (values: { name?: string; email: string; password: string }) => {
    setBusy(true);
    setFailed(false);
    try {
      const result =
        mode === 'signUp'
          ? await authClient.signUp.email({ name: values.name ?? '', email: values.email, password: values.password })
          : await authClient.signIn.email({ email: values.email, password: values.password });
      if (result.error) {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="demo-page demo-centered">
      <Card className="demo-auth-card">
        <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 20 }}>
          <div className="demo-brand-mark">F</div>
          <Typography.Title level={3}>{t('auth.welcome')}</Typography.Title>
          <Typography.Paragraph className="demo-muted">{t('auth.description')}</Typography.Paragraph>
        </Space>
        <Tabs
          activeKey={mode}
          onChange={(key) => {
            setMode(key as 'signIn' | 'signUp');
            setFailed(false);
          }}
          items={[
            { key: 'signIn', label: t('auth.signIn') },
            { key: 'signUp', label: t('auth.signUp') },
          ]}
        />
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          {mode === 'signUp' && (
            <Form.Item name="name" label={t('auth.name')} rules={[{ required: true, message: t('auth.required') }]}>
              <Input autoComplete="name" />
            </Form.Item>
          )}
          <Form.Item
            name="email"
            label={t('auth.email')}
            rules={[
              { required: true, message: t('auth.required') },
              { type: 'email', message: t('auth.invalidEmail') },
            ]}
          >
            <Input autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('auth.password')}
            rules={[
              { required: true, message: t('auth.required') },
              { min: 8, message: t('auth.minPassword') },
            ]}
          >
            <Input.Password autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'} />
          </Form.Item>
          {failed && <Alert type="error" showIcon message={t('auth.failed')} style={{ marginBottom: 16 }} />}
          <ConfigProvider theme={withoutMotion}>
            <Button type="primary" htmlType="submit" block loading={busy}>
              {t('auth.submit')}
            </Button>
          </ConfigProvider>
        </Form>
      </Card>
    </main>
  );
}

function CollectionsPanel({
  onLoadSample,
  seeding,
}: {
  onLoadSample: () => Promise<Collection['_id'] | undefined>;
  seeding: boolean;
}) {
  const { t } = useTranslation();
  const { message } = AntdApp.useApp();
  const data = useQuery(api.collections.list, {});
  const createCollection = useMutation(api.collections.create);
  const updateCollection = useMutation(api.collections.update);
  const removeCollection = useMutation(api.collections.remove);
  const [selectedId, setSelectedId] = useState<Collection['_id']>();
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recordModalOpen, setRecordModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DemoRecord>();
  const [recordError, setRecordError] = useState<string>();
  const [deletingRecordId, setDeletingRecordId] = useState<DemoRecord['_id']>();
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [collectionForm] = Form.useForm<CollectionFormValues>();
  const [settingsForm] = Form.useForm<CollectionSettingsValues>();
  const [recordForm] = Form.useForm<RecordFormValues>();
  const collections = data?.items ?? [];
  const selected = collections.find((collection) => collection._id === selectedId) ?? collections[0];
  const savedConfig = useQuery(api.collections.get, selected && settingsOpen ? { collectionId: selected._id } : 'skip');
  const [browseState, setBrowseState] = useState<RecordBrowseState>({
    ...defaultRecordQuery,
    page: 1,
    pageSize: DEFAULT_RECORD_PAGE_SIZE,
  });
  // Filters, sort, and page belong to one collection; selecting another collection starts from the defaults.
  const browse: RecordBrowseState =
    browseState.collectionId === selected?._id
      ? browseState
      : { ...defaultRecordQuery, collectionId: selected?._id, page: 1, pageSize: browseState.pageSize };
  const selectedCollectionId = selected?._id;
  // `useQueries` resubscribes whenever it receives a new request object, so the request must keep its identity between
  // renders.
  const browseRequest = useMemo((): RequestForQueries => {
    if (!selectedCollectionId) return {};
    return {
      page: {
        query: api.records.browse,
        args: {
          collectionId: selectedCollectionId,
          filters: browse.filters,
          sort: browse.sort,
          page: browse.page,
          pageSize: browse.pageSize,
        },
      },
    };
  }, [selectedCollectionId, browse.filters, browse.sort, browse.page, browse.pageSize]);
  const browseResults = useQueries(browseRequest);
  // `useQueries` returns errors as values instead of throwing, so a rejected query shows a translated message rather
  // than the error boundary.
  const browseResult: RecordPage | Error | undefined = browseResults.page;
  const browseError = browseResult instanceof Error ? browseResult : undefined;
  const loadedPage = browseResult instanceof Error ? undefined : browseResult;
  // Keep the previous page on screen while the next one loads, instead of flashing an empty table. `filtered` belongs
  // to that page, so the count label never mixes the old totals with the new filters.
  const [shownPage, setShownPage] = useState<{
    collectionId: Collection['_id'];
    result: RecordPage;
    filtered: boolean;
  }>();
  if (selected && loadedPage && shownPage?.result !== loadedPage) {
    setShownPage({ collectionId: selected._id, result: loadedPage, filtered: browse.filters.length > 0 });
  }
  const shown = shownPage?.collectionId === selected?._id ? shownPage : undefined;
  const recordPage = loadedPage ?? shown?.result;
  // The backend moves a page past the end (for example after deleting the last record on it) back to the last page;
  // follow it.
  if (loadedPage && loadedPage.page !== browse.page) {
    setBrowseState({ ...browse, page: loadedPage.page });
  }
  const createRecord = useMutation(api.records.create);
  const updateRecord = useMutation(api.records.update);
  const removeRecord = useMutation(api.records.remove);
  const records = recordPage?.items ?? [];
  const filtersApplied = browse.filters.length > 0;
  const shownFiltered = loadedPage ? filtersApplied : (shown?.filtered ?? filtersApplied);
  const fields = useMemo(() => selected?.fields ?? [], [selected]);

  useEffect(() => {
    if (settingsOpen && savedConfig) {
      settingsForm.setFieldsValue({ name: savedConfig.name, title: savedConfig.title });
    }
  }, [settingsOpen, savedConfig, settingsForm]);

  // The record modal is destroyed on close, so populate the form after it has mounted; writing values before the first
  // mount would hit a form instance that is not connected yet.
  useEffect(() => {
    if (!recordModalOpen) return;
    recordForm.resetFields();
    const initialValues = Object.fromEntries(
      fields.map((field) => [
        field.name,
        editingRecord?.values[field.name] ?? (field.type === 'boolean' ? false : undefined),
      ]),
    ) as RecordFormValues;
    recordForm.setFieldsValue(initialValues);
  }, [recordModalOpen, editingRecord, fields, recordForm]);

  const saveCollection = async (values: CollectionFormValues) => {
    setBusy(true);
    try {
      const collectionId = await createCollection(values);
      setSelectedId(collectionId);
      setCollectionModalOpen(false);
      collectionForm.resetFields();
      await message.success(t('collections.saved'));
    } catch (error) {
      await message.error(actionErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (values: CollectionSettingsValues) => {
    if (!savedConfig) return;
    setSettingsBusy(true);
    try {
      await updateCollection({ collectionId: savedConfig._id, name: values.name, title: values.title });
      setSettingsOpen(false);
      await message.success(t('collections.renamed'));
    } catch (error) {
      await message.error(actionErrorMessage(error, t));
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveRecord = async (values: RecordFormValues) => {
    if (!selected) return;
    const cleanValues = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
    ) as Record<string, DemoValue>;
    setBusy(true);
    setRecordError(undefined);
    try {
      if (editingRecord) {
        await updateRecord({ recordId: editingRecord._id, values: cleanValues });
      } else {
        await createRecord({ collectionId: selected._id, values: cleanValues });
      }
      setRecordModalOpen(false);
      setEditingRecord(undefined);
      await message.success(t('collections.recordSaved'));
    } catch (error) {
      setRecordError(actionErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const openRecord = (record?: DemoRecord) => {
    setRecordError(undefined);
    setEditingRecord(record);
    setRecordModalOpen(true);
  };

  const deleteRecord = (record: DemoRecord) => {
    runPendingAction(
      (pending) => setDeletingRecordId(pending ? record._id : undefined),
      () => removeRecord({ recordId: record._id }),
    )
      .then(() => message.success(t('collections.recordDeleted')))
      .catch((error: unknown) => message.error(actionErrorMessage(error, t)));
  };

  const applyRecordQuery = (query: AppliedRecordQuery) => {
    setBrowseState({ ...browse, ...query, page: 1 });
  };

  const changeRecordPage = (page: number, pageSize: number) => {
    setBrowseState({ ...browse, page: pageSize === browse.pageSize ? page : 1, pageSize });
  };

  const deleteCollection = () => {
    if (!selected) return;
    removeCollection({ collectionId: selected._id })
      .then(() => {
        setSelectedId(undefined);
        return message.success(t('collections.collectionDeleted'));
      })
      .catch((error: unknown) => message.error(actionErrorMessage(error, t)));
  };

  const columns: TableColumnsType<DemoRecord> = [
    ...fields.map((field) => ({
      title: field.name,
      key: field.name,
      render: (_: unknown, record: DemoRecord) => displayValue(record.values[field.name], t),
    })),
    {
      title: t('common.edit'),
      key: 'actions',
      width: 150,
      render: (_: unknown, record: DemoRecord) => (
        <ConfigProvider theme={withoutMotion}>
          <Space>
            <Button size="small" disabled={deletingRecordId !== undefined} onClick={() => openRecord(record)}>
              {t('common.edit')}
            </Button>
            <Popconfirm
              title={t('records.deleteConfirm')}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              onConfirm={() => deleteRecord(record)}
            >
              <Button
                size="small"
                danger
                loading={deletingRecordId === record._id}
                disabled={deletingRecordId !== undefined}
              >
                {t('common.delete')}
              </Button>
            </Popconfirm>
          </Space>
        </ConfigProvider>
      ),
    },
  ];

  if (data === undefined)
    return (
      <div className="demo-centered">
        <Spin />
      </div>
    );

  return (
    <>
      <div className="demo-workspace-title">
        <div>
          <Typography.Title level={3}>{t('collections.title')}</Typography.Title>
          <Typography.Text className="demo-muted">{t('collections.description')}</Typography.Text>
        </div>
        <ConfigProvider theme={withoutMotion}>
          <Space wrap>
            {collections.length === 0 && (
              <Button
                loading={seeding}
                onClick={() => {
                  onLoadSample()
                    .then((id) => {
                      if (id) setSelectedId(id);
                    })
                    .catch((error: unknown) => message.error(actionErrorMessage(error, t)));
                }}
              >
                {t('collections.loadSample')}
              </Button>
            )}
            <Button type="primary" onClick={() => setCollectionModalOpen(true)}>
              {t('collections.add')}
            </Button>
          </Space>
        </ConfigProvider>
      </div>
      {collections.length === 0 ? (
        <Card className="demo-section-card">
          <Empty description={t('collections.empty')} />
        </Card>
      ) : (
        <Row gutter={[20, 20]}>
          <Col xs={24} md={7}>
            <Card className="demo-section-card" title={t('collections.title')}>
              <div className="demo-collection-list">
                {collections.map((collection) => (
                  <Button
                    key={collection._id}
                    type={collection._id === selected?._id ? 'primary' : 'default'}
                    className="demo-collection-option"
                    onClick={() => setSelectedId(collection._id)}
                  >
                    {collection.title || collection.name}
                  </Button>
                ))}
              </div>
            </Card>
          </Col>
          <Col xs={24} md={17}>
            <Card
              className="demo-section-card"
              title={
                <Space wrap>
                  <span>{selected?.title || selected?.name}</span>
                  <Tag>
                    {recordPage === undefined
                      ? t('common.loading')
                      : shownFiltered
                        ? t('records.matching', { count: recordPage.total, total: recordPage.collectionTotal })
                        : t('records.count', { count: recordPage.collectionTotal })}
                  </Tag>
                </Space>
              }
              extra={
                <ConfigProvider theme={withoutMotion}>
                  <Space wrap>
                    <Button onClick={() => setSettingsOpen(true)}>{t('collections.settings')}</Button>
                    <Button onClick={() => openRecord()}>{t('collections.addRecord')}</Button>
                    {recordPage !== undefined && recordPage.collectionTotal === 0 && selected && (
                      <Popconfirm title={t('collections.removeConfirm')} onConfirm={deleteCollection}>
                        <Button danger>{t('collections.deleteEmpty')}</Button>
                      </Popconfirm>
                    )}
                  </Space>
                </ConfigProvider>
              }
            >
              {selected && (recordPage === undefined || recordPage.collectionTotal > 0 || filtersApplied) && (
                <RecordQueryForm
                  key={`${selected._id}:${JSON.stringify([browse.filters, browse.sort])}`}
                  fields={fields}
                  applied={browse}
                  onApply={applyRecordQuery}
                  onReset={() => applyRecordQuery(defaultRecordQuery)}
                />
              )}
              {browseError ? (
                <Alert
                  type="error"
                  showIcon
                  message={actionErrorMessage(browseError, t)}
                  action={
                    <Button size="small" onClick={() => applyRecordQuery(defaultRecordQuery)}>
                      {t('records.reset')}
                    </Button>
                  }
                />
              ) : recordPage === undefined ? (
                <output aria-label={t('common.loading')}>
                  <Spin />
                </output>
              ) : recordPage.collectionTotal === 0 ? (
                <Empty description={t('collections.noRecords')} />
              ) : recordPage.total === 0 ? (
                <Empty description={t('records.noMatches')} />
              ) : (
                <Table
                  rowKey="_id"
                  size="small"
                  scroll={{ x: true }}
                  dataSource={records}
                  columns={columns}
                  loading={loadedPage === undefined}
                  pagination={{
                    current: recordPage.page,
                    pageSize: recordPage.pageSize,
                    total: recordPage.total,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50, 100],
                    onChange: changeRecordPage,
                  }}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}
      <Modal
        title={t('collections.add')}
        open={collectionModalOpen}
        onCancel={() => setCollectionModalOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form
          name="collection-create"
          form={collectionForm}
          layout="vertical"
          onFinish={saveCollection}
          initialValues={{ fields: [{ name: 'title', type: 'text', required: true }] }}
        >
          <Form.Item
            name="title"
            label={t('collections.displayName')}
            rules={[{ required: true, message: t('auth.required') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('collections.name')}
            rules={[
              { required: true, message: t('auth.required') },
              { pattern: /^[a-z][a-z0-9_]*$/, message: t('collections.nameInvalid') },
            ]}
          >
            <Input />
          </Form.Item>
          <Typography.Text strong>{t('collections.fields')}</Typography.Text>
          <Form.List name="fields">
            {(items, { add, remove }) => (
              <>
                {items.map((item) => (
                  <Space key={item.key} align="baseline" wrap>
                    <Form.Item
                      {...item}
                      key={`${item.key}-name`}
                      name={[item.name, 'name']}
                      label={t('collections.fieldName')}
                      rules={[
                        { required: true, message: t('auth.required') },
                        { pattern: /^[a-z][a-z0-9_]*$/, message: t('collections.fieldInvalid') },
                      ]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      {...item}
                      key={`${item.key}-type`}
                      name={[item.name, 'type']}
                      label={t('collections.fieldType')}
                      rules={[{ required: true, message: t('auth.required') }]}
                    >
                      <Select style={{ minWidth: 110 }} options={fieldTypeOptions(t)} />
                    </Form.Item>
                    <Form.Item
                      {...item}
                      key={`${item.key}-required`}
                      name={[item.name, 'required']}
                      valuePropName="checked"
                    >
                      <Checkbox>{t('collections.required')}</Checkbox>
                    </Form.Item>
                    {items.length > 1 && (
                      <Button danger onClick={() => remove(item.name)}>
                        {t('common.delete')}
                      </Button>
                    )}
                  </Space>
                ))}
                <Button onClick={() => add({ name: '', type: 'text', required: false })}>
                  {t('collections.addField')}
                </Button>
              </>
            )}
          </Form.List>
          <Form.Item style={{ marginTop: 20, marginBottom: 0 }}>
            <ConfigProvider theme={withoutMotion}>
              <Space>
                <Button onClick={() => setCollectionModalOpen(false)}>{t('common.cancel')}</Button>
                <Button type="primary" htmlType="submit" loading={busy}>
                  {t('common.create')}
                </Button>
              </Space>
            </ConfigProvider>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('collections.settings')}
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
      >
        {savedConfig === undefined ? (
          <div className="demo-centered">
            <Spin />
          </div>
        ) : (
          <Form name="collection-settings" form={settingsForm} layout="vertical" onFinish={saveRename}>
            <Form.Item
              name="title"
              label={t('collections.displayName')}
              rules={[{ required: true, message: t('auth.required') }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="name"
              label={t('collections.name')}
              rules={[
                { required: true, message: t('auth.required') },
                { pattern: /^[a-z][a-z0-9_]*$/, message: t('collections.nameInvalid') },
              ]}
            >
              <Input />
            </Form.Item>
            <Typography.Text strong>{t('collections.fields')}</Typography.Text>
            <ul className="demo-field-list">
              {savedConfig.fields.map((field) => (
                <li key={field.name}>
                  <Typography.Text code>{field.name}</Typography.Text>
                  <span className="demo-muted">{t(`collections.${field.type}`)}</span>
                  {field.required && <Tag>{t('collections.required')}</Tag>}
                </li>
              ))}
            </ul>
            <Form.Item style={{ marginTop: 20, marginBottom: 0 }}>
              <ConfigProvider theme={withoutMotion}>
                <Space>
                  <Button onClick={() => setSettingsOpen(false)}>{t('common.cancel')}</Button>
                  <Button type="primary" htmlType="submit" loading={settingsBusy}>
                    {t('common.save')}
                  </Button>
                </Space>
              </ConfigProvider>
            </Form.Item>
          </Form>
        )}
      </Modal>
      <Modal
        title={editingRecord ? t('common.edit') : t('collections.addRecord')}
        open={recordModalOpen}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        onCancel={() => {
          setRecordModalOpen(false);
          setEditingRecord(undefined);
        }}
        footer={null}
        destroyOnClose
      >
        <Form name="collection-record" form={recordForm} layout="vertical" onFinish={saveRecord}>
          {fields.map((field) => (
            <Form.Item
              key={field.name}
              name={field.name}
              label={field.name}
              valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
              rules={
                field.required && field.type !== 'boolean'
                  ? field.type === 'text'
                    ? [{ required: true, whitespace: true, message: t('auth.required') }]
                    : [{ required: true, type: 'number', message: t('auth.required') }]
                  : []
              }
            >
              {field.type === 'number' ? (
                <InputNumber style={{ width: '100%' }} />
              ) : field.type === 'boolean' ? (
                <Switch />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
          {recordError && (
            <Alert role="alert" type="error" showIcon message={recordError} style={{ marginBottom: 16 }} />
          )}
          <Form.Item style={{ marginBottom: 0 }}>
            <ConfigProvider theme={withoutMotion}>
              <Space>
                <Button disabled={busy} onClick={() => setRecordModalOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="primary" htmlType="submit" loading={busy}>
                  {t('common.save')}
                </Button>
              </Space>
            </ConfigProvider>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function WorkflowsPanel() {
  const { t } = useTranslation();
  const { message } = AntdApp.useApp();
  const collectionsData = useQuery(api.collections.list, {});
  const workflowData = useQuery(api.workflows.list, {});
  const collections = collectionsData?.items ?? [];
  const workflows = workflowData?.items ?? [];
  const [selectedId, setSelectedId] = useState<Workflow['_id']>();
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<WorkflowFormValues>();
  const collectionId = Form.useWatch('collectionId', form);
  const selectedCollection = collections.find((collection) => collection._id === collectionId) ?? collections[0];
  const selectedWorkflow = workflows.find((workflow) => workflow._id === selectedId) ?? workflows[0];
  const runData = useQuery(api.workflows.listRuns, selectedWorkflow ? { workflowId: selectedWorkflow._id } : 'skip');
  const createWorkflow = useMutation(api.workflows.create);
  const runWorkflow = useMutation(api.workflows.run);

  const saveWorkflow = async (values: WorkflowFormValues) => {
    if (values.value === null || values.value === undefined) return;
    setBusy(true);
    try {
      const result = await createWorkflow({ ...values, value: values.value });
      setSelectedId(result.workflowId);
      setModalOpen(false);
      form.resetFields();
      await message.success(t('workflows.created'));
    } catch (error) {
      await message.error(t('common.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const run = () => {
    if (!selectedWorkflow) return;
    runPendingAction(setBusy, () => runWorkflow({ workflowId: selectedWorkflow._id }))
      .then((result) => message.success(t('workflows.updated', { count: result.updatedCount })))
      .catch(() => message.error(t('workflows.runFailed')));
  };

  if (workflowData === undefined || collectionsData === undefined)
    return (
      <div className="demo-centered">
        <Spin />
      </div>
    );

  return (
    <>
      <div className="demo-workspace-title">
        <div>
          <Typography.Title level={3}>{t('workflows.title')}</Typography.Title>
          <Typography.Text className="demo-muted">{t('workflows.description')}</Typography.Text>
        </div>
        <Button type="primary" disabled={collections.length === 0} onClick={() => setModalOpen(true)}>
          {t('workflows.add')}
        </Button>
      </div>
      {collections.length === 0 ? (
        <Card className="demo-section-card">
          <Empty description={t('workflows.selectCollection')} />
        </Card>
      ) : workflows.length === 0 ? (
        <Card className="demo-section-card">
          <Empty description={t('workflows.empty')} />
        </Card>
      ) : (
        <Row gutter={[20, 20]}>
          <Col xs={24} md={8}>
            <Card className="demo-section-card" title={t('workflows.title')}>
              <div className="demo-collection-list">
                {workflows.map((workflow) => (
                  <Button
                    key={workflow._id}
                    className="demo-collection-option"
                    type={workflow._id === selectedWorkflow?._id ? 'primary' : 'default'}
                    onClick={() => setSelectedId(workflow._id)}
                  >
                    {workflow.name}
                  </Button>
                ))}
              </div>
            </Card>
          </Col>
          <Col xs={24} md={16}>
            <Card
              className="demo-section-card"
              title={selectedWorkflow?.name}
              extra={
                <ConfigProvider theme={withoutMotion}>
                  <Button type="primary" loading={busy} onClick={run}>
                    {t('workflows.run')}
                  </Button>
                </ConfigProvider>
              }
            >
              <Typography.Paragraph>
                {t('workflows.field')}: <Typography.Text strong>{selectedWorkflow?.field}</Typography.Text>
                {' · '}
                {t('workflows.value')}:{' '}
                <Typography.Text code>{displayValue(selectedWorkflow?.value, t)}</Typography.Text>
              </Typography.Paragraph>
              <Typography.Title level={5}>{t('workflows.history')}</Typography.Title>
              {runData === undefined ? (
                <Spin />
              ) : runData.length === 0 ? (
                <Empty description={t('workflows.noRuns')} />
              ) : (
                <Table<WorkflowRun>
                  rowKey="_id"
                  size="small"
                  pagination={false}
                  dataSource={runData}
                  columns={[
                    {
                      title: t('workflows.completedAt'),
                      dataIndex: 'completedAt',
                      render: (value: number) => new Date(value).toLocaleString(),
                    },
                    {
                      title: t('workflows.completed'),
                      dataIndex: 'status',
                      render: () => <Tag color="green">{t('workflows.completed')}</Tag>,
                    },
                    {
                      title: t('collections.records'),
                      dataIndex: 'updatedCount',
                      render: (count: number) => t('workflows.updated', { count }),
                    },
                  ]}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}
      <Modal
        title={t('workflows.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form
          name="workflow-create"
          form={form}
          layout="vertical"
          onFinish={saveWorkflow}
          initialValues={{ collectionId: collections[0]?._id }}
        >
          <Form.Item name="name" label={t('workflows.name')} rules={[{ required: true, message: t('auth.required') }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="collectionId"
            label={t('workflows.collection')}
            rules={[{ required: true, message: t('auth.required') }]}
          >
            <Select
              options={collections.map((collection) => ({
                value: collection._id,
                label: collection.title || collection.name,
              }))}
              onChange={() => form.setFieldsValue({ field: undefined, value: null })}
            />
          </Form.Item>
          <Form.Item
            name="field"
            label={t('workflows.field')}
            rules={[{ required: true, message: t('auth.required') }]}
          >
            <Select
              options={(selectedCollection?.fields ?? []).map((field) => ({ value: field.name, label: field.name }))}
              onChange={(fieldName: string) => {
                const field = selectedCollection?.fields.find((item) => item.name === fieldName);
                form.setFieldValue('value', field?.type === 'boolean' ? false : undefined);
              }}
            />
          </Form.Item>
          <WorkflowValueField fields={selectedCollection?.fields ?? []} />
          <Form.Item style={{ marginBottom: 0 }}>
            <ConfigProvider theme={withoutMotion}>
              <Space>
                <Button onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
                <Button type="primary" htmlType="submit" loading={busy}>
                  {t('common.create')}
                </Button>
              </Space>
            </ConfigProvider>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function toQueryFormValues(query: AppliedRecordQuery): RecordQueryFormValues {
  return {
    filters: query.filters.map((filter) => ({ ...filter })),
    sortField: query.sort.field,
    sortDirection: query.sort.direction === 'asc' ? 'asc' : 'desc',
  };
}

// A new or re-targeted filter row starts with the first condition its field type supports.
function newFilterRow(field: DemoField | undefined): RecordQueryFormValues['filters'][number] {
  return { field: field?.name, operator: field && RECORD_FILTER_OPERATORS[field.type][0], value: undefined };
}

function RecordQueryForm({
  fields,
  applied,
  onApply,
  onReset,
}: {
  fields: DemoField[];
  applied: AppliedRecordQuery;
  onApply: (query: AppliedRecordQuery) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<RecordQueryFormValues>();
  const [error, setError] = useState<string>();
  const initialValues = toQueryFormValues(applied);

  const submit = (values: RecordQueryFormValues) => {
    const query: AppliedRecordQuery = {
      filters: (values.filters ?? []).map(({ field = '', operator = '', value }) =>
        filterTakesValue(operator) && value !== null && value !== undefined
          ? { field, operator, value }
          : { field, operator },
      ),
      sort: { field: values.sortField, direction: values.sortDirection },
    };
    try {
      validateRecordQuery(fields, query);
    } catch (validationError) {
      setError(actionErrorMessage(validationError, t));
      return;
    }
    setError(undefined);
    onApply(query);
  };

  const reset = () => {
    form.setFieldsValue(toQueryFormValues(defaultRecordQuery));
    setError(undefined);
    onReset();
  };

  return (
    <Form
      name="record-query"
      form={form}
      layout="vertical"
      className="demo-record-query"
      initialValues={initialValues}
      onFinish={submit}
      onValuesChange={() => setError(undefined)}
    >
      <Form.List name="filters">
        {(items, { add, remove }) => (
          <fieldset className="demo-record-filters">
            <legend>{t('records.filters')}</legend>
            {items.map((item, position) => (
              <RecordFilterRow
                key={item.key}
                name={item.name}
                index={position + 1}
                fields={fields}
                onRemove={() => remove(item.name)}
              />
            ))}
            <Button disabled={items.length >= MAX_RECORD_FILTERS} onClick={() => add(newFilterRow(fields[0]))}>
              {t('records.addFilter')}
            </Button>
          </fieldset>
        )}
      </Form.List>
      <Space wrap align="end">
        <Form.Item name="sortField" label={t('records.sortField')}>
          <Select
            style={{ minWidth: 180 }}
            options={[
              { value: RECORD_CREATED_SORT_FIELD, label: t('records.createdTime') },
              ...fields.map((field) => ({ value: field.name, label: field.name })),
            ]}
          />
        </Form.Item>
        <Form.Item name="sortDirection" label={t('records.sortDirection')}>
          <Select
            style={{ minWidth: 140 }}
            options={[
              { value: 'asc', label: t('records.ascending') },
              { value: 'desc', label: t('records.descending') },
            ]}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              {t('records.apply')}
            </Button>
            <Button onClick={reset}>{t('records.reset')}</Button>
          </Space>
        </Form.Item>
      </Space>
      {error && <Alert type="error" showIcon message={error} role="alert" />}
    </Form>
  );
}

function RecordFilterRow({
  name,
  index,
  fields,
  onRemove,
}: {
  name: number;
  index: number;
  fields: DemoField[];
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<RecordQueryFormValues>();
  const fieldName = Form.useWatch(['filters', name, 'field'], form);
  const operator = Form.useWatch(['filters', name, 'operator'], form);
  const field = fields.find((candidate) => candidate.name === fieldName);
  const operators: readonly string[] = field ? RECORD_FILTER_OPERATORS[field.type] : [];

  // A different field type supports different conditions and values, so start the row over for the new field.
  const changeField = (next: string) => {
    const nextField = fields.find((candidate) => candidate.name === next);
    // Replace the whole list: `setFieldValue` on a single path makes antd log a false circular-reference warning in
    // development.
    const filters: RecordQueryFormValues['filters'] = form.getFieldValue('filters');
    form.setFieldsValue({
      filters: filters.map((filter, position) => (position === name ? newFilterRow(nextField) : filter)),
    });
  };

  return (
    <Space wrap align="start" className="demo-record-filter">
      <Form.Item name={[name, 'field']} noStyle>
        <Select
          aria-label={t('records.filterField', { index })}
          style={{ minWidth: 150 }}
          options={fields.map((candidate) => ({ value: candidate.name, label: candidate.name }))}
          onChange={changeField}
        />
      </Form.Item>
      <Form.Item name={[name, 'operator']} noStyle>
        <Select
          aria-label={t('records.filterOperator', { index })}
          style={{ minWidth: 160 }}
          options={operators.map((value) => ({ value, label: t(`records.operators.${value.slice(1)}`) }))}
        />
      </Form.Item>
      {field && operator && filterTakesValue(operator) && (
        <Form.Item name={[name, 'value']} noStyle>
          {field.type === 'number' ? (
            <InputNumber aria-label={t('records.filterValue', { index })} style={{ width: 160 }} />
          ) : (
            <Input aria-label={t('records.filterValue', { index })} style={{ width: 200 }} />
          )}
        </Form.Item>
      )}
      <Button aria-label={t('records.removeFilter', { index })} onClick={onRemove}>
        {t('records.remove')}
      </Button>
    </Space>
  );
}

function WorkflowValueField({ fields }: { fields: DemoField[] }) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<WorkflowFormValues>();
  const fieldName = Form.useWatch('field', form);
  const field = fields.find((item) => item.name === fieldName);
  return (
    <Form.Item
      name="value"
      label={t('workflows.value')}
      valuePropName={field?.type === 'boolean' ? 'checked' : 'value'}
      rules={field?.type !== 'boolean' ? [{ required: true, message: t('auth.required') }] : []}
    >
      {field?.type === 'number' ? (
        <InputNumber style={{ width: '100%' }} />
      ) : field?.type === 'boolean' ? (
        <Switch />
      ) : (
        <Input />
      )}
    </Form.Item>
  );
}

function fieldTypeOptions(t: (key: string) => string) {
  return [
    { value: 'text', label: t('collections.text') },
    { value: 'number', label: t('collections.number') },
    { value: 'boolean', label: t('collections.boolean') },
  ];
}

function displayValue(value: unknown, t: (key: string) => string) {
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  return value === null || value === undefined ? '—' : String(value);
}
