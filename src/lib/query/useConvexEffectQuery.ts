import { type EffectResult, runEffectPromise, type DomainError } from '../effect/client';

export interface QueryOptions<TData> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TData>;
  enabled?: boolean;
}

export interface QueryResult<TData, TError = DomainError> {
  data: TData | undefined;
  error: TError | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
}

/**
 * Adapter bridging Convex operations through Effect-TS into TanStack Query shape.
 */
export async function executeConvexEffectQuery<TData>(
  options: QueryOptions<TData>,
): Promise<EffectResult<TData, DomainError>> {
  return runEffectPromise(options.queryFn);
}
