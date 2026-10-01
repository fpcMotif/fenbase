// Lint ratchet: fail on oxlint errors and on any warning beyond the committed baseline.
//
// Usage:
//   bun scripts/lint-ratchet.ts [--update] [-- <extra oxlint args>]
//
// The baseline (.oxlint-baseline.json) maps file -> rule -> warning count. Counts are compared per file and rule, so
// line shifts never trip the check, but a new warning in a file/rule pair fails it. Run with --update after fixing
// warnings to lower the baseline.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type Diagnostic = {
  code: string;
  severity: string;
  message: string;
  filename: string;
  labels?: { span: { line: number; column: number } }[];
};

type Baseline = Record<string, Record<string, number>>;

const root = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(root, '.oxlint-baseline.json');

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const sep = argv.indexOf('--');
const extraArgs = sep === -1 ? [] : argv.slice(sep + 1);

const oxlintBin = path.join(root, 'node_modules', '.bin', 'oxlint');
const res = spawnSync(oxlintBin, ['--format=json', ...extraArgs], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});

let diagnostics: Diagnostic[];
try {
  diagnostics = (JSON.parse(res.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
} catch {
  console.error('[lint-ratchet] oxlint did not produce JSON output.');
  if (res.error) console.error(res.error);
  if (res.stderr) console.error(res.stderr);
  process.exit(1);
}

const format = (d: Diagnostic) => {
  const pos = d.labels?.[0]?.span;
  return `${d.filename}${pos ? `:${pos.line}:${pos.column}` : ''}: ${d.severity} ${d.code}: ${d.message}`;
};

const errors = diagnostics.filter((d) => d.severity === 'error');
const warnings = diagnostics.filter((d) => d.severity !== 'error');

const current: Baseline = {};
for (const d of warnings) {
  current[d.filename] ??= {};
  current[d.filename][d.code] = (current[d.filename][d.code] ?? 0) + 1;
}

if (update) {
  const sorted: Baseline = {};
  for (const file of Object.keys(current).sort()) {
    sorted[file] = {};
    for (const rule of Object.keys(current[file]).sort()) sorted[file][rule] = current[file][rule];
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`[lint-ratchet] Wrote ${warnings.length} warnings to ${path.relative(root, baselinePath)}.`);
}

const baseline: Baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

const regressions: Diagnostic[] = [];
let added = 0;
let fixed = 0;
for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
  for (const rule of new Set([...Object.keys(current[file] ?? {}), ...Object.keys(baseline[file] ?? {})])) {
    const now = current[file]?.[rule] ?? 0;
    const allowed = baseline[file]?.[rule] ?? 0;
    if (now > allowed) {
      added += now - allowed;
      console.error(`\n[lint-ratchet] ${file}: ${rule} has ${now} warnings, baseline allows ${allowed}.`);
      for (const d of warnings) {
        if (d.filename === file && d.code === rule) regressions.push(d);
      }
    } else {
      fixed += allowed - now;
    }
  }
}

for (const d of regressions) console.error(format(d));
for (const d of errors) console.error(format(d));

console.log(`[lint-ratchet] ${errors.length} errors, ${warnings.length} warnings, ${added} new over baseline.`);
if (fixed > 0 && !update) {
  console.log(
    `[lint-ratchet] ${fixed} baseline warnings are gone. Run \`bun run lint:baseline\` to lower the baseline.`,
  );
}

if (errors.length > 0 || regressions.length > 0 || res.status !== 0) process.exit(1);
