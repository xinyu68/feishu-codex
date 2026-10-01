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
  const installerHelpers = await verifyInstallerHelpers();
  const product = path.join(resources, 'product');
  const skill = 'skills/feishu-codex/SKILL.md';
  if (digest(await fs.readFile(path.join(sourceRoot, skill))) !== digest(await fs.readFile(path.join(product, skill)))) throw new Error('安装包内置 Skill 缺失或不完整。');
  const hermesLauncher = 'scripts/hermes-runtime.py';
  if (digest(await fs.readFile(path.join(sourceRoot, hermesLauncher))) !== digest(await fs.readFile(path.join(product, hermesLauncher)))) throw new Error('安装包 Hermes 启动组件缺失或不完整。');
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
  return { passed: true, resources, dependencyFiles, installerHelpers, output, checkedAt: new Date().toISOString() };
}

export async function verifyInstallerHelpers(projectRoot = sourceRoot) {
  const manifest = await fs.readFile(path.join(projectRoot, 'scripts/nsis-uninstall.nsh'), 'utf8');
  const scripts = new Map();
  for (const match of manifest.matchAll(/File\s+\/oname=\$PLUGINSDIR\\([\w.-]+\.ps1)\s+"\$\{PROJECT_DIR\}\\([^"]+)"/g)) {
    const [, name, relative] = match;
    if (scripts.has(name)) throw new Error(`安装检查重复嵌入脚本：${name}`);
    const file = path.resolve(projectRoot, ...relative.split('\\'));
    if (!file.startsWith(path.resolve(projectRoot) + path.sep)) throw new Error(`安装检查脚本路径无效：${name}`);
    scripts.set(name, { name, relative: relative.replaceAll('\\', '/'), contents: await fs.readFile(file, 'utf8') });
  }
  if (!scripts.has('desktop-uninstall.ps1')) throw new Error('安装包未嵌入安装检查入口。');
  for (const script of scripts.values()) {
    for (const match of script.contents.matchAll(/^\s*\.\s*\(Join-Path\s+\$PSScriptRoot\s+'([^']+)'\)/gm)) {
      if (!scripts.has(match[1])) throw new Error(`安装检查缺少内嵌脚本：${match[1]}（${script.name}）`);
    }
  }
  return [...scripts.values()].map(({ name, relative }) => ({ name, relative }));
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
