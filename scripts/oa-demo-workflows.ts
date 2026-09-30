import type { OaApi } from './oa-demo-auth';

type ApiEnvelope<T> = {
  data?: T;
};

type WorkflowRecord = {
  id?: number;
  title?: string;
  key?: string;
  type?: string;
  current?: boolean | null;
  enabled?: boolean;
  config?: unknown;
};

type FlowNodeRecord = {
  id?: number;
  type?: string;
  config?: unknown;
};

const workflowDefinitions = [
  {
    collection: 'leaveRequests',
    workflowTitle: 'Leave request approval',
    taskTitle: 'Approve leave request',
    detailFields: ['employeeName', 'startDate', 'endDate', 'days', 'reason', 'status'],
  },
  {
    collection: 'expenseClaims',
    workflowTitle: 'Expense claim approval',
    taskTitle: 'Approve expense claim',
    detailFields: ['employeeName', 'amount', 'currency', 'category', 'expenseDate', 'description', 'status'],
  },
] as const;

function collectionField(collection: string, field: string, pretty = false) {
  const labels: Record<string, string> = {
    employeeName: 'Employee',
    startDate: 'Start date',
    endDate: 'End date',
    days: 'Days',
    reason: 'Reason',
    status: 'Status',
    amount: 'Amount',
    currency: 'Currency',
    category: 'Category',
    expenseDate: 'Expense date',
    description: 'Description',
  };
  return {
    type: 'string',
    title: `{{t("${labels[field] ?? field}")}}`,
    'x-decorator': 'FormItem',
    'x-component': 'CollectionField',
    'x-collection-field': `${collection}.${field}`,
    ...(pretty ? { 'x-read-pretty': true } : {}),
  };
}

function grid(properties: Record<string, unknown>) {
  return {
    type: 'void',
    'x-component': 'Grid',
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        `row_${key}`,
        {
          type: 'void',
          'x-component': 'Grid.Row',
          properties: {
            [`col_${key}`]: {
              type: 'void',
              'x-component': 'Grid.Col',
              properties: { [key]: schema },
            },
          },
        },
      ]),
    ),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

function hasSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function makeTaskSchema(collection: string, detailFields: readonly string[]) {
  const details = Object.fromEntries(detailFields.map((field) => [field, collectionField(collection, field, true)]));

  return {
    review: {
      type: 'void',
      title: 'Manager review',
      'x-component': 'Tabs.TabPane',
      properties: {
        grid: grid({
          requestDetails: {
            type: 'void',
            'x-decorator': 'DetailsBlockProvider',
            'x-decorator-props': {
              collection,
              dataSource: 'main',
              dataPath: '$context.data',
            },
            'x-component': 'CardItem',
            'x-component-props': {
              title: 'Request details',
            },
            properties: {
              details: {
                type: 'void',
                'x-component': 'FormV2',
                'x-use-component-props': 'useDetailsBlockProps',
                'x-read-pretty': true,
                properties: { grid: grid(details) },
              },
            },
          },
          decision: {
            type: 'void',
            'x-decorator': 'FormBlockProvider',
            'x-decorator-props': {
              dataSource: 'main',
              collection,
              resource: collection,
              formType: 'update',
              filter: { id: '{{$context.data.id}}' },
            },
            'x-component': 'CardItem',
            'x-component-props': {
              title: 'Decision',
            },
            properties: {
              approvalForm: {
                type: 'void',
                'x-component': 'FormV2',
                'x-use-component-props': 'useFormBlockProps',
                properties: {
                  grid: grid({}),
                  actions: {
                    type: 'void',
                    'x-decorator': 'ActionBarProvider',
                    'x-component': 'ActionBar',
                    'x-component-props': {
                      layout: 'one-column',
                      style: { marginTop: 24 },
                    },
                    properties: {
                      approve: {
                        type: 'void',
                        title: '{{t("Approve")}}',
                        'x-decorator': 'ManualActionStatusProvider',
                        'x-decorator-props': { value: 1 },
                        'x-component': 'Action',
                        'x-component-props': {
                          type: 'primary',
                          useAction: '{{ useSubmit }}',
                        },
                        'x-action-settings': {
                          assignedValues: { values: { status: 'approved' } },
                        },
                      },
                      reject: {
                        type: 'void',
                        title: '{{t("Reject")}}',
                        'x-decorator': 'ManualActionStatusProvider',
                        'x-decorator-props': { value: -5 },
                        'x-component': 'Action',
                        'x-component-props': {
                          danger: true,
                          useAction: '{{ useSubmit }}',
                        },
                        'x-action-settings': {
                          assignedValues: { values: { status: 'rejected' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
    },
  };
}

export async function seedOaWorkflows(api: OaApi, managerId: number): Promise<void> {
  if (!Number.isSafeInteger(managerId) || managerId <= 0) {
    throw new Error('A valid manager ID is required to seed approval workflows');
  }

  const listed = await api<ApiEnvelope<WorkflowRecord[]>>('workflows:list', {
    params: { pageSize: 100 },
  });
  const existingWorkflows = listed.data ?? [];

  for (const definition of workflowDefinitions) {
    const form = {
      type: 'update',
      title: 'Manager decision',
      collection: definition.collection,
      dataSource: 'main',
      filter: { id: '{{$context.data.id}}' },
      actions: [
        { status: 1, key: 'approve', values: { status: 'approved' } },
        { status: -5, key: 'reject', values: { status: 'rejected' } },
      ],
    };
    const workflowValues = {
      title: definition.workflowTitle,
      enabled: false,
      type: 'collection',
      triggerTitle: 'Create record',
      config: {
        mode: 1,
        collection: definition.collection,
      },
    };
    const nodeValues = {
      type: 'manual',
      title: definition.taskTitle,
      config: {
        assignees: [managerId],
        forms: { approvalForm: form },
        schema: makeTaskSchema(definition.collection, definition.detailFields),
      },
    };

    const existing =
      existingWorkflows.find((workflow) => workflow.title === definition.workflowTitle && workflow.current === true) ??
      existingWorkflows.find((workflow) => workflow.title === definition.workflowTitle);
    let workflowId = existing?.id;
    let needsNodeCreate = false;

    if (existing?.id) {
      const nodes = await api<ApiEnvelope<FlowNodeRecord[]>>('flow_nodes:list', {
        params: { 'filter[workflowId]': existing.id, pageSize: 100 },
      });
      const manualNode = nodes.data?.find((node) => node.type === 'manual');
      const workflowMatches = existing.type === 'collection' && hasSameValue(existing.config, workflowValues.config);
      const nodeMatches = manualNode && hasSameValue(manualNode.config, nodeValues.config);

      if (!workflowMatches || !nodeMatches) {
        if (!existing.key) {
          throw new Error(`Cannot create a workflow revision for ${definition.workflowTitle} without its key`);
        }

        const revision = await api<ApiEnvelope<WorkflowRecord>>('workflows:revision', {
          method: 'POST',
          params: {
            filterByTk: existing.id,
            'filter[key]': existing.key,
          },
          body: { title: definition.workflowTitle },
        });
        workflowId = revision.data?.id;
        if (!Number.isSafeInteger(workflowId) || !workflowId) {
          throw new Error(`NocoBase did not return a revision ID for ${definition.workflowTitle}`);
        }

        const revisionNodes = await api<ApiEnvelope<FlowNodeRecord[]>>('flow_nodes:list', {
          params: { 'filter[workflowId]': workflowId, pageSize: 100 },
        });
        const revisionManualNode = revisionNodes.data?.find((node) => node.type === 'manual');
        if (revisionManualNode?.id) {
          await api('flow_nodes:update', {
            method: 'POST',
            params: { filterByTk: revisionManualNode.id },
            body: nodeValues,
          });
        } else {
          needsNodeCreate = true;
        }
      }
    } else {
      const created = await api<ApiEnvelope<WorkflowRecord>>('workflows:create', {
        method: 'POST',
        body: workflowValues,
      });
      workflowId = created.data?.id;
      needsNodeCreate = true;
    }

    if (!Number.isSafeInteger(workflowId) || !workflowId) {
      throw new Error(`NocoBase did not return a workflow ID for ${definition.workflowTitle}`);
    }

    if (needsNodeCreate) {
      await api(`workflows/${workflowId}/nodes:create`, {
        method: 'POST',
        body: nodeValues,
      });
    }

    await api('workflows:update', {
      method: 'POST',
      params: { filterByTk: workflowId },
      body: { enabled: true },
    });

    const existingIndex = existingWorkflows.findIndex((workflow) => workflow.title === definition.workflowTitle);
    if (existingIndex < 0) {
      existingWorkflows.push({
        id: workflowId,
        title: definition.workflowTitle,
        key: existing?.key,
        type: 'collection',
        current: true,
        enabled: true,
        config: workflowValues.config,
      });
    } else {
      existingWorkflows[existingIndex] = {
        ...existingWorkflows[existingIndex],
        id: workflowId,
        title: definition.workflowTitle,
        key: existing?.key,
        type: 'collection',
        current: true,
        enabled: true,
        config: workflowValues.config,
      };
    }
  }
}
