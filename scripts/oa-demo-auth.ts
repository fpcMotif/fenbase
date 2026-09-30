import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OaApi = <T = unknown>(
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number | boolean>;
  },
) => Promise<T>;

type ApiOptions = Parameters<OaApi>[1];

function readRuntimeEnv(): Record<string, string> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../storage/oa-demo/runtime.env');
  if (!existsSync(path)) return {};

  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();
        const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
        return [key, value];
      }),
  );
}

function makeUrl(baseUrl: string, path: string, params?: ApiOptions['params']): URL {
  const route = path.replace(/^\/+/, '').replace(/^api\//, '');
  const url = new URL(`/api/${route}`, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: ApiOptions,
  token?: string,
  authenticator?: string,
): Promise<T> {
  const headers = new Headers();
  if (options?.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (authenticator) headers.set('X-Authenticator', authenticator);

  const response = await fetch(makeUrl(baseUrl, path, options?.params), {
    method: options?.method ?? (options?.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(`NocoBase API request failed (${response.status} ${response.statusText})`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`NocoBase API returned invalid JSON (${response.status})`);
  }
}

export async function createOaApi(): Promise<{ api: OaApi; user: { id: number } }> {
  const runtimeEnv = readRuntimeEnv();
  const baseUrl = process.env.OA_BASE_URL ?? runtimeEnv.OA_BASE_URL ?? 'http://localhost:13000';
  const email = process.env.OA_ADMIN_EMAIL ?? runtimeEnv.OA_ADMIN_EMAIL ?? 'admin@fenbase.demo';
  const password = process.env.OA_ADMIN_PASSWORD ?? runtimeEnv.OA_ADMIN_PASSWORD;

  if (!password) throw new Error('OA_ADMIN_PASSWORD is required in the environment or runtime.env');

  const envelope = await requestJson<{
    data?: {
      token?: unknown;
      user?: { id?: unknown };
    };
  }>(baseUrl, 'auth:signIn', { method: 'POST', body: { email, password } }, undefined, 'basic');

  const token = envelope.data?.token;
  const userId = envelope.data?.user?.id;
  if (typeof token !== 'string' || typeof userId !== 'number' || !Number.isSafeInteger(userId)) {
    throw new Error('NocoBase sign-in response is missing the admin token or numeric user ID');
  }

  const api: OaApi = <T = unknown>(path: string, options?: ApiOptions) =>
    requestJson<T>(baseUrl, path, options ?? {}, token, 'basic');

  return { api, user: { id: userId } };
}
