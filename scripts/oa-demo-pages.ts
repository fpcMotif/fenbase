import type { OaApi } from './oa-demo-auth';

type Route = {
  id: number;
  type: string;
  title: string;
  schemaUid: string;
  menuSchemaUid: string;
  enableTabs?: boolean;
  sort?: number;
  createdAt?: string;
  updatedAt?: string;
  createdById?: number;
  updatedById?: number;
  parentId?: number | null;
  icon?: string | null;
  options?: unknown;
  hideInMenu?: boolean | null;
  enableHeader?: boolean | null;
  displayTitle?: boolean | null;
  hidden?: boolean | null;
  children?: Route[];
};

type ApiEnvelope<T> = { data?: T };

type UiSchema = {
  'x-uid'?: string;
  properties?: Record<string, UiSchema>;
  [key: string]: unknown;
};

const layoutUids = ['admin-layout-model'];

const requestPages = [
  {
    collection: 'leaveRequests',
    title: 'Leave Requests',
    icon: 'calendaroutlined',
    pageUid: 'oa-leave-requests-page',
    menuUid: 'oa-leave-requests-menu',
    tabUid: 'oa-leave-requests-tab',
    blockUid: 'oa-leave-requests-block',
    rowUid: 'oa-leave-requests-row',
    colUid: 'oa-leave-requests-col',
    fields: ['employeeName', 'startDate', 'endDate', 'days', 'reason', 'status'],
    createFields: ['employeeName', 'startDate', 'endDate', 'days', 'reason'],
  },
  {
    collection: 'expenseClaims',
    title: 'Expense Claims',
    icon: 'walletoutlined',
    pageUid: 'oa-expense-claims-page',
    menuUid: 'oa-expense-claims-menu',
    tabUid: 'oa-expense-claims-tab',
    blockUid: 'oa-expense-claims-block',
    rowUid: 'oa-expense-claims-row',
    colUid: 'oa-expense-claims-col',
    fields: ['employeeName', 'amount', 'currency', 'category', 'expenseDate', 'description', 'status'],
    createFields: ['employeeName', 'amount', 'currency', 'category', 'expenseDate', 'description'],
  },
];

export async function seedOaPages(api: OaApi): Promise<void> {
  for (const definition of requestPages) {
    await createPage(api, {
      ...definition,
      routeTitle: definition.title,
    });
  }

  await createPage(api, {
    collection: 'workflowManualTasks',
    title: 'Approval Inbox',
    routeTitle: 'Approval Inbox',
    icon: 'checksquareoutlined',
    pageUid: 'oa-approval-inbox-page',
    menuUid: 'oa-approval-inbox-menu',
    tabUid: 'oa-approval-inbox-tab',
    blockUid: 'oa-approval-inbox-block',
    rowUid: 'oa-approval-inbox-row',
    colUid: 'oa-approval-inbox-col',
    workflowInbox: true,
    fields: [],
    createFields: [],
  });
}

async function createPage(
  api: OaApi,
  definition: {
    collection: string;
    title: string;
    routeTitle: string;
    icon: string;
    pageUid: string;
    menuUid: string;
    tabUid: string;
    blockUid: string;
    rowUid: string;
    colUid: string;
    fields: string[];
    createFields: string[];
    workflowInbox?: boolean;
  },
): Promise<void> {
  const existing = await api<ApiEnvelope<Route[]>>('desktopRoutes:list', { params: { pageSize: 200 } });
  const existingRoute = existing.data?.find((route) => route.schemaUid === definition.pageUid);

  const tabName = 'main';
  const routeResponse = existingRoute
    ? undefined
    : await api<ApiEnvelope<Route>>('desktopRoutes:create', {
        method: 'POST',
        body: {
          type: 'page',
          title: definition.routeTitle,
          schemaUid: definition.pageUid,
          menuSchemaUid: definition.menuUid,
          icon: definition.icon,
          hideInMenu: false,
          enableTabs: false,
          uiLayouts: layoutUids,
          children: [
            {
              type: 'tabs',
              title: '{{t("Main")}}',
              schemaUid: definition.tabUid,
              tabSchemaName: tabName,
              hidden: true,
              uiLayouts: layoutUids,
            },
          ],
        },
      });
  const route = existingRoute ?? routeResponse?.data;
  if (!route?.id) throw new Error(`Could not create the ${definition.routeTitle} page route`);

  const block = definition.workflowInbox ? createInboxBlock(definition.blockUid) : createRequestTable(definition);
  const row = createGridRow(definition.rowUid, definition.colUid, block);

  const page = {
    _isJSONSchemaObject: true,
    version: '2.0',
    type: 'void',
    name: 'page',
    'x-component': 'Page',
    'x-async': true,
    'x-uid': definition.pageUid,
    properties: {
      [tabName]: {
        _isJSONSchemaObject: true,
        version: '2.0',
        type: 'void',
        name: tabName,
        'x-component': 'Grid',
        'x-initializer': 'page:addBlock',
        'x-uid': definition.tabUid,
        properties: { [definition.rowUid]: row },
      },
    },
  };

  const menuSchema = {
    _isJSONSchemaObject: true,
    version: '2.0',
    type: 'void',
    title: definition.title,
    'x-component': 'Menu.Item',
    'x-decorator': 'ACLMenuItemProvider',
    'x-component-props': {},
    properties: { page },
    'x-uid': definition.menuUid,
    __route__: routeMetadata(route),
  };

  if (!existingRoute) {
    await api('uiSchemas:insertAdjacent/nocobase-admin-menu', {
      method: 'POST',
      params: { position: 'beforeEnd' },
      body: { schema: menuSchema },
    });
    return;
  }

  const currentGridResponse = await api<ApiEnvelope<UiSchema>>(`uiSchemas:getJsonSchema/${definition.tabUid}`, {
    params: { includeAsyncNode: true },
  });
  const currentChildren = Object.values(currentGridResponse.data?.properties ?? {});
  const currentRow = currentChildren.find((child) => child['x-uid'] === definition.rowUid);
  if (currentRow) {
    await api(`uiSchemas:remove/${definition.rowUid}`, { method: 'POST' });
  }

  if (currentChildren.some((child) => child['x-uid'] === definition.blockUid)) {
    await api(`uiSchemas:remove/${definition.blockUid}`, { method: 'POST' });
  }
  await api(`uiSchemas:insertAdjacent/${definition.tabUid}`, {
    method: 'POST',
    params: { position: 'beforeEnd' },
    body: { schema: row },
  });
}

function createGridRow(rowUid: string, colUid: string, block: Record<string, unknown>) {
  return {
    _isJSONSchemaObject: true,
    version: '2.0',
    type: 'void',
    name: rowUid,
    'x-uid': rowUid,
    'x-component': 'Grid.Row',
    properties: {
      [colUid]: {
        _isJSONSchemaObject: true,
        version: '2.0',
        type: 'void',
        name: colUid,
        'x-uid': colUid,
        'x-component': 'Grid.Col',
        properties: { [String(block.name)]: block },
      },
    },
  };
}

function createRequestTable(definition: {
  collection: string;
  title: string;
  blockUid: string;
  rowUid: string;
  colUid: string;
  fields: string[];
  createFields: string[];
}) {
  return {
    _isJSONSchemaObject: true,
    version: '2.0',
    type: 'void',
    name: definition.blockUid,
    'x-uid': definition.blockUid,
    'x-acl-action': `${definition.collection}:list`,
    'x-decorator': 'TableBlockProvider',
    'x-decorator-props': {
      collection: definition.collection,
      action: 'list',
      params: { pageSize: 20, sort: '-createdAt' },
    },
    'x-toolbar': 'BlockSchemaToolbar',
    'x-settings': 'blockSettings:table',
    'x-component': 'CardItem',
    properties: {
      actions: {
        type: 'void',
        'x-component': 'ActionBar',
        'x-component-props': { style: { marginBottom: 'var(--nb-spacing)' } },
        properties: {
          refresh: {
            type: 'void',
            title: '{{t("Refresh")}}',
            'x-component': 'Action',
            'x-use-component-props': 'useRefreshActionProps',
            'x-component-props': { icon: 'ReloadOutlined' },
          },
          create: createRequestAction(definition),
        },
      },
      table: {
        type: 'array',
        'x-component': 'TableV2',
        'x-use-component-props': 'useTableBlockProps',
        'x-component-props': { rowKey: 'id' },
        properties: Object.fromEntries(
          definition.fields.map((field) => [
            field,
            {
              type: 'void',
              title: `{{t("${fieldLabel(field)}")}}`,
              'x-component': 'TableV2.Column',
              properties: {
                [field]: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-pattern': 'readPretty',
                },
              },
            },
          ]),
        ),
      },
    },
  };
}

function createRequestAction(definition: { title: string; collection: string; createFields: string[] }) {
  return {
    type: 'void',
    title: '{{t("Create")}}',
    'x-action': 'create',
    'x-component': 'Action',
    'x-component-props': { type: 'primary', icon: 'PlusOutlined' },
    properties: {
      drawer: {
        type: 'void',
        title: `{{t("Create ${definition.title.slice(0, -1)}")}}`,
        'x-component': 'Action.Drawer',
        properties: {
          formBlock: {
            type: 'void',
            'x-decorator': 'FormBlockProvider',
            'x-use-decorator-props': 'useCreateFormBlockDecoratorProps',
            'x-decorator-props': { dataSource: 'main', collection: definition.collection },
            'x-component': 'CardItem',
            properties: {
              form: {
                type: 'void',
                'x-component': 'FormV2',
                'x-use-component-props': 'useCreateFormBlockProps',
                properties: {
                  ...Object.fromEntries(
                    definition.createFields.map((field) => [
                      field,
                      {
                        type: 'string',
                        title: `{{t("${fieldLabel(field)}")}}`,
                        'x-decorator': 'FormItem',
                        'x-component': 'CollectionField',
                        'x-collection-field': `${definition.collection}.${field}`,
                      },
                    ]),
                  ),
                  footer: {
                    type: 'void',
                    'x-component': 'Action.Drawer.Footer',
                    properties: {
                      cancel: {
                        title: '{{t("Cancel")}}',
                        'x-component': 'Action',
                        'x-use-component-props': 'useCancelActionProps',
                      },
                      submit: {
                        title: '{{t("Submit")}}',
                        'x-component': 'Action',
                        'x-use-component-props': 'useCreateActionProps',
                        'x-component-props': { type: 'primary' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function createInboxBlock(blockUid: string) {
  return {
    _isJSONSchemaObject: true,
    version: '2.0',
    type: 'void',
    name: blockUid,
    'x-uid': blockUid,
    'x-decorator': 'WorkflowTodo.Decorator',
    'x-decorator-props': {},
    'x-component': 'CardItem',
    'x-toolbar': 'BlockSchemaToolbar',
    'x-settings': 'blockSettings:table',
    properties: {
      todos: {
        type: 'void',
        'x-component': 'WorkflowTodo',
      },
    },
  };
}

function routeMetadata(route: Route) {
  return {
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    id: route.id,
    type: route.type,
    title: route.title,
    schemaUid: route.schemaUid,
    menuSchemaUid: route.menuSchemaUid,
    enableTabs: route.enableTabs ?? false,
    sort: route.sort,
    createdById: route.createdById,
    updatedById: route.updatedById,
    parentId: route.parentId ?? null,
    icon: route.icon ?? null,
    tabSchemaName: null,
    options: route.options ?? null,
    hideInMenu: route.hideInMenu ?? false,
    enableHeader: route.enableHeader ?? true,
    displayTitle: route.displayTitle ?? true,
    hidden: route.hidden ?? false,
    children: (route.children ?? []).map((child) => ({
      id: child.id,
      type: child.type,
      schemaUid: child.schemaUid,
      tabSchemaName: (child as Route & { tabSchemaName?: string }).tabSchemaName,
      hidden: (child as Route & { hidden?: boolean }).hidden,
    })),
  };
}

function fieldLabel(field: string) {
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
  return labels[field] ?? field;
}
