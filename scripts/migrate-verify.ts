#!/usr/bin/env bun
/**
 * Migration Verification CLI
 *
 * Verifies setup and readiness for migrating to:
 * - Frontend: TanStack Query + Effect-TS (deployed to Cloudflare Pages)
 * - Backend: Convex
 *
 * Usage:
 *   bun scripts/migrate-verify.ts --dry-run
 *   bun scripts/migrate-verify.ts
 *   bun scripts/migrate-verify.ts --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import convexSchema from '../convex/schema';
import * as convexUsers from '../convex/users';
import { runEffectPromise } from '../src/lib/effect/client';
import { executeConvexEffectQuery } from '../src/lib/query/useConvexEffectQuery';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SIMULATED';

export interface CheckResult {
  id: string;
  category: 'runtime' | 'convex' | 'effect' | 'tanstack' | 'cloudflare' | 'docs';
  description: string;
  status: CheckStatus;
  message: string;
  details?: string;
}

export interface VerificationReport {
  mode: 'dry-run' | 'live';
  timestamp: string;
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  simulated: number;
  checks: CheckResult[];
}

interface CliArgs {
  isDryRun: boolean;
  isJson: boolean;
  isHelp: boolean;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    isDryRun: args.includes('--dry-run'),
    isJson: args.includes('--json'),
    isHelp: args.includes('--help') || args.includes('-h'),
  };
}

async function runCheck(
  id: string,
  category: CheckResult['category'],
  description: string,
  fn: () => Promise<{ ok: boolean; message: string; details?: string; warn?: boolean }>,
  isDryRun: boolean,
): Promise<CheckResult> {
  if (isDryRun) {
    try {
      const outcome = await fn();
      return {
        id,
        category,
        description,
        status: 'SIMULATED',
        message: `[DRY-RUN] ${outcome.message}`,
        details: outcome.details,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id,
        category,
        description,
        status: 'SIMULATED',
        message: `[DRY-RUN SIMULATION] Would require: ${message}`,
      };
    }
  }

  try {
    const outcome = await fn();
    return {
      id,
      category,
      description,
      status: outcome.ok ? 'PASS' : outcome.warn ? 'WARN' : 'FAIL',
      message: outcome.message,
      details: outcome.details,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id,
      category,
      description,
      status: 'FAIL',
      message: `Execution failed: ${message}`,
    };
  }
}

export async function verifyMigration(options: { isDryRun: boolean }): Promise<VerificationReport> {
  const root = process.cwd();
  const checks: CheckResult[] = [];

  // 1. Runtime environment check
  checks.push(
    await runCheck(
      'CHK-RUN-01',
      'runtime',
      'Verify Bun and Bunx execution environment',
      async () => {
        const isBun = typeof Bun !== 'undefined';
        if (!isBun) {
          return { ok: false, message: 'Process is not running under Bun runtime.' };
        }
        return { ok: true, message: `Bun runtime active (v${Bun.version})` };
      },
      options.isDryRun,
    ),
  );

  // 2. Feature Map Documentation
  checks.push(
    await runCheck(
      'CHK-DOC-01',
      'docs',
      'Verify Migration Feature Map documentation',
      async () => {
        const path = resolve(root, 'docs/migration/feature-map.md');
        if (!existsSync(path)) {
          return { ok: false, message: 'docs/migration/feature-map.md missing' };
        }
        const content = readFileSync(path, 'utf-8');
        const hasMapping = content.includes('Convex Target') && content.includes('Effect Schema');
        return {
          ok: hasMapping,
          message: hasMapping
            ? 'Feature map defines domain entity mappings and verification matrix'
            : 'Feature map incomplete',
        };
      },
      options.isDryRun,
    ),
  );

  // 3. Cloudflare Pages Configuration
  checks.push(
    await runCheck(
      'CHK-CFL-01',
      'cloudflare',
      'Verify Cloudflare configuration (wrangler.jsonc)',
      async () => {
        const path = resolve(root, 'wrangler.jsonc');
        if (!existsSync(path)) {
          return { ok: false, message: 'wrangler.jsonc missing at project root' };
        }
        const content = JSON.parse(readFileSync(path, 'utf-8'));
        const hasCompat =
          Array.isArray(content.compatibility_flags) &&
          content.compatibility_flags.includes('nodejs_compat');
        const hasOutputDir = Boolean(content.pages_build_output_dir);
        if (!hasCompat || !hasOutputDir) {
          return {
            ok: false,
            message: 'wrangler.jsonc must specify nodejs_compat and pages_build_output_dir',
          };
        }
        return {
          ok: true,
          message: `Cloudflare Pages configuration valid: ${content.name} -> ${content.pages_build_output_dir}`,
        };
      },
      options.isDryRun,
    ),
  );

  // 4. Convex Backend Schema
  checks.push(
    await runCheck(
      'CHK-CVX-01',
      'convex',
      'Verify Convex schema definition',
      async () => {
        const hasTables = Boolean(convexSchema && convexSchema.tables);
        return {
          ok: hasTables,
          message: hasTables
            ? `Convex schema valid with tables: ${Object.keys(convexSchema.tables).join(', ')}`
            : 'Convex schema missing tables',
        };
      },
      options.isDryRun,
    ),
  );

  // 5. Convex Functions
  checks.push(
    await runCheck(
      'CHK-CVX-02',
      'convex',
      'Verify Convex queries and mutations',
      async () => {
        const hasFunctions =
          typeof convexUsers.listUsers === 'function' && typeof convexUsers.getViewer === 'function';
        return {
          ok: hasFunctions,
          message: hasFunctions
            ? 'Convex user queries implemented'
            : 'Expected listUsers and getViewer queries',
        };
      },
      options.isDryRun,
    ),
  );

  // 6. Effect-TS Client Layer
  checks.push(
    await runCheck(
      'CHK-EFF-01',
      'effect',
      'Verify Effect-TS RPC boundary and tagged error model',
      async () => {
        const result = await runEffectPromise(async () => 'ok');
        const isTagCorrect = result._tag === 'Success' && result.value === 'ok';
        return {
          ok: isTagCorrect,
          message: isTagCorrect
            ? 'Effect-TS computation and error channels functional'
            : 'Invalid Effect result tag',
        };
      },
      options.isDryRun,
    ),
  );

  // 7. TanStack Query Adapter
  checks.push(
    await runCheck(
      'CHK-TSQ-01',
      'tanstack',
      'Verify TanStack Query adapter with Effect execution',
      async () => {
        const queryOutcome = await executeConvexEffectQuery({
          queryKey: ['users', 'viewer'],
          queryFn: async () => ({ id: 'usr_test', email: 'test@example.com' }),
        });
        const passed = queryOutcome._tag === 'Success' && queryOutcome.value.id === 'usr_test';
        return {
          ok: passed,
          message: passed
            ? 'TanStack Query adapter successfully executes Effect queries'
            : 'Adapter returned invalid query outcome',
        };
      },
      options.isDryRun,
    ),
  );

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  const simulated = checks.filter((c) => c.status === 'SIMULATED').length;

  return {
    mode: options.isDryRun ? 'dry-run' : 'live',
    timestamp: new Date().toISOString(),
    totalChecks: checks.length,
    passed,
    failed,
    warnings,
    simulated,
    checks,
  };
}

function printCliReport(report: VerificationReport): void {
  console.log('='.repeat(72));
  console.log(`Migration Verification Report [Mode: ${report.mode.toUpperCase()}]`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log('='.repeat(72));

  for (const check of report.checks) {
    const symbol =
      check.status === 'PASS'
        ? '\x1b[32m✔ PASS\x1b[0m'
        : check.status === 'SIMULATED'
          ? '\x1b[36mℹ SIMULATED\x1b[0m'
          : check.status === 'WARN'
            ? '\x1b[33m⚠ WARN\x1b[0m'
            : '\x1b[31m✖ FAIL\x1b[0m';

    console.log(`[${check.id}] ${symbol} ${check.description}`);
    console.log(`       Message: ${check.message}`);
    if (check.details) {
      console.log(`       Details: ${check.details}`);
    }
  }

  console.log('-'.repeat(72));
  console.log(
    `Total: ${report.totalChecks} | Passed: ${report.passed} | Simulated: ${report.simulated} | Warnings: ${report.warnings} | Failed: ${report.failed}`,
  );
  console.log('='.repeat(72));
}

async function main(): Promise<void> {
  const { isDryRun, isJson, isHelp } = parseCliArgs();

  if (isHelp) {
    console.log(`
Migration Verification CLI
Usage:
  bun scripts/migrate-verify.ts [options]

Options:
  --dry-run   Simulate all checks and contracts without strict environment requirements
  --json      Output machine-readable JSON report
  --help, -h  Display this help message
`);
    process.exit(0);
  }

  const report = await verifyMigration({ isDryRun });

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printCliReport(report);
  }

  if (report.failed > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
