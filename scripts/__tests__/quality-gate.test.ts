import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '../..');
setDefaultTimeout(30_000);
const directories: string[] = [];
function temporary(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
function run(root: string, command: string, args: string[]) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8' });
}
function git(root: string, ...args: string[]) {
  const result = run(root, 'git', args);
  expect(result.status).toBe(0);
  return result.stdout;
}
function commitWithoutHooks(root: string, message: string) {
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
}
function script(name: string) {
  return path.join(source, 'scripts', name);
}
function gate(root: string, ...args: string[]) {
  return run(root, 'bun', [script('quality-gate.ts'), ...args]);
}
function expectGate(result: ReturnType<typeof run>, rule?: string) {
  if (rule) {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rule);
  } else {
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
}
function installPreCommitHook(root: string) {
  const hook = path.join(root, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nexec bun '${source}/scripts/pre-commit.ts'\n`, { mode: 0o755 });
  git(root, 'config', 'core.hooksPath', path.dirname(hook));
}
function repository() {
  const root = temporary('quality-gate-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'));
  for (const file of [
    '.oxlintrc.json',
    '.oxlintrc.policy.json',
    '.oxlintrc.boundaries.json',
    '.oxfmtrc.json',
    'tsconfig.oxlint.json',
  ]) {
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.');
  commitWithoutHooks(root, 'fixture');
  return root;
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
test('index and PR-base checks enforce any, promise, void, and hook rules', () => {
  const root = repository();
  const file = path.join(root, 'scripts/example.tsx');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  for (const [text, rule] of [
    ['export type Value = Array<\n  any\n>;\n', 'no-explicit-any'],
    ['export type Value = Array<\n  unknown\n>;\n', ''],
    ['Promise.resolve(1);\n', 'no-floating-promises'],
    ['void Promise.resolve(1);\n', 'no-void'],
    ['Promise.resolve(1).catch(console.error);\n', ''],
    [
      "import React, { useState } from 'react';\nexport function Component({ condition }: {condition: boolean}) {\nif (condition) useState(0);\nreturn <div />;\n}\n",
      'rules-of-hooks',
    ],
    ['export const values = [1];\nvalues.forEach(async () => { await Promise.resolve(1); });\n', 'no-misused-promises'],
    ['export function handler(): void { console.log(1); }\nexport const sentinel = void 0;\n', ''],
  ]) {
    fs.writeFileSync(file, text);
    git(root, 'add', '.');
    expectGate(gate(root, '--staged'), rule);
    commitWithoutHooks(root, 'fixture change');
    expectGate(gate(root, '--base', base), rule);
  }
});

test('a change to a later line of a multiline diagnostic span is introduced', () => {
  const root = repository();
  const file = path.join(root, 'scripts/example.ts');
  fs.writeFileSync(file, 'Promise.resolve(\n  1\n).catch(console.error);\n');
  git(root, 'add', '.');
  commitWithoutHooks(root, 'handled promise');
  fs.writeFileSync(file, 'Promise.resolve(\n  1\n);\n');
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'), 'no-floating-promises');
});

test('a real commit preserves unstaged bytes, including unusual filenames, on pass and failure', () => {
  const root = repository();
  const filename = "scripts/odd '$ name\n.ts";
  const file = path.join(root, filename);
  fs.writeFileSync(file, 'export const first = 1;\nexport const second = 2;\n');
  git(root, 'add', '.');
  commitWithoutHooks(root, 'initial');
  installPreCommitHook(root);
  fs.writeFileSync(file, 'export const first=3;\nexport const second = 2;\n');
  git(root, 'add', '--', filename);
  const unstaged = 'export const first=3;\nexport const second = 4;\n';
  fs.writeFileSync(file, unstaged);
  const committed = run(root, 'git', ['commit', '-qm', 'test partial staging']);
  expect(committed.stderr + committed.stdout).not.toContain('[pre-commit] Failed');
  expect(committed.status).toBe(0);
  expect(git(root, 'show', `HEAD:${filename}`)).toContain('second = 2');
  expect(fs.readFileSync(file, 'utf8')).toBe(unstaged);
  fs.writeFileSync(file, 'export type Unsafe = any;\n');
  git(root, 'add', '--', filename);
  fs.writeFileSync(file, unstaged);
  const before = run(root, 'git', ['write-tree']).stdout;
  expect(run(root, 'git', ['commit', '-qm', 'rejected']).status).not.toBe(0);
  expect(run(root, 'git', ['write-tree']).stdout).toBe(before);
  expect(fs.readFileSync(file, 'utf8')).toBe(unstaged);
});

test('a real commit records staged tsconfig files as formatted, not as type-aware preparation rewrites them', () => {
  const root = repository();
  fs.mkdirSync(path.join(root, 'packages/x'), { recursive: true });
  for (const name of ['tsconfig.json', 'packages/x/tsconfig.json']) {
    fs.writeFileSync(path.join(root, name), '{"compilerOptions":{"strict":true}}\n');
  }
  installPreCommitHook(root);
  git(root, 'add', '.');
  const committed = run(root, 'git', ['commit', '-qm', 'tsconfig change']);
  expect(committed.stderr + committed.stdout).not.toContain('[pre-commit] Failed');
  expect(committed.status).toBe(0);
  for (const name of ['tsconfig.json', 'packages/x/tsconfig.json']) {
    const blob = git(root, 'show', `HEAD:${name}`);
    expect(blob).toBe(fs.readFileSync(path.join(root, name), 'utf8'));
    expect(blob).toContain('"strict": true');
    expect(blob).not.toContain('skipLibCheck');
  }
});

test('pre-commit rejects a staged symlink before changing anything', () => {
  const root = repository();
  fs.symlinkSync('target.ts', path.join(root, 'link.ts'));
  git(root, 'add', '.');
  const before = git(root, 'write-tree');
  const result = run(root, 'bun', [script('pre-commit.ts')]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Staged symlink requires separate review: link.ts');
  expect(git(root, 'write-tree')).toBe(before);
});

test('ratchet fails closed and update cannot bless a regression', () => {
  const root = temporary('ratchet-');
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  const baseline = path.join(root, '.oxlint-baseline.json');
  fs.writeFileSync(baseline, '{}\n');
  const binary = path.join(root, 'node_modules/.bin/oxlint');
  for (const [output, message] of [
    ['{}', 'invalid diagnostics'],
    ['{"number_of_files":1,"diagnostics":[{}]}', 'malformed diagnostic'],
    [
      JSON.stringify({
        number_of_files: 1,
        diagnostics: [{ code: 'rule', severity: 'warning', message: 'new debt', filename: 'new.ts', labels: [] }],
      }),
      'above baseline',
    ],
  ]) {
    fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s' '${output}'\n`, { mode: 0o755 });
    const result = run(root, 'bun', [script('lint-ratchet.ts'), '--update']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.readFileSync(baseline, 'utf8')).toBe('{}\n');
  }
  fs.writeFileSync(binary, '#!/bin/sh\nprintf \'{"diagnostics":[]}\'\nexit 2\n', { mode: 0o755 });
  expect(run(root, 'bun', [script('lint-ratchet.ts')]).status).not.toBe(0);
  fs.writeFileSync(binary, '#!/bin/sh\nprintf \'{"number_of_files":1,"diagnostics":[]}\'\n', { mode: 0o755 });
  fs.writeFileSync(baseline, '{"old.ts":{"rule":1}}\n');
  expect(run(root, 'bun', [script('lint-ratchet.ts'), '--update']).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(baseline, 'utf8'))).toEqual({});
});

test('unchanged debt is allowed but removed violations do not excuse added violations', () => {
  const root = repository();
  const file = path.join(root, 'scripts/legacy.ts');
  fs.writeFileSync(file, 'export type Legacy = any;\nexport const value = 1;\n');
  git(root, 'add', '.');
  commitWithoutHooks(root, 'legacy');
  fs.writeFileSync(file, 'export type Legacy = any;\nexport const value = 2;\n');
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'));
  fs.writeFileSync(file, 'export type Replacement = any | Array<any>;\nexport const value = 2;\n');
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'), 'no-explicit-any');
});

test('real suppression semantics apply without exempting whole files or ignored directories', () => {
  const root = repository();
  const file = path.join(root, 'docs/example.ts');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport type ValidSuppression = any;\n',
  );
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'));
  fs.appendFileSync(file, 'export type Unrelated = any;\n');
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'), 'no-explicit-any');
});

test('license updates stay inside the staged snapshot and binary contents remain exact', () => {
  const root = repository();
  fs.copyFileSync(path.join(source, 'scripts/addLicense.js'), path.join(root, 'scripts/addLicense.js'));
  fs.mkdirSync(path.join(root, 'packages/example/src'), { recursive: true });
  const file = path.join(root, "packages/example/src/odd '$\n.ts");
  fs.writeFileSync(file, 'export const staged = 1;\n');
  const binary = Buffer.from([0, 255, 1, 192, 128, 64]);
  fs.writeFileSync(path.join(root, 'asset.bin'), binary);
  git(root, 'add', '.');
  fs.writeFileSync(file, 'export const unstaged = 2;\n');
  const result = run(root, 'bun', [script('pre-commit.ts')]);
  expect(result.stderr + result.stdout).not.toContain('[pre-commit] Failed');
  expect(result.status).toBe(0);
  expect(git(root, 'show', ":packages/example/src/odd '$\n.ts")).toContain('NocoBase');
  expect(fs.readFileSync(file, 'utf8')).toBe('export const unstaged = 2;\n');
  expect(spawnSync('git', ['show', ':asset.bin'], { cwd: root }).stdout).toEqual(binary);
});

test('license headers are not added while a merge is in progress', () => {
  const root = repository();
  fs.copyFileSync(path.join(source, 'scripts/addLicense.js'), path.join(root, 'scripts/addLicense.js'));
  fs.mkdirSync(path.join(root, 'packages/example/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/example/src/merged.ts'), 'export const merged = 1;\n');
  git(root, 'add', '.');
  fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), git(root, 'rev-parse', 'HEAD'));
  const result = run(root, 'bun', [script('pre-commit.ts')]);
  expect(result.status).toBe(0);
  expect(git(root, 'show', ':packages/example/src/merged.ts')).not.toContain('NocoBase');
});

test('a real commit preserves unstaged binary bytes with equal UTF-8 decoding', () => {
  const root = repository();
  const file = path.join(root, 'asset.bin');
  fs.writeFileSync(file, Buffer.from([0, 255]));
  git(root, 'add', '.');
  fs.writeFileSync(file, Buffer.from([0, 254]));
  installPreCommitHook(root);
  const committed = run(root, 'git', ['commit', '-qm', 'preserve binary staging']);
  expect(committed.status).toBe(0);
  expect(spawnSync('git', ['show', 'HEAD:asset.bin'], { cwd: root }).stdout).toEqual(Buffer.from([0, 255]));
  expect(fs.readFileSync(file)).toEqual(Buffer.from([0, 254]));
});

test('a real commit preserves external targets of working-file and parent-directory symlinks', () => {
  const root = repository();
  const external = temporary('quality-hook-external-');
  const contents = '{"value":1}\n';
  fs.mkdirSync(path.join(root, 'settings'));
  for (const name of ['direct.json', 'settings/nested.json']) {
    fs.writeFileSync(path.join(root, name), contents);
  }
  git(root, 'add', '.');
  fs.writeFileSync(path.join(external, 'direct.json'), contents);
  fs.writeFileSync(path.join(external, 'nested.json'), contents);
  fs.unlinkSync(path.join(root, 'direct.json'));
  fs.symlinkSync(path.join(external, 'direct.json'), path.join(root, 'direct.json'));
  fs.rmSync(path.join(root, 'settings'), { recursive: true });
  fs.symlinkSync(external, path.join(root, 'settings'));
  installPreCommitHook(root);
  const committed = run(root, 'git', ['commit', '-qm', 'preserve working symlinks']);
  expect(committed.status).toBe(0);
  expect(git(root, 'show', 'HEAD:direct.json')).toContain('"value": 1');
  expect(git(root, 'show', 'HEAD:settings/nested.json')).toContain('"value": 1');
  expect(fs.readFileSync(path.join(external, 'direct.json'), 'utf8')).toBe(contents);
  expect(fs.readFileSync(path.join(external, 'nested.json'), 'utf8')).toBe(contents);
  expect(fs.lstatSync(path.join(root, 'direct.json')).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(path.join(root, 'settings')).isSymbolicLink()).toBe(true);
});

test('missing repository binaries fail with an installation command', () => {
  const root = repository();
  fs.unlinkSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'scripts/example.ts'), 'export const ok = 1;\n');
  git(root, 'add', '.');
  const result = gate(root, '--staged');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('bun install --frozen-lockfile');
});

test('client boundary rejects legacy runtime imports and accepts modern imports', () => {
  const root = repository();
  const file = path.join(root, 'packages/example/src/client-v2/example.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export { Plugin } from '@nocobase/client';\n");
  const bad = run(root, 'bun', [script('check-client-imports.ts')]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('no-restricted-imports');
  fs.writeFileSync(file, "export { Plugin } from '@nocobase/client-v2';\n");
  expect(run(root, 'bun', [script('check-client-imports.ts')]).status).toBe(0);
});

test('type-aware checks use staged dependency types instead of unstaged workspace symlinks', () => {
  const root = repository();
  const producer = path.join(root, 'packages/provider/src/index.ts');
  fs.mkdirSync(path.dirname(producer), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/provider/package.json'), '{"types":"src/index.ts"}\n');
  fs.unlinkSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'node_modules/@fixture'), { recursive: true });
  fs.symlinkSync(path.join(source, 'node_modules/.bin'), path.join(root, 'node_modules/.bin'));
  fs.symlinkSync(path.join(root, 'packages/provider'), path.join(root, 'node_modules/@fixture/provider'));
  fs.appendFileSync(path.join(root, '.gitignore'), 'tsconfig.paths.json\n');
  fs.writeFileSync(
    path.join(root, 'tsconfig.paths.json'),
    JSON.stringify({
      compilerOptions: { paths: { '@fixture/provider': ['packages/provider/src/index.ts'] } },
    }),
  );
  fs.writeFileSync(producer, 'export function load() { return Promise.resolve(1); }\n');
  fs.writeFileSync(path.join(root, 'scripts/consumer.ts'), "import { load } from '@fixture/provider';\nload();\n");
  git(root, 'add', '.');
  fs.writeFileSync(producer, 'export function load() { return 1; }\n');
  expectGate(gate(root, '--staged'), 'no-floating-promises');
  git(root, 'add', '--', 'packages/provider/src/index.ts');
  expectGate(gate(root, '--staged'));
});

test('snapshot configuration replacement preserves external symlink targets', () => {
  const root = repository();
  const external = temporary('quality-gate-external-');
  for (const name of ['tsconfig.json', 'tsconfig.paths.json']) {
    fs.writeFileSync(path.join(external, name), '{"compilerOptions":{"paths":{}}}\n');
    fs.symlinkSync(path.join(external, name), path.join(root, name));
  }
  fs.writeFileSync(path.join(root, 'scripts/example.ts'), 'export const value = 1;\n');
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'));
  for (const name of ['tsconfig.json', 'tsconfig.paths.json']) {
    expect(fs.readFileSync(path.join(external, name), 'utf8')).toBe('{"compilerOptions":{"paths":{}}}\n');
    expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
  }
});

test('docs rules keep a11y and font-display checks in their intended scope', () => {
  const root = repository();
  fs.mkdirSync(path.join(root, 'docs'));
  const example = path.join(root, 'docs/example.tsx');
  const font = path.join(root, 'docs/font.tsx');
  fs.writeFileSync(example, "import React from 'react';\nexport function Example() { return <button>Run</button>; }\n");
  const contents =
    'import React from \'react\';\nexport function Font() { return <link href="https://fonts.googleapis.com/css2?family=Roboto" rel="stylesheet" />; }\n';
  fs.writeFileSync(font, contents);
  fs.writeFileSync(path.join(root, 'font.tsx'), contents);
  git(root, 'add', '.');
  const bad = gate(root, '--staged');
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('button-has-type');
  expect(bad.stderr).toContain('google-font-display');
  fs.writeFileSync(
    example,
    'import React from \'react\';\nexport function Example() { return <button type="button">Run</button>; }\n',
  );
  fs.writeFileSync(font, contents.replace('family=Roboto', 'family=Roboto&display=swap'));
  git(root, 'add', '.');
  expectGate(gate(root, '--staged'));
});
