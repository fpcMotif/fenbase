import { describe, expect, it } from 'vitest';
import { formatMessage } from '../index';

describe('example package deep module boundary', () => {
  it('formats payload via the public entrypoint without exposing internals', () => {
    const formatted = formatMessage('hello', { prefix: 'STATUS', repeat: 2, uppercase: true });
    expect(formatted).toBe('STATUS: HELLO HELLO');
  });
});
