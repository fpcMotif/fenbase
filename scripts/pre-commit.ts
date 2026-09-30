import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function checkTool(name: string, checkCmd: string, installCmd: string): void {
  try {
    const res = spawnSync('sh', ['-c', checkCmd], { stdio: 'pipe' });
    if (res.status !== 0) {
      throw new Error(`Command exited with status ${res.status}`);
    }
  } catch {
    console.error(`\x1b[31m[pre-commit error]\x1b[0m Missing required tool: '${name}'.`);
    console.error(`Please install dependencies by running: \x1b[36m${installCmd}\x1b[0m`);
    process.exit(1);
  }
}

// 1. Verify required tools exist
checkTool('oxlint', 'bunx oxlint --version', 'bun install');
checkTool('oxfmt', 'bunx oxfmt --version', 'bun install');

// 2. Identify staged files
let stagedFiles: string[] = [];
try {
  const output = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' });
  stagedFiles = output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (e) {
  console.error('[pre-commit] Failed to get staged files:', e);
  process.exit(1);
}

if (stagedFiles.length === 0) {
  process.exit(0);
}

// 3. Filter files for formatting and linting
const FORMATTABLE_EXTENSIONS: Record<string, true> = {
  '.js': true,
  '.jsx': true,
  '.ts': true,
  '.tsx': true,
  '.json': true,
  '.css': true,
  '.scss': true,
};

const LINTABLE_EXTENSIONS: Record<string, true> = {
  '.js': true,
  '.jsx': true,
  '.ts': true,
  '.tsx': true,
};

const filesToFormat = stagedFiles.filter((f) => {
  const ext = path.extname(f);
  return Boolean(FORMATTABLE_EXTENSIONS[ext]) && fs.existsSync(f);
});

const filesToLint = stagedFiles.filter((f) => {
  const ext = path.extname(f);
  return Boolean(LINTABLE_EXTENSIONS[ext]) && fs.existsSync(f);
});

// 4. Run Oxfmt on staged formattable files
if (filesToFormat.length > 0) {
  console.log(`[pre-commit] Formatting ${filesToFormat.length} staged file(s) with oxfmt...`);
  const formatRes = spawnSync('bunx', ['oxfmt', '--write', ...filesToFormat], { stdio: 'inherit' });
  if (formatRes.status !== 0) {
    console.error('\x1b[31m[pre-commit error]\x1b[0m Oxfmt formatting failed.');
    process.exit(formatRes.status ?? 1);
  }

  // Re-add formatted files to staging
  spawnSync('git', ['add', ...filesToFormat], { stdio: 'inherit' });
}

// 5. Enforce contributor guide rules on introduced diffs: no new `any`, no new fire-and-forget `void`
let introducedViolations = false;
for (const file of filesToLint) {
  if (file.startsWith('test/fixtures/') || file.startsWith('scripts/test-') || file === 'scripts/pre-commit.ts') {
    continue;
  }

  try {
    const diff = execSync(`git diff --cached -U3 -- "${file}"`, { encoding: 'utf8' });
    const hunks = diff.split(/^@@ /m).slice(1);

    for (const hunk of hunks) {
      const hunkLines = hunk.split('\n');
      const removedLines: string[] = [];
      const addedLines: { line: string; lineNum: number }[] = [];
      let currentLineNum = 0;

      const headerMatch = hunkLines[0].match(/-\d+(?:,\d+)? \+(\d+)(?:,\d+)?/);
      if (headerMatch) {
        currentLineNum = parseInt(headerMatch[1], 10);
      }

      for (let i = 1; i < hunkLines.length; i++) {
        const l = hunkLines[i];
        if (l.startsWith('-') && !l.startsWith('---')) {
          removedLines.push(l.slice(1));
        } else if (l.startsWith('+') && !l.startsWith('+++')) {
          addedLines.push({ line: l.slice(1), lineNum: currentLineNum });
          currentLineNum++;
        } else if (!l.startsWith('\\')) {
          currentLineNum++;
        }
      }

      const removedText = removedLines.join('\n');

      for (const { line: content, lineNum } of addedLines) {
        // Check for newly introduced `any`
        const hasAny = /(?::\s*any\b|as\s+any\b|<any>)/.test(content);
        if (hasAny && !content.includes('eslint-disable') && !content.includes('oxlint-disable')) {
          const wasInRemoved = /(?::\s*any\b|as\s+any\b|<any>)/.test(removedText);
          if (!wasInRemoved) {
            console.error(
              `\x1b[31m[pre-commit error]\x1b[0m ${file}:${lineNum}: Introduced \`any\` (typescript/no-explicit-any) is prohibited by contributor guide.`,
            );
            console.error(`  > ${content.trim()}`);
            introducedViolations = true;
          }
        }

        // Check for newly introduced fire-and-forget `void`
        const hasVoid = /\bvoid\s+[\w$.]+\s*\(/.test(content);
        if (hasVoid && !content.includes('eslint-disable') && !content.includes('oxlint-disable')) {
          const wasInRemoved = /\bvoid\s+[\w$.]+\s*\(/.test(removedText);
          if (!wasInRemoved) {
            console.error(
              `\x1b[31m[pre-commit error]\x1b[0m ${file}:${lineNum}: Introduced fire-and-forget \`void\` (no-void) is prohibited by contributor guide.`,
            );
            console.error(`  > ${content.trim()}`);
            introducedViolations = true;
          }
        }
      }
    }
  } catch (e) {
    console.error(`[pre-commit] Failed to diff ${file}:`, e);
  }
}

if (introducedViolations) {
  console.error('\x1b[31m[pre-commit error]\x1b[0m Commit rejected due to introduced violations.');
  process.exit(1);
}

// 6. Run Oxlint on staged lintable files
if (filesToLint.length > 0) {
  console.log(`[pre-commit] Linting ${filesToLint.length} staged file(s) with oxlint...`);
  const lintRes = spawnSync('bunx', ['oxlint', ...filesToLint], { stdio: 'inherit' });

  if (lintRes.status !== 0) {
    console.error('\x1b[31m[pre-commit error]\x1b[0m Oxlint linting failed on staged files.');
    process.exit(lintRes.status ?? 1);
  }

  // Check type-aware for files in scoped folders
  const typeAwarePrefixes = ['convex/', 'src/demo/', 'scripts/', 'packages/core/test/src/e2e/'];
  const typeAwareFiles = filesToLint.filter(
    (f) =>
      typeAwarePrefixes.some((p) => f.startsWith(p)) &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.endsWith('.d.ts'),
  );

  if (typeAwareFiles.length > 0) {
    console.log(`[pre-commit] Running type-aware oxlint on ${typeAwareFiles.length} scoped file(s)...`);
    const typeAwareRes = spawnSync('bunx', ['oxlint', '--type-aware', ...typeAwareFiles], {
      stdio: 'inherit',
    });

    if (typeAwareRes.status !== 0) {
      console.error('\x1b[31m[pre-commit error]\x1b[0m Type-aware oxlint failed on staged files.');
      process.exit(typeAwareRes.status ?? 1);
    }
  }
}

// 7. Run license header script if present
if (fs.existsSync('scripts/addLicense.js')) {
  const licenseRes = spawnSync('node', ['./scripts/addLicense.js'], { stdio: 'inherit' });
  if (licenseRes.status !== 0) {
    process.exit(licenseRes.status ?? 1);
  }
}

console.log('\x1b[32m[pre-commit]\x1b[0m All staged checks passed.');
