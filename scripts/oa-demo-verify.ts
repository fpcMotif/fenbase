#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { createOaApi, type OaApi } from './oa-demo-auth';

type Envelope<T> = {
  data: T;
};

type DemoRecord = {
  id: number | string;
  status: string;
};

type ManualTask = {
  id: number | string;
  title: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordId(record: DemoRecord, label: string): number | string {
  assert(typeof record.id === 'number' || typeof record.id === 'string', `${label} response has no record ID`);
  return record.id;
}

async function listMine(api: OaApi): Promise<ManualTask[]> {
  const result = await api<Envelope<ManualTask[]>>('workflowManualTasks:listMine', {
    params: { page: 1, pageSize: 100 },
  });
  assert(Array.isArray(result.data), 'workflowManualTasks:listMine returned no task list');
  return result.data;
}

async function waitForTasks(api: OaApi, existingIds: Set<string>): Promise<{ leave: ManualTask; expense: ManualTask }> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const tasks = await listMine(api);
    const newTasks = tasks.filter((task) => !existingIds.has(String(task.id)));
    const leave = newTasks.find((task) => task.title === 'Approve leave request');
    const expense = newTasks.find((task) => task.title === 'Approve expense claim');
    if (leave && expense) return { leave, expense };
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for leave and expense manual approval tasks');
}

async function submitTask(api: OaApi, task: ManualTask, action: 'approve' | 'reject', status: string): Promise<void> {
  const result = await api<Envelope<unknown>>('workflowManualTasks:submit', {
    method: 'POST',
    params: { filterByTk: task.id },
    body: {
      result: {
        approvalForm: { status },
        _: action,
      },
    },
  });
  assert(result.data !== undefined, `Manual task ${String(task.id)} returned no result`);
}

async function main(): Promise<void> {
  const { api, user } = await createOaApi();
  assert(Number.isSafeInteger(user.id), 'Authenticated NocoBase user ID is invalid');

  const existingTasks = await listMine(api);
  const existingIds = new Set(existingTasks.map((task) => String(task.id)));
  const suffix = randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  const leaveResult = await api<Envelope<DemoRecord>>('leaveRequests:create', {
    method: 'POST',
    body: {
      employeeName: `Demo Verify ${suffix}`,
      startDate: today,
      endDate: today,
      days: 1,
      reason: `Synthetic leave approval check ${suffix}`,
      status: 'pending',
    },
  });
  const leaveId = recordId(leaveResult.data, 'Leave request');
  assert(leaveResult.data.status === 'pending', 'New leave request did not start as pending');

  const expenseResult = await api<Envelope<DemoRecord>>('expenseClaims:create', {
    method: 'POST',
    body: {
      employeeName: `Demo Verify ${suffix}`,
      amount: 128.5,
      currency: 'CNY',
      category: 'travel',
      expenseDate: today,
      description: `Synthetic expense rejection check ${suffix}`,
      status: 'pending',
    },
  });
  const expenseId = recordId(expenseResult.data, 'Expense claim');
  assert(expenseResult.data.status === 'pending', 'New expense claim did not start as pending');

  console.log(`Created pending leave request ${String(leaveId)} and expense claim ${String(expenseId)}.`);

  const tasks = await waitForTasks(api, existingIds);
  await submitTask(api, tasks.leave, 'approve', 'approved');
  await submitTask(api, tasks.expense, 'reject', 'rejected');

  const leaveAfter = await api<Envelope<DemoRecord>>('leaveRequests:get', {
    params: { filterByTk: leaveId },
  });
  const expenseAfter = await api<Envelope<DemoRecord>>('expenseClaims:get', {
    params: { filterByTk: expenseId },
  });

  assert(leaveAfter.data.status === 'approved', `Leave request status is ${leaveAfter.data.status}, expected approved`);
  assert(
    expenseAfter.data.status === 'rejected',
    `Expense claim status is ${expenseAfter.data.status}, expected rejected`,
  );

  console.log(`Verified task ${String(tasks.leave.id)} approved leave request ${String(leaveId)}.`);
  console.log(`Verified task ${String(tasks.expense.id)} rejected expense claim ${String(expenseId)}.`);
  console.log('OA demo verification passed; synthetic records and completed tasks remain available for UI review.');
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`OA demo verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
