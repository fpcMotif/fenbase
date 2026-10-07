import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const convexDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'convex');

describe('deployed Convex modules', () => {
  it('leave test support files out of the deployment', () => {
    const generated = join(convexDirectory, '_generated', 'api.d.ts');
    expect(readFileSync(generated, 'utf8').match(/["']__tests__\/[^"']+["']/g) ?? []).toEqual([]);
  });

  it('never hand out storage URLs or upload URLs that are not bound to a caller', () => {
    const offenders = readdirSync(convexDirectory)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /\b(getUrl|generateUploadUrl)\(/.test(readFileSync(join(convexDirectory, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
