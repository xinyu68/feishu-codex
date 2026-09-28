import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = data => createHash('sha256').update(data).digest('hex');

export async function verifyDependencyTree(expected, actual) {
  let count = 0;
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(expected, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error(`运行依赖包含未处理的链接：${file}`);
      const source = await fs.readFile(path.join(expected, file));
      const packaged = await fs.readFile(path.join(actual, file)).catch(() => null);
      if (!packaged) throw new Error(`安装包缺少运行依赖：${file}`);
      if (digest(source) !== digest(packaged)) throw new Error(`安装包运行依赖内容不完整：${file}`);
      count++;
    }
  }
  await walk();
  if (!count) throw new Error('生产依赖目录为空，拒绝生成安装包。');
  return count;
}

export async function verifyDesktopPackage(resources) {
  const product = path.join(resources, 'product');
  const skill = 'skills/feishu-codex/SKILL.md';
  if (digest(await fs.readFile(path.join(sourceRoot, skill))) !== digest(await fs.readFile(path.join(product, skill)))) throw new Error('安装包内置 Skill 缺失或不完整。');
  const expected = path.join(sourceRoot, '.desktop-package', 'product', 'node_modules');
  const dependencyFiles = await verifyDependencyTree(expected, path.join(product, 'node_modules'));
  const node = path.join(resources, 'node', 'node.exe');
  // Imports initialize modules only; they do not start any runtime or bot.
  // File comparison above prevents development-directory fallback from masking
  // missing transitive dependencies in an unpacked build under the repository.
  const code = `import path from 'node:path'; import { pathToFileURL } from 'node:url';
    for (const entry of ['desktop/host.mjs', 'build/server/server.js'])
      await import(pathToFileURL(path.join(process.argv[1], entry)).href);
    console.log('packaged runtime imports passed');`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(node, ['--input-type=module', '--eval', code, product], {
      cwd: product, windowsHide: true,
      env: canonicalEnvironment(process.env, { ELECTRON_RUN_AS_NODE: null }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let result = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('安装包运行依赖加载超时。')); }, 20_000);
    child.stdout.on('data', data => { result = (result + data).slice(-8000); });
    child.stderr.on('data', data => { result = (result + data).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`安装包后台无法加载（${code}）：${result}`));
      else resolve(result.trim());
    });
  });
  return { passed: true, resources, dependencyFiles, output, checkedAt: new Date().toISOString() };
}

export default async function afterPack(context) {
  const report = await verifyDesktopPackage(path.join(context.appOutDir, 'resources'));
  await fs.mkdir(path.join(sourceRoot, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'artifacts', 'desktop-package-dependencies.json'), JSON.stringify(report, null, 2));
  console.log(`安装包依赖完整性及后台加载通过（${report.dependencyFiles} 个文件）。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyDesktopPackage(path.resolve(process.argv[2]));
  console.log(JSON.stringify(report, null, 2));
}
