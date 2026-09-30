import { spawnSync } from 'node:child_process';
import process from 'node:process';

const scopedFiles = [
  'convex/auth.ts',
  'src/demo/App.tsx',
  'scripts/migrate-verify.ts',
  'packages/core/test/src/e2e/e2eUtils.ts',
];

console.log('Measuring Type-Aware Linting Performance on Scoped Files...\n');
const startTime = performance.now();
const startMemory = process.memoryUsage().rss;

const res = spawnSync('bunx', ['oxlint', '--type-aware', ...scopedFiles], {
  encoding: 'utf8',
  stdio: 'pipe',
});

const endTime = performance.now();
const endMemory = process.memoryUsage().rss;

const durationMs = (endTime - startTime).toFixed(2);
const memoryMb = ((endMemory - startMemory) / 1024 / 1024).toFixed(2);

console.log(`Execution Time: ${durationMs} ms`);
console.log(`Memory Delta: ${memoryMb} MB`);
console.log(`Exit Code: ${res.status}`);

if (res.stdout) console.log('Stdout:', res.stdout.trim());
if (res.stderr) console.error('Stderr:', res.stderr.trim());
