import { describe, expect, it } from 'vitest';
import { OPERATION_ID_PATTERN } from '../../../convex/requestValues';
import { newCreateAttempt, requestActions, requestModalStatus, staleRequest } from '../requestModal';

const view = { _id: 'requests:1' };

describe('request modal status', () => {
  it('stops loading and reports a failed request query', () => {
    const error = new Error('APPLICATION_ACCESS_DENIED');
    expect(
      requestModalStatus({
        mode: 'edit',
        request: error,
        pinnedVersion: undefined,
        hasDefinition: false,
        hasSnapshot: false,
      }),
    ).toEqual({ kind: 'failed', error });
  });

  it('stops loading and reports a failed pinned-version query', () => {
    const error = new Error('DEFINITION_VERSION_NOT_FOUND');
    expect(
      requestModalStatus({
        mode: 'edit',
        request: view,
        pinnedVersion: error,
        hasDefinition: false,
        hasSnapshot: false,
      }),
    ).toEqual({ kind: 'failed', error });
  });

  it('reports a request that is missing or hidden', () => {
    expect(
      requestModalStatus({
        mode: 'edit',
        request: null,
        pinnedVersion: undefined,
        hasDefinition: false,
        hasSnapshot: false,
      }),
    ).toEqual({ kind: 'missing' });
  });

  it('loads until the request, its version and the form snapshot are all in', () => {
    const base = {
      mode: 'edit',
      request: undefined,
      pinnedVersion: undefined,
      hasDefinition: false,
      hasSnapshot: false,
    } as const;
    expect(requestModalStatus(base)).toEqual({ kind: 'loading' });
    expect(requestModalStatus({ ...base, request: view })).toEqual({ kind: 'loading' });
    expect(requestModalStatus({ ...base, request: view, pinnedVersion: {}, hasDefinition: true })).toEqual({
      kind: 'loading',
    });
    expect(
      requestModalStatus({ ...base, request: view, pinnedVersion: {}, hasDefinition: true, hasSnapshot: true }),
    ).toEqual({ kind: 'ready' });
  });

  it('opens a new request as soon as its version is known', () => {
    const create = { mode: 'create', request: undefined, pinnedVersion: undefined, hasSnapshot: false } as const;
    expect(requestModalStatus({ ...create, hasDefinition: false })).toEqual({ kind: 'loading' });
    expect(requestModalStatus({ ...create, hasDefinition: true })).toEqual({ kind: 'ready' });
  });
});

describe('request actions', () => {
  const flags = { canSubmit: false, canWithdraw: false, canDecide: false };

  it('offers each side only the review commands the server allows for the snapshot it shows', () => {
    expect(requestActions({ ...flags, canSubmit: true })).toEqual(['submit']);
    expect(requestActions({ ...flags, canWithdraw: true })).toEqual(['withdraw']);
    expect(requestActions({ ...flags, canDecide: true })).toEqual(['reject', 'approve']);
    expect(requestActions(flags)).toEqual([]);
  });
});

describe('stale request notice', () => {
  const latest = { state: 'pending', revision: 2 } as const;

  it('reports the state and revision the server sent', () => {
    expect(staleRequest({ currentState: 'withdrawn', currentRevision: 3 }, latest)).toEqual({
      state: 'withdrawn',
      revision: 3,
    });
  });

  it('falls back to the latest loaded request when the server sends no known state', () => {
    expect(staleRequest({ currentState: 'archived', currentRevision: 4 }, latest)).toEqual({
      state: 'pending',
      revision: 4,
    });
    expect(staleRequest({ currentRevision: 5 }, latest)).toEqual({ state: 'pending', revision: 5 });
    expect(staleRequest({}, latest)).toEqual(latest);
  });

  it('has nothing to report when neither the server nor the dialog knows the state', () => {
    expect(staleRequest({ currentState: 'archived', currentRevision: 4 }, undefined)).toBeNull();
  });
});

describe('create attempts', () => {
  it('gives a new version its own operation id, so the old payload’s id is never reused for new values', () => {
    const first = newCreateAttempt('version-1');
    const next = newCreateAttempt('version-2');
    expect(next.version).toBe('version-2');
    expect(next.operationId).not.toBe(first.operationId);
    expect(next.operationId).toMatch(OPERATION_ID_PATTERN);
  });
});
