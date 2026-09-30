import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isMap, parseDocument } from 'yaml';

const owner = 'local.feishu-codex.hermes';
const markerName = '.feishu-codex-managed.json';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; };
const info = (file: string) => fs.lstat(file).catch(missing);
const samePath = (a: string, b: string) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
type Status = 'removed' | 'missing' | 'preserved-modified' | 'preserved-unowned' | 'preserved-other-install' | 'preserved-unsafe-path';

// Check every ancestor, including a custom profile's parent. Never follow a
// junction or recursively delete an entire Hermes profile.
async function safeDirectory(directory: string): Promise<boolean> {
  const parent = path.dirname(directory);
  if (parent !== directory && !await safeDirectory(parent)) return false;
  const stat = await info(directory);
  return !!stat?.isDirectory() && !stat.isSymbolicLink();
}

async function regularFile(file: string): Promise<Buffer | undefined> {
  if (!await safeDirectory(path.dirname(file))) return undefined;
  const stat = await info(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
  return fs.readFile(file);
}

async function replaceChecked(file: string, previous: Buffer | undefined, next: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, next, { flag: 'wx', mode: 0o600 });
    const current = await regularFile(file);
    if (previous ? !current?.equals(previous) : await info(file)) throw new Error('Hermes 配置在清理期间发生变化，已停止操作，请关闭 Hermes 后重试。');
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(missing); }
}

let recording = Promise.resolve();
/** Remember custom profiles while connected; no runtime needs to be started at uninstall. */
export async function recordManagedHermesHome(dataDir: string, hermesHome: string): Promise<void> {
  if (!path.isAbsolute(hermesHome) || !await safeDirectory(hermesHome)) throw new Error('Hermes 配置目录无效，未记录卸载位置。');
  const operation = recording.catch(() => undefined).then(async () => {
    const directory = path.join(path.resolve(dataDir), 'desktop');
    await fs.mkdir(directory, { recursive: true });
    if (!await safeDirectory(directory)) throw new Error('Hermes 管理记录目录不安全。');
    const file = path.join(directory, 'managed-hermes-homes.json');
    const previous = await regularFile(file);
    const homes = previous ? parseHomes(previous) : [];
    if (homes.some(home => samePath(home, hermesHome))) return;
    homes.push(path.resolve(hermesHome));
    await replaceChecked(file, previous, JSON.stringify({ schema: 1, owner, homes }, null, 2) + '\n');
  });
  recording = operation;
  await operation;
}

function parseHomes(bytes: Buffer): string[] {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Hermes 管理记录损坏，未执行清理。'); }
  if (value?.schema !== 1 || value.owner !== owner || !Array.isArray(value.homes)
      || value.homes.some((home: unknown) => typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0'))) {
    throw new Error('Hermes 管理记录无效，未执行清理。');
  }
  return value.homes;
}

export async function managedHermesHomes({ dataDir, env = process.env, userHome = os.homedir() }: {
  dataDir: string; env?: NodeJS.ProcessEnv; userHome?: string;
}): Promise<string[]> {
  const saved = await regularFile(path.join(dataDir, 'desktop', 'managed-hermes-homes.json'));
  const homes = saved ? parseHomes(saved) : [];
  // Compatibility with releases that did not yet record the profile location.
  const roots = [env.HERMES_HOME, path.join(env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'hermes'), path.join(userHome, '.hermes')]
    .filter((value): value is string => !!value && path.isAbsolute(value));
  for (const root of roots) {
    homes.push(root);
    const profiles = path.join(root, 'profiles');
    if (await safeDirectory(profiles)) {
      for (const entry of await fs.readdir(profiles, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) homes.push(path.join(profiles, entry.name));
      }
    }
  }
  return homes.filter((home, index) => homes.findIndex(other => samePath(home, other)) === index);
}

async function removeMcp(hermesHome: string, productRoot: string): Promise<Status> {
  const file = path.join(hermesHome, 'config.yaml');
  if (!await info(file)) return 'missing';
  const previous = await regularFile(file);
  if (!previous) return 'preserved-unsafe-path';
  // Use the YAML AST to retain comments and avoid rewriting unrelated settings
  // through Hermes' API. Parser diagnostics may contain secrets; never expose them.
  let doc, config: Json;
  try {
    doc = parseDocument(previous.toString('utf8'));
    if (doc.errors.length || !isMap(doc.contents)) throw new Error();
    config = doc.toJS({ maxAliasCount: 100 });
  } catch { throw new Error('Hermes config.yaml 无法安全解析，未修改配置，请修复后重试卸载。'); }
  const servers = config.mcp_servers;
  if (!object(servers) || !Object.hasOwn(servers, 'feishu_completion')) return 'missing';
  const entry = servers.feishu_completion;
  if (!object(entry) || !object(entry.env) || entry.env.FEISHU_CODEX_MANAGED_MCP !== 'hermes-v1') return 'preserved-unowned';
  const script = Array.isArray(entry.args) && entry.args[0];
  if (typeof script !== 'string' || !path.isAbsolute(script)) return 'preserved-modified';
  if (!samePath(script, path.join(productRoot, 'build', 'server', 'notify-mcp.js'))) return 'preserved-other-install';
  const env = { ...entry.env };
  const fingerprint = env.FEISHU_CODEX_MANAGED_MCP_SHA256;
  delete env.FEISHU_CODEX_MANAGED_MCP_SHA256;
  if (env.FEISHU_CODEX_MCP_MODE !== 'hermes' || fingerprint !== sha(canonical({ ...entry, env }))) return 'preserved-modified';
  // Aliases/merges can share this entry with user configuration. Do not break them.
  const map = doc.get('mcp_servers', true);
  if (!isMap(map) || !isMap(map.get('feishu_completion', true))) return 'preserved-modified';
  doc.deleteIn(['mcp_servers', 'feishu_completion']);
  delete servers.feishu_completion;
  let next: string;
  try {
    next = doc.toString();
    const parsed = parseDocument(next);
    if (parsed.errors.length || canonical(parsed.toJS({ maxAliasCount: 100 })) !== canonical(config)) return 'preserved-modified';
  } catch { return 'preserved-modified'; }
  // Protect user writes between inspection and atomic replacement.
  await replaceChecked(file, previous, next);
  return 'removed';
}

async function removeSkill(hermesHome: string): Promise<Status> {
  const directory = path.join(hermesHome, 'skills', 'feishu-codex');
  if (!await info(directory)) return 'missing';
  if (!await safeDirectory(directory)) return 'preserved-unsafe-path';
  const marker = await regularFile(path.join(directory, markerName));
  let owned;
  try { owned = marker && JSON.parse(marker.toString('utf8')); } catch { return 'preserved-unowned'; }
  if (owned?.schema !== 1 || owned.owner !== owner || !/^[a-f0-9]{64}$/.test(owned.sha256)) return 'preserved-unowned';
  const files = new Map<string, Buffer>();
  const directories: string[] = [];
  const inspect = async (folder: string): Promise<boolean> => {
    if (!await safeDirectory(folder)) return false;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const relative = path.relative(directory, file).split(path.sep).join('/');
      if (entry.isDirectory() && ['references', 'references/roles'].includes(relative)) {
        if (!await inspect(file)) return false;
      } else {
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        const content = await regularFile(file);
        if (!content) return false;
        if (relative === 'SKILL.md') { if (sha(content) !== owned.sha256) return false; }
        else if (relative === markerName) { if (!content.equals(marker!)) return false; }
        else {
          const match = /^references\/roles\/([a-f0-9]{64})\.md$/.exec(relative);
          if (!match || sha(content) !== match[1]) return false;
        }
        files.set(file, content);
      }
    }
    directories.push(folder);
    return true;
  };
  if (!await inspect(directory) || !files.has(path.join(directory, 'SKILL.md'))) return 'preserved-modified';
  for (const [file, content] of files) {
    if (!(await regularFile(file))?.equals(content)) throw new Error('Hermes Skill 在清理期间发生变化，已停止操作。');
  }
  // No recursive deletion: personal files added after inspection survive.
  for (const file of files.keys()) await fs.unlink(file);
  for (const folder of directories) {
    await fs.rmdir(folder).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
  return 'removed';
}

export async function removeHermesIntegrations({ productRoot, dataDir, homes }: {
  productRoot: string; dataDir: string; homes?: string[];
}): Promise<{ home: string; mcp: Status; skill: Status }[]> {
  if (!path.isAbsolute(productRoot)) throw new Error('卸载程序目录无效。');
  const results = [];
  for (const home of homes ?? await managedHermesHomes({ dataDir })) {
    if (path.isAbsolute(home) && !await info(home)) {
      results.push({ home, mcp: 'missing' as const, skill: 'missing' as const });
      continue;
    }
    if (!path.isAbsolute(home) || !await safeDirectory(home)) {
      results.push({ home, mcp: 'preserved-unsafe-path' as const, skill: 'preserved-unsafe-path' as const });
      continue;
    }
    const mcp = await removeMcp(home, productRoot);
    // Another installation may still rely on the shared Skill in this profile.
    const skill = mcp === 'preserved-other-install' ? mcp : await removeSkill(home);
    results.push({ home, mcp, skill });
  }
  return results;
}
