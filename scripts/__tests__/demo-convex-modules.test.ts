import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('deployed Convex modules', () => {
  it('leave test support files out of the deployment', () => {
    const generated = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'convex', '_generated', 'api.d.ts');
    expect(readFileSync(generated, 'utf8').match(/["']__tests__\/[^"']+["']/g) ?? []).toEqual([]);
  });
});
