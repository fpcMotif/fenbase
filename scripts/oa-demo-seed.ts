import { createOaApi, type OaApi } from './oa-demo-auth';
import { seedOaPages } from './oa-demo-pages';
import { seedOaWorkflows } from './oa-demo-workflows';

type CollectionSummary = {
  name: string;
};

type ApiEnvelope<T> = {
  data: T;
};

const statusOptions = [
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
];

const statusField = {
  name: 'status',
  type: 'string',
  interface: 'select',
  allowNull: false,
  defaultValue: 'pending',
  uiSchema: {
    type: 'string',
    title: 'Status',
    'x-component': 'Select',
    enum: statusOptions,
    default: 'pending',
    required: true,
  },
};

const collections = [
  {
    name: 'leaveRequests',
    title: 'Leave Requests',
    createdAt: true,
    createdBy: true,
    updatedAt: true,
    updatedBy: true,
    fields: [
      {
        name: 'employeeName',
        type: 'string',
        interface: 'input',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Employee', 'x-component': 'Input', required: true },
      },
      {
        name: 'startDate',
        type: 'date',
        interface: 'datetime',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Start date', 'x-component': 'DatePicker', required: true },
      },
      {
        name: 'endDate',
        type: 'date',
        interface: 'datetime',
        allowNull: false,
        uiSchema: { type: 'string', title: 'End date', 'x-component': 'DatePicker', required: true },
      },
      {
        name: 'days',
        type: 'integer',
        interface: 'number',
        allowNull: false,
        uiSchema: {
          type: 'number',
          title: 'Days',
          'x-component': 'InputNumber',
          'x-component-props': { min: 1 },
          required: true,
        },
      },
      {
        name: 'reason',
        type: 'text',
        interface: 'textarea',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Reason', 'x-component': 'Input.TextArea', required: true },
      },
      statusField,
    ],
  },
  {
    name: 'expenseClaims',
    title: 'Expense Claims',
    createdAt: true,
    createdBy: true,
    updatedAt: true,
    updatedBy: true,
    fields: [
      {
        name: 'employeeName',
        type: 'string',
        interface: 'input',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Employee', 'x-component': 'Input', required: true },
      },
      {
        name: 'amount',
        type: 'decimal',
        interface: 'number',
        allowNull: false,
        precision: 12,
        scale: 2,
        uiSchema: {
          type: 'number',
          title: 'Amount',
          'x-component': 'InputNumber',
          'x-component-props': { min: 0, precision: 2, step: 0.01 },
          required: true,
        },
      },
      {
        name: 'currency',
        type: 'string',
        interface: 'input',
        allowNull: false,
        defaultValue: 'CNY',
        uiSchema: { type: 'string', title: 'Currency', 'x-component': 'Input', default: 'CNY', required: true },
      },
      {
        name: 'category',
        type: 'string',
        interface: 'select',
        allowNull: false,
        uiSchema: {
          type: 'string',
          title: 'Category',
          'x-component': 'Select',
          enum: [
            { label: 'Travel', value: 'travel' },
            { label: 'Meals', value: 'meals' },
            { label: 'Office supplies', value: 'office_supplies' },
            { label: 'Other', value: 'other' },
          ],
          required: true,
        },
      },
      {
        name: 'expenseDate',
        type: 'date',
        interface: 'datetime',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Expense date', 'x-component': 'DatePicker', required: true },
      },
      {
        name: 'description',
        type: 'text',
        interface: 'textarea',
        allowNull: false,
        uiSchema: { type: 'string', title: 'Description', 'x-component': 'Input.TextArea', required: true },
      },
      statusField,
    ],
  },
];

export async function seedOaCollections(api: OaApi): Promise<void> {
  const response = await api<ApiEnvelope<CollectionSummary[]>>('/collections:list');
  const existing = new Set(response.data.map((collection) => collection.name));

  for (const collection of collections) {
    if (existing.has(collection.name)) continue;
    await api('/collections:create', {
      method: 'POST',
      body: collection,
    });
  }
}

if (import.meta.main) {
  const { api, user } = await createOaApi();
  await seedOaCollections(api);
  await seedOaWorkflows(api, user.id);
  await seedOaPages(api);
  console.log('Native OA forms and approval inbox are ready at http://localhost:13000/admin');
}
