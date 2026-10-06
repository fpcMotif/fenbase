import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check } from './quality-gate';
import { command, stagedSnapshot, tool } from './quality-tools';

const root = process.cwd();
let snapshot: ReturnType<typeof stagedSnapshot> | undefined;
try {
  tool(root, 'oxlint');
  tool(root, 'oxfmt');
  const files = command(root, 'git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
  if (files.length > 0) {
    snapshot = stagedSnapshot(root);
    const stage = snapshot.directory;
    const entries = new Map<string, { mode: string; original: string }>();
    const index = command(
      stage,
      'git',
      ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...files],
      undefined,
      true,
    );
    for (const record of index.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const [mode, original] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, original });
    }
    const staged = files.map((file) => {
      const entry = entries.get(file);
      if (entry?.mode === '120000') throw new Error(`Staged symlink requires separate review: ${file}`);
      if (entry?.mode !== '100644' && entry?.mode !== '100755')
        throw new Error(`Unsupported staged file mode: ${file}`);
      return { file, ...entry };
    });
    const merging = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root }).status === 0;
    if (!merging && fs.existsSync(path.join(stage, 'scripts/addLicense.js'))) {
      command(stage, 'node', ['scripts/addLicense.js'], undefined, true);
    }
    const formattable = files.filter((file) => /\.(?:[cm]?[jt]sx?|json|css|scss)$/.test(file));
    if (formattable.length > 0) command(stage, tool(stage, 'oxfmt'), ['--write', '--', ...formattable]);
    command(stage, 'git', ['add', '--', ...files], undefined, true);
    const updates = staged.map((entry) => ({ ...entry, content: fs.readFileSync(path.join(stage, entry.file)) }));
    if (check(stage, 'HEAD') !== 0) throw new Error('Introduced diagnostics');
    if (command(root, 'git', ['write-tree']).trim() !== snapshot.tree) {
      throw new Error('Index changed during checks; retry the commit.');
    }
    const records: string[] = [];
    for (const { file, mode, content } of updates) {
      const oid = command(root, 'git', ['hash-object', '-w', '--stdin'], content).trim();
      records.push(`${mode} ${oid}\t${file}\0`);
    }
    command(root, 'git', ['update-index', '-z', '--index-info'], records.join(''));
    const canonicalRoot = fs.realpathSync(root);
    for (const { file, content, original } of updates) {
      const workingFile = path.join(root, file);
      if (
        fs.existsSync(workingFile) &&
        fs.realpathSync(workingFile) === path.join(canonicalRoot, file) &&
        command(root, 'git', ['hash-object', '--stdin'], fs.readFileSync(workingFile)).trim() === original
      ) {
        fs.writeFileSync(workingFile, content);
      }
    }
  }
  console.log('[pre-commit] Staged snapshot checks passed.');
} catch (error) {
  console.error(`[pre-commit] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (snapshot) fs.rmSync(snapshot.directory, { recursive: true, force: true });
}
