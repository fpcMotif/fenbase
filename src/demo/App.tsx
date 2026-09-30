import React, { Component, useState } from 'react';
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
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { authClient } from '../lib/auth/client';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';

type DemoValue = string | number | boolean;
type Collection = FunctionReturnType<typeof api.collections.list>['items'][number];
type DemoRecord = FunctionReturnType<typeof api.records.list>['items'][number];
type Workflow = FunctionReturnType<typeof api.workflows.list>['items'][number];
type WorkflowRun = FunctionReturnType<typeof api.workflows.listRuns>[number];
type DemoField = Collection['fields'][number];
type CollectionFormValues = { name: string; title: string; fields: DemoField[] };
type RecordFormValues = Record<string, DemoValue | null | undefined>;
type WorkflowFormValues = { name: string; collectionId: Collection['_id']; field: string; value: DemoValue | null };

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
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.getViewer, session && isAuthenticated ? {} : 'skip');
  const [activeTab, setActiveTab] = useState('data');
  const seed = useMutation(api.demo.seed);
  const [seeding, setSeeding] = useState(false);

  if (isPending || (session && (convexAuthLoading || (isAuthenticated && viewer === undefined)))) {
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
          <Button block style={{ marginTop: 16 }} onClick={() => authClient.signOut()}>
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
          <Button onClick={() => authClient.signOut()}>{t('nav.signOut')}</Button>
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
          <Button type="primary" htmlType="submit" block loading={busy}>
            {t('auth.submit')}
          </Button>
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
  const removeCollection = useMutation(api.collections.remove);
  const [selectedId, setSelectedId] = useState<Collection['_id']>();
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [recordModalOpen, setRecordModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DemoRecord>();
  const [busy, setBusy] = useState(false);
  const [collectionForm] = Form.useForm<CollectionFormValues>();
  const [recordForm] = Form.useForm<RecordFormValues>();
  const collections = data?.items ?? [];
  const selected = collections.find((collection) => collection._id === selectedId) ?? collections[0];
  const recordData = useQuery(api.records.list, selected ? { collectionId: selected._id, limit: 100 } : 'skip');
  const createRecord = useMutation(api.records.create);
  const updateRecord = useMutation(api.records.update);
  const removeRecord = useMutation(api.records.remove);
  const records = recordData?.items ?? [];
  const fields = selected?.fields ?? [];

  const saveCollection = async (values: CollectionFormValues) => {
    setBusy(true);
    try {
      const collectionId = await createCollection(values);
      setSelectedId(collectionId);
      setCollectionModalOpen(false);
      collectionForm.resetFields();
      await message.success(t('collections.saved'));
    } catch {
      await message.error(t('common.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveRecord = async (values: RecordFormValues) => {
    if (!selected) return;
    const cleanValues = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
    ) as Record<string, DemoValue>;
    setBusy(true);
    try {
      if (editingRecord) {
        await updateRecord({ recordId: editingRecord._id, values: cleanValues });
      } else {
        await createRecord({ collectionId: selected._id, values: cleanValues });
      }
      setRecordModalOpen(false);
      setEditingRecord(undefined);
      recordForm.resetFields();
      await message.success(t('collections.recordSaved'));
    } catch {
      await message.error(t('common.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openRecord = (record?: DemoRecord) => {
    setEditingRecord(record);
    recordForm.resetFields();
    const initialValues = Object.fromEntries(
      fields.map((field) => [field.name, record?.values[field.name] ?? (field.type === 'boolean' ? false : undefined)]),
    ) as RecordFormValues;
    recordForm.setFieldsValue(initialValues);
    setRecordModalOpen(true);
  };

  const deleteRecord = async (record: DemoRecord) => {
    try {
      await removeRecord({ recordId: record._id });
      await message.success(t('collections.recordDeleted'));
    } catch {
      await message.error(t('common.actionFailed'));
    }
  };

  const deleteCollection = async () => {
    if (!selected) return;
    try {
      await removeCollection({ collectionId: selected._id });
      setSelectedId(undefined);
      await message.success(t('collections.collectionDeleted'));
    } catch {
      await message.error(t('common.actionFailed'));
    }
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
        <Space>
          <Button size="small" onClick={() => openRecord(record)}>
            {t('common.edit')}
          </Button>
          <Popconfirm title={t('common.delete')} onConfirm={() => deleteRecord(record)}>
            <Button size="small" danger>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </Space>
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
        <Space wrap>
          {collections.length === 0 && (
            <Button
              loading={seeding}
              onClick={async () => {
                const id = await onLoadSample();
                if (id) setSelectedId(id);
              }}
            >
              {t('collections.loadSample')}
            </Button>
          )}
          <Button type="primary" onClick={() => setCollectionModalOpen(true)}>
            {t('collections.add')}
          </Button>
        </Space>
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
                    {records.length} {t('collections.records').toLowerCase()}
                  </Tag>
                </Space>
              }
              extra={
                <Space wrap>
                  <Button onClick={() => openRecord()}>{t('collections.addRecord')}</Button>
                  {records.length === 0 && selected && (
                    <Popconfirm title={t('collections.removeConfirm')} onConfirm={deleteCollection}>
                      <Button danger>{t('collections.deleteEmpty')}</Button>
                    </Popconfirm>
                  )}
                </Space>
              }
            >
              {recordData === undefined ? (
                <Spin />
              ) : records.length === 0 ? (
                <Empty description={t('collections.noRecords')} />
              ) : (
                <>
                  <Table
                    rowKey="_id"
                    size="small"
                    scroll={{ x: true }}
                    dataSource={records}
                    columns={columns}
                    pagination={{ pageSize: 10 }}
                  />
                  {recordData.hasMore && (
                    <Typography.Text className="demo-muted">{t('collections.limit')}</Typography.Text>
                  )}
                </>
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
              { pattern: /^[a-z][a-z0-9_]*$/, message: t('collections.nameRule') },
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
                      name={[item.name, 'name']}
                      label={t('collections.fieldName')}
                      rules={[{ required: true, message: t('auth.required') }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      {...item}
                      name={[item.name, 'type']}
                      label={t('collections.fieldType')}
                      rules={[{ required: true, message: t('auth.required') }]}
                    >
                      <Select style={{ minWidth: 110 }} options={fieldTypeOptions(t)} />
                    </Form.Item>
                    <Form.Item {...item} name={[item.name, 'required']} valuePropName="checked">
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
            <Space>
              <Button onClick={() => setCollectionModalOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={busy}>
                {t('common.create')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={editingRecord ? t('common.edit') : t('collections.addRecord')}
        open={recordModalOpen}
        onCancel={() => {
          setRecordModalOpen(false);
          setEditingRecord(undefined);
        }}
        footer={null}
        destroyOnClose
      >
        <Form form={recordForm} layout="vertical" onFinish={saveRecord}>
          {fields.map((field) => (
            <Form.Item
              key={field.name}
              name={field.name}
              label={field.name}
              valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
              rules={
                field.required && field.type !== 'boolean' ? [{ required: true, message: t('auth.required') }] : []
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
          <Form.Item style={{ marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setRecordModalOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={busy}>
                {t('common.save')}
              </Button>
            </Space>
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

  const run = async () => {
    if (!selectedWorkflow) return;
    setBusy(true);
    try {
      const result = await runWorkflow({ workflowId: selectedWorkflow._id });
      await message.success(t('workflows.updated', { count: result.updatedCount }));
    } catch (error) {
      await message.error(t('workflows.runFailed'));
    } finally {
      setBusy(false);
    }
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
                <Button type="primary" loading={busy} onClick={run}>
                  {t('workflows.run')}
                </Button>
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
            <Space>
              <Button onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={busy}>
                {t('common.create')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </>
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
