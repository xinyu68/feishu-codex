import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.desktop-package');
const product = path.join(stage, 'product');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上构建安装包。');
for (const file of ['build/server/server.js', 'build/ui/index.html', 'desktop/main.mjs', 'desktop/host.mjs']) {
  await fs.access(path.join(root, file));
}
if (path.dirname(product) !== path.join(root, '.desktop-package') || path.basename(product) !== 'product') throw new Error('安装包暂存目录无效。');
await fs.rm(product, { recursive: true, force: true });
await fs.mkdir(product, { recursive: true });
for (const folder of ['build/server', 'build/ui', 'desktop', 'scripts', 'skills']) {
  await fs.cp(path.join(root, folder), path.join(product, folder), {
    recursive: true,
    filter: (sourcePath) => !['scripts/takeover.ps1', 'scripts/rollback.ps1'].includes(path.relative(root, sourcePath).split(path.sep).join('/')),
  });
}
const source = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.copyFile(path.join(root, 'package.json'), path.join(product, 'package.json'));
await fs.copyFile(path.join(root, 'package-lock.json'), path.join(product, 'package-lock.json'));
for (const file of ['LICENSE', 'NOTICE.md', 'README.md']) await fs.copyFile(path.join(root, file), path.join(product, file));
await fs.cp(path.join(root, 'docs'), path.join(product, 'docs'), { recursive: true });
const env = {};
const names = new Set();
for (const [key, value] of Object.entries(process.env)) {
  if (names.has(key.toUpperCase()) || value === undefined) continue;
  names.add(key.toUpperCase()); env[key] = value;
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请通过 npm run package:prepare 构建。');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: product, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`运行依赖准备失败：${code}`)));
});
await fs.mkdir(path.join(stage, 'node'), { recursive: true });
const previousNodeVersion = await fs.readFile(path.join(stage, 'node', 'version.txt'), 'utf8').catch(() => '');
let nodeLicense = previousNodeVersion.trim() === process.version ? await fs.readFile(path.join(stage, 'node', 'LICENSE'), 'utf8').catch(() => '') : '';
if (!nodeLicense) {
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!license.ok) throw new Error('无法取得随安装包分发的 Node.js 许可证。');
  nodeLicense = await license.text();
}
await fs.copyFile(process.execPath, path.join(stage, 'node', 'node.exe'));
await fs.writeFile(path.join(stage, 'node', 'version.txt'), `${process.version}\n`);
await fs.writeFile(path.join(stage, 'node', 'LICENSE'), nodeLicense);
await fs.writeFile(path.join(product, 'build-info.json'), JSON.stringify({ version: source.version, builtAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch }, null, 2));
console.log('安装包运行文件已准备完毕（不包含用户配置、凭据或历史）。');
