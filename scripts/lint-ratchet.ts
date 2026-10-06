import fs from 'node:fs';
import path from 'node:path';
import { lint, report } from './quality-tools';

type Baseline = Record<string, Record<string, number>>;
try {
  const root = process.cwd();
  const baselinePath = path.join(root, '.oxlint-baseline.json');
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--update')) throw new Error('Usage: bun scripts/lint-ratchet.ts [--update]');
  const update = args.includes('--update');
  const parsed: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid lint baseline');
  const baseline: Baseline = {};
  for (const [file, rules] of Object.entries(parsed)) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Invalid baseline rules');
    baseline[file] = {};
    for (const [rule, count] of Object.entries(rules)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new Error('Invalid baseline count');
      baseline[file][rule] = count;
    }
  }
  const diagnostics = lint(root, []);
  const current: Baseline = {};
  let errors = 0;
  let added = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      console.error(report(diagnostic));
      errors++;
    } else {
      current[diagnostic.filename] ??= {};
      const count = (current[diagnostic.filename][diagnostic.code] ?? 0) + 1;
      current[diagnostic.filename][diagnostic.code] = count;
      if (count > (baseline[diagnostic.filename]?.[diagnostic.code] ?? 0)) {
        console.error(report(diagnostic));
        added++;
      }
    }
  }
  if (errors || added) throw new Error(`${errors} errors, ${added} warnings above baseline; baseline unchanged.`);
  if (update) {
    const sorted: Baseline = {};
    for (const file of Object.keys(current).sort()) {
      sorted[file] = Object.fromEntries(
        Object.entries(current[file]).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  }
  console.log(`[lint-ratchet] ${diagnostics.length} diagnostics; no regressions.`);
} catch (error) {
  console.error(`[lint-ratchet] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
