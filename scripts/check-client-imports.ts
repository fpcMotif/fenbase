import { lint, report } from './quality-tools';

try {
  const diagnostics = lint(process.cwd(), ['-c', '.oxlintrc.boundaries.json', 'packages']);
  for (const diagnostic of diagnostics) console.error(report(diagnostic));
  console.log(`[client-boundary] ${diagnostics.length} runtime import violations.`);
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
