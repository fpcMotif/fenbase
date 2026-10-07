import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { FormRule, TableColumnsType } from 'antd';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslation } from 'react-i18next';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
  DEFINITION_FIELD_TYPES,
  FIELD_KEY_PATTERN,
  MAX_DEFINITION_FIELDS,
  MAX_LABEL_LENGTH,
  MAX_TEXT_FIELD_LENGTH,
  POLICY_PRESETS,
  SYSTEM_LIST_COLUMNS,
} from '../../convex/definitionModel';
import { actionErrorData, actionErrorMessage } from './actionErrors';
import { runPendingAction, withoutMotion } from './pendingAction';
import {
  emptyForm,
  incompleteDateRuleControl,
  invalidLabelControl,
  newFieldRow,
  toDefinition,
  toFormValues,
  type BuilderFormValues,
  type FieldRow,
} from './definitionForm';

type BuilderApplication = FunctionReturnType<typeof api.memberships.listMine>[number];
type BuilderState = FunctionReturnType<typeof api.applicationDefinitions.getBuilderState>;
type VersionSummary = BuilderState['versions'][number];

function membershipReference(membershipId: string): string {
  return membershipId.slice(-6);
}

export function DefinitionBuilder({ applications }: { applications: BuilderApplication[] }) {
  const { t } = useTranslation();
  const [applicationId, setApplicationId] = useState<Id<'applications'>>(applications[0].applicationId);
  const selectedApplication = applications.find((item) => item.applicationId === applicationId) ?? applications[0];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {applications.length > 1 && (
        <Form layout="vertical">
          <Form.Item label={t('builder.application')} htmlFor="builder-application">
            <Select
              id="builder-application"
              value={selectedApplication.applicationId}
              onChange={setApplicationId}
              options={applications.map((item) => ({
                value: item.applicationId,
                label: `${item.organizationName} · ${item.applicationName}`,
              }))}
            />
          </Form.Item>
        </Form>
      )}
      <ApplicationDefinitionEditor key={selectedApplication.applicationId} application={selectedApplication} />
    </Space>
  );
}

function ApplicationDefinitionEditor({ application }: { application: BuilderApplication }) {
  const { t, i18n } = useTranslation();
  const { message } = AntdApp.useApp();
  const state = useQuery(api.applicationDefinitions.getBuilderState, { applicationId: application.applicationId });
  const saveDraft = useMutation(api.applicationDefinitions.saveDraft);
  const publish = useMutation(api.applicationDefinitions.publish);
  const [form] = Form.useForm<BuilderFormValues>();
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);
  const watchedFields = Form.useWatch('fields', form) ?? [];

  const loadedStateRef = useRef<BuilderState | null>(null);

  const loadFromServer = useCallback(
    (builderState: BuilderState) => {
      loadedStateRef.current = builderState;
      form.resetFields();
      form.setFieldsValue(builderState.head ? toFormValues(builderState.head.draft) : emptyForm);
      setBaseRevision(builderState.head?.revision ?? 0);
      setDirty(false);
      setConflictRevision(null);
    },
    [form],
  );

  useEffect(() => {
    if (state && !dirty && loadedStateRef.current !== state) loadFromServer(state);
  }, [state, dirty, loadFromServer]);

  useEffect(() => {
    if (conflictRevision !== null) conflictRef.current?.focus();
  }, [conflictRevision]);

  if (state === undefined) {
    return (
      <div className="demo-centered" style={{ padding: 48 }}>
        <Spin aria-label={t('common.loading')} />
      </div>
    );
  }

  const head = state.head;
  const publishedKeys = new Map(state.publishedKeys.map((entry) => [entry.key, entry.type]));
  const fieldKeys = watchedFields.map((row) => row?.key?.trim()).filter((key): key is string => Boolean(key));
  const dateKeys = watchedFields.filter((row) => row?.type === 'date' && row.key?.trim()).map((row) => row.key.trim());
  const fieldLabel = (key: string) => {
    const row = watchedFields.find((candidate) => candidate?.key?.trim() === key);
    const label = (i18n.language === 'zh-CN' ? row?.labelZhCN : row?.labelEnUS)?.trim();
    return label ? t('builder.fieldOption', { label, key }) : key;
  };
  const labelRules: FormRule[] = [
    { required: true, whitespace: true, message: t('auth.required') },
    {
      type: 'string',
      transform: (value?: string) => value?.trim(),
      max: MAX_LABEL_LENGTH,
      message: t('builder.labelTooLong'),
    },
  ];
  const dateRulePairRule = (control: 'dateRuleStart' | 'dateRuleEnd'): FormRule => ({
    validator: async () => {
      if (incompleteDateRuleControl(form.getFieldsValue(['dateRuleStart', 'dateRuleEnd'])) === control) {
        throw new Error(t('builder.dateRulePair'));
      }
    },
  });
  const listColumnOptions = [
    ...SYSTEM_LIST_COLUMNS.map((column) => ({ value: column, label: t(`builder.systemColumns.${column}`) })),
    ...fieldKeys.map((key) => ({ value: key, label: fieldLabel(key) })),
  ];
  const reviewerLabel = (membershipId: string) => {
    const candidate = state.reviewerCandidates.find((entry) => entry.membershipId === membershipId);
    const reference = t('builder.reviewerOption', { ref: membershipReference(membershipId) });
    return candidate?.isSelf ? `${reference} ${t('builder.you')}` : reference;
  };
  const nextVersion = (head?.latestVersion ?? 0) + 1;
  const canPublish = Boolean(head) && !dirty && head?.publishedRevision !== head?.revision;

  const statusTag = () => {
    if (!head) return <Tag>{t('builder.status.notSaved')}</Tag>;
    if (head.currentVersion && head.publishedRevision === head.revision) {
      return <Tag color="green">{t('builder.status.published', { version: head.currentVersion.version })}</Tag>;
    }
    return <Tag color="blue">{t('builder.status.draft', { revision: head.revision })}</Tag>;
  };

  const showFieldError = (code: string, field: string, text: string) => {
    if (code === 'DEFINITION_LIST_COLUMNS_INVALID') {
      form.setFields([{ name: 'listColumns', errors: [text] }]);
      return true;
    }
    if (code === 'DEFINITION_DATE_RULE_INVALID') {
      form.setFields([{ name: 'dateRuleEnd', errors: [text] }]);
      return true;
    }
    if (code === 'DEFINITION_REVIEWER_INVALID') {
      form.setFields([{ name: 'reviewerMembershipId', errors: [text] }]);
      return true;
    }
    if (!field) return false;
    const rows: FieldRow[] = form.getFieldValue('fields') ?? [];
    const matches = rows.flatMap((row, position) => (row?.key?.trim() === field ? [position] : []));
    const index = (code === 'DEFINITION_FIELD_KEY_DUPLICATE' ? matches.at(-1) : matches[0]) ?? -1;
    if (index < 0) return false;
    const target =
      code === 'DEFINITION_FIELD_LABEL_INVALID'
        ? invalidLabelControl(rows[index])
        : code === 'DEFINITION_FIELD_BOUNDS_INVALID'
          ? 'maxLength'
          : code === 'DEFINITION_FIELD_TYPE_UNKNOWN' || code === 'DEFINITION_FIELD_TYPE_CHANGED'
            ? 'type'
            : 'key';
    const boundsTarget = target === 'maxLength' && rows[index].type === 'number' ? 'min' : target;
    form.setFields([{ name: ['fields', index, boundsTarget], errors: [text] }]);
    return true;
  };

  const handleError = (error: unknown) => {
    const data = actionErrorData(error);
    if (data?.code === 'DEFINITION_REVISION_CONFLICT') {
      setConflictRevision(data.currentRevision ?? 0);
      return undefined;
    }
    const text = actionErrorMessage(error, t);
    if (data && showFieldError(data.code, data.field, text)) return undefined;
    return message.error(text);
  };

  const save = (values: BuilderFormValues) => {
    const reviewerMembershipId = values.reviewerMembershipId;
    if (!reviewerMembershipId || baseRevision === null) return;
    runPendingAction(setSaving, () =>
      saveDraft({
        applicationId: application.applicationId,
        expectedRevision: baseRevision,
        definition: toDefinition(values, reviewerMembershipId),
      }),
    )
      .then((result) => {
        setBaseRevision(result.revision);
        setDirty(false);
        return message.success(t('builder.saved', { revision: result.revision }));
      })
      .catch(handleError);
  };

  const publishDraft = () => {
    if (!head) return;
    runPendingAction(setPublishing, () =>
      publish({ applicationId: application.applicationId, expectedRevision: head.revision }),
    )
      .then((result) => message.success(t('builder.published', { version: result.version })))
      .catch(handleError);
  };

  const versionColumns: TableColumnsType<VersionSummary> = [
    {
      title: t('builder.versionColumn'),
      dataIndex: 'version',
      render: (version: number) => t('builder.versionLabel', { version }),
    },
    { title: t('builder.revisionColumn'), dataIndex: 'sourceRevision' },
    {
      title: t('builder.publishedAtColumn'),
      dataIndex: 'publishedAt',
      render: (publishedAt: number) => new Date(publishedAt).toLocaleString(i18n.language),
    },
    {
      title: t('builder.publishedByColumn'),
      dataIndex: 'publishedByMembershipId',
      render: (membershipId: string) => t('builder.reviewerOption', { ref: membershipReference(membershipId) }),
    },
    {
      title: t('builder.currentColumn'),
      key: 'current',
      render: (_value, row) =>
        head?.currentVersion?.versionId === row.versionId ? <Tag color="green">{t('builder.current')}</Tag> : null,
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap align="center">
            <Typography.Title level={2} style={{ margin: 0, fontSize: 20 }}>
              {t('builder.title', { application: application.applicationName })}
            </Typography.Title>
            <output aria-live="polite">{statusTag()}</output>
          </Space>
          <Typography.Text className="demo-muted">{t('builder.description')}</Typography.Text>
        </Space>
      </Card>

      {conflictRevision !== null && (
        <div ref={conflictRef} tabIndex={-1} aria-label={t('builder.conflictTitle')}>
          <Alert
            role="alert"
            type="warning"
            showIcon
            message={t('builder.conflictTitle')}
            description={t('builder.conflictDescription', { revision: conflictRevision })}
            action={
              <Button onClick={() => loadFromServer(state)} disabled={(head?.revision ?? 0) < conflictRevision}>
                {t('builder.reloadLatest')}
              </Button>
            }
          />
        </div>
      )}

      <Form<BuilderFormValues>
        form={form}
        name="definition"
        layout="vertical"
        initialValues={emptyForm}
        onValuesChange={() => setDirty(true)}
        onFinish={save}
      >
        <Card title={<h3 className="demo-card-heading">{t('builder.fieldsHeading')}</h3>}>
          <Form.List name="fields">
            {(rows, { add, remove, move }) => (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {rows.map((row, index) => {
                  const current = watchedFields[index];
                  const currentKey = current?.key?.trim() ?? '';
                  const lockedType = publishedKeys.get(currentKey);
                  const firstWithKey = watchedFields.findIndex((candidate) => candidate?.key?.trim() === currentKey);
                  const locked = lockedType !== undefined && lockedType === current?.type && firstWithKey === index;
                  const position = index + 1;
                  return (
                    <fieldset key={row.key} className="demo-builder-field">
                      <legend>{t('builder.fieldLegend', { index: position })}</legend>
                      <div className="demo-builder-grid">
                        <Form.Item
                          name={[row.name, 'key']}
                          label={t('builder.key')}
                          extra={locked ? t('builder.publishedLocked') : t('builder.keyHelp')}
                          rules={[
                            { required: true, message: t('auth.required') },
                            { pattern: FIELD_KEY_PATTERN, message: t('builder.keyRule') },
                          ]}
                        >
                          <Input disabled={locked} autoComplete="off" />
                        </Form.Item>
                        <Form.Item name={[row.name, 'type']} label={t('builder.type')}>
                          <Select
                            showSearch
                            optionFilterProp="label"
                            disabled={locked}
                            options={DEFINITION_FIELD_TYPES.map((type) => ({
                              value: type,
                              label: t(`builder.types.${type}`),
                            }))}
                          />
                        </Form.Item>
                        <Form.Item name={[row.name, 'labelEnUS']} label={t('builder.labelEnUS')} rules={labelRules}>
                          <Input lang="en" autoComplete="off" />
                        </Form.Item>
                        <Form.Item name={[row.name, 'labelZhCN']} label={t('builder.labelZhCN')} rules={labelRules}>
                          <Input lang="zh-CN" autoComplete="off" />
                        </Form.Item>
                        {current?.type === 'text' && (
                          <Form.Item
                            name={[row.name, 'maxLength']}
                            label={t('builder.maxLength')}
                            rules={[{ required: true, message: t('auth.required') }]}
                          >
                            <InputNumber min={1} max={MAX_TEXT_FIELD_LENGTH} precision={0} style={{ width: '100%' }} />
                          </Form.Item>
                        )}
                        {current?.type === 'number' && (
                          <>
                            <Form.Item
                              name={[row.name, 'min']}
                              label={t('builder.min')}
                              rules={[{ required: true, message: t('auth.required') }]}
                            >
                              <InputNumber style={{ width: '100%' }} />
                            </Form.Item>
                            <Form.Item
                              name={[row.name, 'max']}
                              label={t('builder.max')}
                              rules={[{ required: true, message: t('auth.required') }]}
                            >
                              <InputNumber style={{ width: '100%' }} />
                            </Form.Item>
                            <Form.Item name={[row.name, 'integer']} valuePropName="checked" label=" " colon={false}>
                              <Checkbox>{t('builder.integer')}</Checkbox>
                            </Form.Item>
                          </>
                        )}
                        <Form.Item name={[row.name, 'required']} valuePropName="checked" label=" " colon={false}>
                          <Checkbox>{t('builder.required')}</Checkbox>
                        </Form.Item>
                      </div>
                      <Space wrap>
                        <Button
                          aria-label={t('builder.moveUp', { index: position })}
                          disabled={index === 0}
                          onClick={() => {
                            move(index, index - 1);
                            setDirty(true);
                          }}
                        >
                          {t('builder.moveUpText')}
                        </Button>
                        <Button
                          aria-label={t('builder.moveDown', { index: position })}
                          disabled={index === rows.length - 1}
                          onClick={() => {
                            move(index, index + 1);
                            setDirty(true);
                          }}
                        >
                          {t('builder.moveDownText')}
                        </Button>
                        <Button
                          danger
                          aria-label={t('builder.remove', { index: position })}
                          disabled={locked || rows.length === 1}
                          onClick={() => {
                            remove(row.name);
                            setDirty(true);
                          }}
                        >
                          {t('builder.removeText')}
                        </Button>
                      </Space>
                    </fieldset>
                  );
                })}
                <Button
                  disabled={rows.length >= MAX_DEFINITION_FIELDS}
                  onClick={() => {
                    add({ ...newFieldRow });
                    setDirty(true);
                  }}
                >
                  {t('builder.addField')}
                </Button>
              </Space>
            )}
          </Form.List>
        </Card>

        <Card title={<h3 className="demo-card-heading">{t('builder.layoutHeading')}</h3>} style={{ marginTop: 16 }}>
          <Form.Item
            name="listColumns"
            label={t('builder.listColumns')}
            extra={t('builder.listColumnsHelp')}
            rules={[{ required: true, message: t('auth.required') }]}
          >
            <Select mode="multiple" optionFilterProp="label" options={listColumnOptions} />
          </Form.Item>
          <div className="demo-builder-grid">
            <Form.Item
              name="dateRuleStart"
              label={t('builder.dateRuleStart')}
              extra={t('builder.dateRuleHelp')}
              dependencies={['dateRuleEnd']}
              rules={[dateRulePairRule('dateRuleStart')]}
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={dateKeys.map((key) => ({ value: key, label: fieldLabel(key) }))}
              />
            </Form.Item>
            <Form.Item
              name="dateRuleEnd"
              label={t('builder.dateRuleEnd')}
              dependencies={['dateRuleStart']}
              rules={[dateRulePairRule('dateRuleEnd')]}
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={dateKeys.map((key) => ({ value: key, label: fieldLabel(key) }))}
              />
            </Form.Item>
          </div>
        </Card>

        <Card title={<h3 className="demo-card-heading">{t('builder.accessHeading')}</h3>} style={{ marginTop: 16 }}>
          <Form.Item name="policyPreset" label={t('builder.policy')}>
            <Radio.Group>
              <Space direction="vertical">
                {POLICY_PRESETS.map((preset) => (
                  <Radio key={preset} value={preset}>
                    <Typography.Text strong>{t(`builder.policies.${preset}.title`)}</Typography.Text>
                    <br />
                    <Typography.Text className="demo-muted">
                      {t(`builder.policies.${preset}.description`)}
                    </Typography.Text>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="reviewerMembershipId"
            label={t('builder.reviewer')}
            extra={
              state.reviewerCandidatesTruncated
                ? `${t('builder.reviewerHelp')} ${t('builder.reviewersTruncated')}`
                : t('builder.reviewerHelp')
            }
            rules={[{ required: true, message: t('auth.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={state.reviewerCandidates.map((candidate) => ({
                value: candidate.membershipId,
                label: reviewerLabel(candidate.membershipId),
              }))}
              notFoundContent={t('builder.noReviewers')}
            />
          </Form.Item>
        </Card>

        <ConfigProvider theme={withoutMotion}>
          <Space wrap style={{ marginTop: 16 }}>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t('builder.save')}
            </Button>
            <Popconfirm
              title={t('builder.publishConfirm', { version: nextVersion })}
              okText={t('builder.publish')}
              cancelText={t('builder.cancel')}
              onConfirm={publishDraft}
              disabled={!canPublish}
            >
              <Button disabled={!canPublish} loading={publishing}>
                {t('builder.publish')}
              </Button>
            </Popconfirm>
            {dirty && <Typography.Text className="demo-muted">{t('builder.publishNeedsSave')}</Typography.Text>}
          </Space>
        </ConfigProvider>
      </Form>

      <Card title={<h3 className="demo-card-heading">{t('builder.versionsHeading')}</h3>}>
        {state.versions.length === 0 ? (
          <Empty description={t('builder.noVersions')} />
        ) : (
          <Table<VersionSummary>
            rowKey="versionId"
            columns={versionColumns}
            dataSource={state.versions}
            pagination={false}
            size="small"
          />
        )}
        {state.versionsTruncated && (
          <Typography.Paragraph className="demo-muted" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('builder.versionsTruncated')}
          </Typography.Paragraph>
        )}
      </Card>
    </Space>
  );
}
