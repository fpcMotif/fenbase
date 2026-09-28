import { type TransformOptions, transformPayload } from './lib/impl';

export type { TransformOptions };

export function formatMessage(message: string, options?: TransformOptions): string {
  return transformPayload(message, options);
}
