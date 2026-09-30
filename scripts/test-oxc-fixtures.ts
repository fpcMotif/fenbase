import { spawnSync } from 'node:child_process';

interface RuleTest {
  name: string;
  file: string;
  expectedRule: string;
  shouldPass: boolean;
  typeAware?: boolean;
}

const tests: RuleTest[] = [
  {
    name: 'good fixture passes cleanly',
    file: 'test/fixtures/oxc/good.tsx',
    expectedRule: '',
    shouldPass: true,
  },
  {
    name: 'bad any triggers typescript/no-explicit-any',
    file: 'test/fixtures/oxc/bad-any.ts',
    expectedRule: 'no-explicit-any',
    shouldPass: false,
  },
  {
    name: 'bad void triggers no-void',
    file: 'test/fixtures/oxc/bad-void.ts',
    expectedRule: 'no-void',
    shouldPass: false,
  },
  {
    name: 'bad react hook triggers react/rules-of-hooks',
    file: 'test/fixtures/oxc/bad-react-hook.tsx',
    expectedRule: 'rules-of-hooks',
    shouldPass: false,
  },
  {
    name: 'bad floating promise triggers typescript/no-floating-promises (type-aware)',
    file: 'test/fixtures/oxc/bad-floating-promise.ts',
    expectedRule: 'no-floating-promises',
    shouldPass: false,
    typeAware: true,
  },
];

console.log('Running Oxlint Rule Fixture Tests...\n');
let passed = 0;
let failed = 0;

for (const t of tests) {
  const args = [
    'oxlint',
    '-c',
    'test/fixtures/oxc/.oxlintrc.json',
    '--deny-warnings',
    '-D',
    'typescript/no-explicit-any',
    '-D',
    'no-void',
    '-D',
    'react/rules-of-hooks',
    '-D',
    'typescript/no-floating-promises',
  ];

  if (t.typeAware) {
    args.push('--type-aware');
  }

  args.push(t.file);

  const res = spawnSync('bunx', args, { encoding: 'utf8' });
  const output = (res.stdout || '') + (res.stderr || '');

  if (t.shouldPass) {
    if (res.status === 0) {
      console.log(`\x1b[32m✔\x1b[0m ${t.name}`);
      passed += 1;
    } else {
      console.error(`\x1b[31m✖\x1b[0m ${t.name}: expected exit 0, got ${res.status}`);
      console.error(output);
      failed += 1;
    }
  } else {
    const hasRule = output.includes(t.expectedRule);
    if (res.status !== 0 && hasRule) {
      console.log(`\x1b[32m✔\x1b[0m ${t.name} (tripped: ${t.expectedRule})`);
      passed += 1;
    } else {
      console.error(
        `\x1b[31m✖\x1b[0m ${t.name}: expected exit != 0 and output containing '${t.expectedRule}', got exit ${res.status}`,
      );
      console.error(output);
      failed += 1;
    }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
