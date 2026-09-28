export interface TransformOptions {
  prefix?: string;
  repeat?: number;
  uppercase?: boolean;
}

export function transformPayload(input: string, options: TransformOptions = {}): string {
  const { prefix = '', repeat = 1, uppercase = false } = options;
  let normalized = input.trim();
  if (uppercase) {
    normalized = normalized.toUpperCase();
  }
  const repeated = Array.from({ length: Math.max(1, repeat) }, () => normalized).join(' ');
  return prefix ? `${prefix}: ${repeated}` : repeated;
}
