export type RequestModalStatus =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; error: Error }
  | { kind: 'ready' };

// `useQueries` returns a failed query as an Error value; the modal must show it instead of loading forever.
export function requestModalStatus(input: {
  mode: 'create' | 'edit';
  request: object | null | undefined;
  pinnedVersion: object | null | undefined;
  hasDefinition: boolean;
  hasSnapshot: boolean;
}): RequestModalStatus {
  if (input.request instanceof Error) return { kind: 'failed', error: input.request };
  if (input.pinnedVersion instanceof Error) return { kind: 'failed', error: input.pinnedVersion };
  if (input.mode === 'edit' && input.request === null) return { kind: 'missing' };
  if (!input.hasDefinition || (input.mode === 'edit' && !input.hasSnapshot)) return { kind: 'loading' };
  return { kind: 'ready' };
}

export type ReviewAction = 'submit' | 'withdraw' | 'reject' | 'approve';

type ActionFlags = { canSubmit: boolean; canWithdraw: boolean; canDecide: boolean };

export function requestActions(view: ActionFlags): ReviewAction[] {
  const actions: ReviewAction[] = [];
  if (view.canSubmit) actions.push('submit');
  if (view.canWithdraw) actions.push('withdraw');
  if (view.canDecide) actions.push('reject', 'approve');
  return actions;
}

export type CreateAttempt<Version> = { version: Version; operationId: string };

// The server fingerprints an operation with its version, so values moved to a newer version are a new operation.
export function newCreateAttempt<Version>(version: Version): CreateAttempt<Version> {
  return { version, operationId: crypto.randomUUID() };
}
