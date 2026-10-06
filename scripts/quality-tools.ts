import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Diagnostic = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  filename: string;
  labels: { span: { line: number; column: number; offset?: number; length?: number } }[];
};

export function command(root: string, bin: string, args: string[], input?: string | Buffer, isolated = false) {
  const env = { ...process.env };
  if (isolated) for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed: ${result.error ?? result.stderr ?? result.stdout}`);
  }
  return result.stdout;
}

export function tool(root: string, name: string) {
  const bin = path.join(root, 'node_modules', '.bin', name);
  if (!fs.existsSync(bin)) throw new Error(`Missing repository tool ${name}. Run: bun install --frozen-lockfile`);
  return bin;
}

export function lint(root: string, args: string[]): Diagnostic[] {
  const result = spawnSync(tool(root, 'oxlint'), ['--format=json', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status ?? -1)) {
    throw new Error(`Oxlint failed: ${result.error ?? result.stderr}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('diagnostics' in parsed) ||
    !Array.isArray(parsed.diagnostics) ||
    !('number_of_files' in parsed) ||
    typeof parsed.number_of_files !== 'number' ||
    parsed.number_of_files < 1
  ) {
    throw new Error('Oxlint returned invalid diagnostics');
  }
  const diagnostics: Diagnostic[] = [];
  for (const value of parsed.diagnostics) {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.code !== 'string' ||
      typeof value.filename !== 'string' ||
      typeof value.message !== 'string' ||
      !['error', 'warning'].includes(value.severity) ||
      !Array.isArray(value.labels) ||
      !value.labels.every(
        (label: { span?: { line?: number; column?: number } }) =>
          Number.isInteger(label?.span?.line) &&
          Number.isInteger(label?.span?.column) &&
          (label.span?.line ?? 0) > 0 &&
          (label.span?.column ?? 0) > 0,
      )
    )
      throw new Error('Oxlint returned malformed diagnostic');
    diagnostics.push(value);
  }
  if (result.status !== 0 && !diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
    throw new Error(`Oxlint failed without diagnostics: ${result.stderr}`);
  return diagnostics;
}

export function stagedSnapshot(root: string, revision?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fenbase-index-'));
  try {
    const gitDir = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const head = command(root, 'git', ['rev-parse', 'HEAD']).trim();
    command(root, 'git', ['clone', '--quiet', '--shared', '--no-checkout', gitDir, directory], undefined, true);
    command(directory, 'git', ['update-ref', '--no-deref', 'HEAD', head], undefined, true);
    const tree = command(root, 'git', revision ? ['rev-parse', `${revision}^{tree}`] : ['write-tree']).trim();
    command(directory, 'git', ['read-tree', tree], undefined, true);
    command(directory, 'git', ['checkout-index', '--all'], undefined, true);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    const generatedPaths = path.join(root, 'tsconfig.paths.json');
    if (fs.existsSync(generatedPaths)) fs.copyFileSync(generatedPaths, path.join(directory, 'tsconfig.paths.json'));
    return { directory, tree };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function prepareTypeAware(root: string) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.oxlint.json'), 'utf8'));
  const generatedPaths = path.join(root, 'tsconfig.paths.json');
  if (fs.existsSync(generatedPaths)) {
    const paths: Record<string, string[]> = JSON.parse(fs.readFileSync(generatedPaths, 'utf8')).compilerOptions.paths;
    config.compilerOptions.paths = Object.fromEntries(
      Object.entries(paths).map(([name, values]) => [
        name,
        values.map((value) =>
          value.startsWith('./') || value.startsWith('../') || path.isAbsolute(value) ? value : `./${value}`,
        ),
      ]),
    );
  }
  fs.writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const file of command(root, 'git', ['ls-files', '-z'], undefined, true).split('\0')) {
    if (file.endsWith('/tsconfig.json')) fs.rmSync(path.join(root, file));
  }
}

export function report(diagnostic: Diagnostic) {
  const span = diagnostic.labels[0]?.span;
  return `${diagnostic.filename}:${span?.line ?? 1}:${span?.column ?? 1}: ${diagnostic.code}: ${diagnostic.message}`;
}
