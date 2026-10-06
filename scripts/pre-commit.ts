import fs from 'node:fs';
import path from 'node:path';
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
    for (const file of files) {
      if (fs.lstatSync(path.join(stage, file)).isSymbolicLink()) {
        throw new Error(`Staged symlink requires separate review: ${file}`);
      }
    }
    if (fs.existsSync(path.join(stage, 'scripts/addLicense.js'))) {
      command(stage, 'node', ['scripts/addLicense.js'], undefined, true);
    }
    const formattable = files.filter((file) => /\.(?:[cm]?[jt]sx?|json|css|scss)$/.test(file));
    if (formattable.length > 0) command(stage, tool(stage, 'oxfmt'), ['--write', '--', ...formattable]);
    command(stage, 'git', ['add', '--', ...files], undefined, true);
    command(stage, 'bun', [path.join(import.meta.dirname, 'quality-gate.ts'), '--staged'], undefined, true);
    if (command(root, 'git', ['write-tree']).trim() !== snapshot.tree) {
      throw new Error('Index changed during checks; retry the commit.');
    }
    const records: string[] = [];
    const updates: { file: string; content: Buffer }[] = [];
    for (const file of files) {
      const metadata = command(stage, 'git', ['ls-files', '--stage', '-z', '--', file], undefined, true);
      if (!metadata.startsWith('100')) throw new Error(`Unsupported staged file mode: ${file}`);
      const content = fs.readFileSync(path.join(stage, file));
      const original = command(root, 'git', ['show', `:${file}`]);
      const oid = command(root, 'git', ['hash-object', '-w', '--stdin'], content).trim();
      records.push(`${metadata.slice(0, 6)} ${oid}\t${file}\0`);
      if (fs.existsSync(path.join(root, file)) && fs.readFileSync(path.join(root, file), 'utf8') === original) {
        updates.push({ file, content });
      }
    }
    command(root, 'git', ['update-index', '-z', '--index-info'], records.join(''));
    for (const { file, content } of updates) fs.writeFileSync(path.join(root, file), content);
  }
  console.log('[pre-commit] Staged snapshot checks passed.');
} catch (error) {
  console.error(`[pre-commit] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (snapshot) fs.rmSync(snapshot.directory, { recursive: true, force: true });
}
