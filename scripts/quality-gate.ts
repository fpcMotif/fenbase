import fs from 'node:fs';
import { command, lint, prepareTypeAware, report, stagedSnapshot, type Diagnostic } from './quality-tools';

function typeAwareScope(root: string) {
  const include: string[] = JSON.parse(fs.readFileSync(`${root}/tsconfig.oxlint.json`, 'utf8')).include;
  const globs = include.map((pattern) => new Bun.Glob(pattern));
  return (file: string) => !file.endsWith('.d.ts') && globs.some((glob) => glob.match(file));
}

function introduced(root: string, diagnostic: Diagnostic, changed: Map<string, Set<number>>) {
  if (diagnostic.labels.length === 0 || diagnostic.code === 'typescript(tsconfig-error)') return true;
  const lines = changed.get(diagnostic.filename);
  if (!lines) return true;
  const contents = fs.readFileSync(`${root}/${diagnostic.filename}`);
  if (
    diagnostic.code === 'eslint(no-void)' &&
    diagnostic.labels.every(({ span }) => {
      const expression = contents.subarray(span.offset, (span.offset ?? 0) + (span.length ?? 0)).toString();
      return /^void\s*(?:0|\(\s*0\s*\))$/.test(expression);
    })
  )
    return false;
  return diagnostic.labels.some(({ span }) => {
    const end =
      span.offset !== undefined && span.length !== undefined
        ? span.line +
          contents
            .subarray(span.offset, span.offset + span.length)
            .toString()
            .split('\n').length -
          1
        : span.line;
    for (let line = span.line; line <= end; line++) if (lines.has(line)) return true;
    return false;
  });
}

export function check(root: string, base: string) {
  const files = command(root, 'git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--'], undefined, true)
    .split('\0')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const changed = new Map<string, Set<number>>();
  for (const file of files) {
    const diff = command(root, 'git', ['diff', '--no-ext-diff', '--unified=0', base, '--', file], undefined, true);
    const lines = new Set<number>();
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + count; line++) lines.add(line);
    }
    changed.set(file, lines);
  }
  const isTypeAware = typeAwareScope(root);
  prepareTypeAware(root);
  let failures = 0;
  for (const typed of [false, true]) {
    const selected = files.filter((file) => isTypeAware(file) === typed);
    if (selected.length === 0) continue;
    const args = ['-c', '.oxlintrc.policy.json', '--disable-nested-config', '--no-ignore'];
    if (typed) args.push('--type-aware', '--tsconfig', 'tsconfig.oxlint.json');
    for (const diagnostic of lint(root, [...args, '--', ...selected])) {
      if (introduced(root, diagnostic, changed)) {
        console.error(report(diagnostic));
        failures++;
      }
    }
  }
  console.log(`[quality-gate] ${files.length} changed files; ${failures} introduced diagnostics.`);
  return failures === 0 ? 0 : 1;
}

function audit(root: string) {
  const isTypeAware = typeAwareScope(root);
  const files = command(root, 'git', ['ls-files', '-z'], undefined, true)
    .split('\0')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && isTypeAware(file));
  prepareTypeAware(root);
  const diagnostics = lint(root, ['-c', '.oxlintrc.json', '--disable-nested-config', '--type-aware', '--', ...files]);
  for (const diagnostic of diagnostics) console.error(report(diagnostic));
  console.log(`[quality-gate] Type-aware audit: ${files.length} scoped files; ${diagnostics.length} diagnostics.`);
  return diagnostics.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  let snapshot: ReturnType<typeof stagedSnapshot> | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--staged') {
      snapshot = stagedSnapshot(process.cwd());
      process.exitCode = check(snapshot.directory, 'HEAD');
    } else if (args.length === 2 && args[0] === '--base') {
      const base = command(process.cwd(), 'git', ['merge-base', 'HEAD', args[1]]).trim();
      snapshot = stagedSnapshot(process.cwd(), 'HEAD');
      process.exitCode = check(snapshot.directory, base);
    } else if (args.length === 1 && args[0] === '--audit') {
      snapshot = stagedSnapshot(process.cwd());
      process.exitCode = audit(snapshot.directory);
    } else {
      throw new Error('Usage: bun scripts/quality-gate.ts --staged | --base <revision> | --audit');
    }
  } catch (error) {
    console.error(`[quality-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (snapshot) fs.rmSync(snapshot.directory, { recursive: true, force: true });
  }
}
