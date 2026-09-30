import { randomBytes } from 'node:crypto';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const directory = resolve(import.meta.dir, '../storage/oa-demo');
const envPath = resolve(directory, 'runtime.env');
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  await access(envPath);
} catch {
  const secret = () => randomBytes(32).toString('hex');
  await writeFile(envPath, `OA_DB_PASSWORD=${secret()}\nOA_APP_KEY=${secret()}\nOA_ADMIN_PASSWORD=${secret()}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}
const command = process.argv[2] ?? 'up';
if (!['up', 'stop', 'status'].includes(command)) throw new Error('Use up, stop, or status');
const args = command === 'up' ? ['up', '-d'] : command === 'stop' ? ['stop'] : ['ps'];
const child = spawn(
  'docker',
  ['compose', '--env-file', envPath, '-f', resolve(import.meta.dir, '../docker/oa-demo/compose.yaml'), ...args],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
  if (code === 0) console.log(`OA runtime: http://localhost:13000 | Credentials: ${envPath}`);
});
