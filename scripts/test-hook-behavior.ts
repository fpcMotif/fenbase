import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
console.log(`Setting up throwaway repository in ${tmpDir}...`);

try {
  // Init repo
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test Runner"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });

  // Copy configs and scripts
  fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
  fs.copyFileSync('scripts/pre-commit.ts', path.join(tmpDir, 'scripts/pre-commit.ts'));
  fs.copyFileSync('.oxlintrc.json', path.join(tmpDir, '.oxlintrc.json'));
  fs.copyFileSync('.oxfmtrc.json', path.join(tmpDir, '.oxfmtrc.json'));

  // Link node_modules so oxlint and oxfmt can run
  fs.symlinkSync(path.resolve('node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  // Test 1: Stage a good file -> must pass
  fs.writeFileSync(path.join(tmpDir, 'good.ts'), 'export const a: number = 42;\n');
  execSync('git add good.ts', { cwd: tmpDir, stdio: 'pipe' });

  const run1 = spawnSync('bun', ['scripts/pre-commit.ts'], { cwd: tmpDir, encoding: 'utf8' });
  if (run1.status === 0) {
    console.log('\x1b[32m✔\x1b[0m Hook accepted clean staged file');
  } else {
    console.error('\x1b[31m✖\x1b[0m Hook failed on clean staged file:', run1.stderr || run1.stdout);
    process.exit(1);
  }

  // Commit the good file so it becomes part of history
  execSync('git commit -m "initial clean commit"', { cwd: tmpDir, stdio: 'pipe' });

  // Test 2: Leave untouched legacy violation in working tree, stage only a good file -> must pass
  fs.writeFileSync(path.join(tmpDir, 'legacy-bad.ts'), 'export const oldAny: any = "old";\n');
  fs.writeFileSync(path.join(tmpDir, 'new-good.ts'), 'export const b: string = "new";\n');
  execSync('git add new-good.ts', { cwd: tmpDir, stdio: 'pipe' });

  const run2 = spawnSync('bun', ['scripts/pre-commit.ts'], { cwd: tmpDir, encoding: 'utf8' });
  if (run2.status === 0) {
    console.log('\x1b[32m✔\x1b[0m Hook ignored untouched legacy violation in working tree');
  } else {
    console.error('\x1b[31m✖\x1b[0m Hook failed with untouched legacy file:', run2.stderr || run2.stdout);
    process.exit(1);
  }

  // Test 3: Stage a file introducing `any` -> must be rejected
  fs.writeFileSync(path.join(tmpDir, 'staged-bad.ts'), 'export function testBad(x: any): any { return x; }\n');
  execSync('git add staged-bad.ts', { cwd: tmpDir, stdio: 'pipe' });

  const run3 = spawnSync('bun', ['scripts/pre-commit.ts'], { cwd: tmpDir, encoding: 'utf8' });
  if (run3.status !== 0 && (run3.stdout + run3.stderr).includes('no-explicit-any')) {
    console.log('\x1b[32m✔\x1b[0m Hook rejected staged file introducing `any`');
  } else {
    console.error('\x1b[31m✖\x1b[0m Hook did not reject `any` as expected. Exit code:', run3.status);
    process.exit(1);
  }

  // Test 4: Stage a file introducing fire-and-forget `void` -> must be rejected
  fs.writeFileSync(path.join(tmpDir, 'staged-void.ts'), 'void Promise.resolve();\n');
  execSync('git add staged-void.ts', { cwd: tmpDir, stdio: 'pipe' });

  const run4 = spawnSync('bun', ['scripts/pre-commit.ts'], { cwd: tmpDir, encoding: 'utf8' });
  if (run4.status !== 0 && (run4.stdout + run4.stderr).includes('no-void')) {
    console.log('\x1b[32m✔\x1b[0m Hook rejected staged file introducing `void`');
  } else {
    console.error('\x1b[31m✖\x1b[0m Hook did not reject `void` as expected. Exit code:', run4.status);
    process.exit(1);
  }

  console.log('\nAll pre-commit hook behavior verifications passed!');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
