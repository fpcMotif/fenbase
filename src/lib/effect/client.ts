/**
 * Effect-TS RPC boundary and client execution model.
 */

export interface ConvexRpcError {
  readonly _tag: 'ConvexRpcError';
  readonly code: string;
  readonly message: string;
}

export interface ValidationError {
  readonly _tag: 'ValidationError';
  readonly field: string;
  readonly message: string;
}

export type DomainError = ConvexRpcError | ValidationError;

export type EffectResult<A, E = DomainError> =
  | { readonly _tag: 'Success'; readonly value: A }
  | { readonly _tag: 'Failure'; readonly error: E };

export function succeed<A>(value: A): EffectResult<A, never> {
  return { _tag: 'Success', value };
}

export function fail<E>(error: E): EffectResult<never, E> {
  return { _tag: 'Failure', error };
}

export async function runEffectPromise<A>(effectFn: () => Promise<A>): Promise<EffectResult<A, ConvexRpcError>> {
  try {
    const value = await effectFn();
    return succeed(value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail({
      _tag: 'ConvexRpcError',
      code: 'EXECUTION_FAILED',
      message,
    });
  }
}
