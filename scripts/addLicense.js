const fs = require('fs/promises');
const { execFileSync } = require('child_process');
const path = require('path');

const commercialLicense = `
/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This program is offered under a commercial license.
 * For more information, see <https://www.nocobase.com/agreement>
 */
`.trim();
const openSourceLicense = `
/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */
`.trim();

function getLicenseText(packageDir) {
  return packageDir.includes('/pro-plugins') ? commercialLicense : openSourceLicense;
}

async function addLicenseToFile(filePath) {
  const licenseText = getLicenseText(path.resolve(filePath));

  const data = await fs.readFile(filePath, 'utf8');

  if (data.startsWith(licenseText)) return false;
  if (data.startsWith(commercialLicense) || data.startsWith(openSourceLicense)) return false;

  // 添加授权信息到文件内容的顶部
  const newData = licenseText + '\n\n' + data;

  // 将修改后的内容写回文件
  await fs.writeFile(filePath, newData, 'utf8');

  return true;
}

async function main() {
  const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => file.includes('/src/')) // 只检查 src 目录下的文件
    .filter((file) => !file.includes('/demos/')) // 忽略 demos 目录
    .filter((file) => file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx'));

  for (const file of files) await addLicenseToFile(file);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
