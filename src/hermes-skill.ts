import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface HermesSkillOptions {
  /** Absolute, existing profile home supplied by the trusted local Dashboard. */
  hermesHome: string;
  /** Product root containing skills/feishu-codex-hermes/SKILL.md. */
  bundleRoot?: string;
  roleInstructions?: string;
}

export interface HermesSkillResult {
  status: 'installed' | 'updated' | 'unchanged';
  skillPath: string;
  /** Path relative to the installed Skill directory, never another role's reference. */
  roleReference?: string;
  roleHash?: string;
}

export class HermesSkillError extends Error {
  constructor(public readonly code: 'invalid-home' | 'conflict' | 'modified' | 'busy', message: string) {
    super(message);
    this.name = 'HermesSkillError';
  }
}

const owner = 'local.feishu-codex.hermes';
const markerName = '.feishu-codex-managed.json';
const installations = new Map<string, Promise<HermesSkillResult>>();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const stat = async (file: string) => fs.lstat(file).catch(error => { if (isCode(error, 'ENOENT')) return undefined; throw error; });

async function directoryIsSafe(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await directoryIsSafe(parent);
  const info = await stat(directory);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new HermesSkillError('conflict', 'Hermes Skill 路径必须是现有普通目录，不能经过符号链接或目录联接');
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await directoryIsSafe(path.dirname(directory));
  try { await fs.mkdir(directory); }
  catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  await directoryIsSafe(directory);
}

async function regularFile(file: string): Promise<Buffer> {
  await directoryIsSafe(path.dirname(file));
  const info = await stat(file);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new HermesSkillError('conflict', 'Hermes Skill 文件缺失或不是普通文件，已保留现有内容');
  }
  return fs.readFile(file);
}

async function defaultBundleRoot(): Promise<string> {
  for (const relative of ['../', '../../']) {
    const root = fileURLToPath(new URL(relative, import.meta.url));
    if (await stat(path.join(root, 'skills', 'feishu-codex-hermes', 'SKILL.md'))) return root;
  }
  throw new Error('缺少 Hermes 版 Feishu Codex Skill，请检查应用安装文件');
}

async function replaceFile(file: string, content: string | Buffer): Promise<void> {
  await directoryIsSafe(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    const existing = await stat(file);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new HermesSkillError('conflict', 'Hermes Skill 目标文件已变化，未覆盖');
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(error => { if (!isCode(error, 'ENOENT')) throw error; });
  }
}

async function ensureRole(directory: string, instructions: string): Promise<Pick<HermesSkillResult, 'roleReference' | 'roleHash'>> {
  const roleHash = digest(instructions);
  const roleReference = `references/roles/${roleHash}.md`;
  await ensureDirectory(path.join(directory, 'references'));
  await ensureDirectory(path.join(directory, 'references', 'roles'));
  const file = path.join(directory, roleReference);
  const verify = async () => {
    if (digest(await regularFile(file)) !== roleHash) {
      throw new HermesSkillError('modified', 'Hermes 角色引用已被修改，未覆盖也未用于本轮');
    }
  };
  if (await stat(file)) await verify();
  else {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, instructions, { flag: 'wx' });
      // A hard link publishes the complete file without replacing an existing reference.
      try { await fs.link(temporary, file); }
      catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
      await verify();
    } finally {
      await fs.unlink(temporary).catch(error => { if (!isCode(error, 'ENOENT')) throw error; });
    }
  }
  return { roleReference, roleHash };
}

async function install(options: HermesSkillOptions): Promise<HermesSkillResult> {
  await directoryIsSafe(options.hermesHome);
  const root = options.bundleRoot === undefined ? await defaultBundleRoot() : path.resolve(options.bundleRoot);
  const source = await regularFile(path.join(root, 'skills', 'feishu-codex-hermes', 'SKILL.md'));
  const desiredHash = digest(source);
  const skillsDirectory = path.join(options.hermesHome, 'skills');
  const directory = path.join(skillsDirectory, 'feishu-codex');
  const skillPath = path.join(directory, 'SKILL.md');
  const markerFile = path.join(directory, markerName);
  const marker = JSON.stringify({ schema: 1, owner, sha256: desiredHash }, null, 2) + '\n';
  const role = options.roleInstructions?.trim() ? options.roleInstructions : undefined;
  await ensureDirectory(skillsDirectory);
  const existing = await stat(directory);
  if (!existing) {
    const temporary = path.join(skillsDirectory, `.feishu-codex-${randomUUID()}.tmp`);
    await fs.mkdir(temporary);
    try {
      await fs.writeFile(path.join(temporary, 'SKILL.md'), source, { flag: 'wx' });
      await fs.writeFile(path.join(temporary, markerName), marker, { flag: 'wx' });
      const reference = role ? await ensureRole(temporary, role) : {};
      if (await stat(directory)) throw new HermesSkillError('busy', 'Hermes Skill 正由其他进程安装，请稍后重试');
      await fs.rename(temporary, directory);
      return { status: 'installed', skillPath, ...reference };
    } finally {
      // The generated sibling path is the only directory this module ever removes.
      if (path.dirname(temporary) !== skillsDirectory || !path.basename(temporary).startsWith('.feishu-codex-')) throw new Error('Invalid temporary Skill path');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  await directoryIsSafe(directory);
  let installedMarker: { schema?: unknown; owner?: unknown; sha256?: unknown };
  const markerBytes = await regularFile(markerFile);
  try { installedMarker = JSON.parse(markerBytes.toString('utf8')); }
  catch { throw new HermesSkillError('conflict', 'Hermes Skill 管理标记无效，未接管现有 Skill'); }
  if (!installedMarker || installedMarker.schema !== 1 || installedMarker.owner !== owner || typeof installedMarker.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(installedMarker.sha256)) {
    throw new HermesSkillError('conflict', 'Hermes Skill 不属于本应用，未接管现有 Skill');
  }
  const currentHash = digest(await regularFile(skillPath));
  // An interrupted update may have published the new Skill before its marker.
  if (currentHash !== installedMarker.sha256 && currentHash !== desiredHash) {
    throw new HermesSkillError('modified', 'Hermes Skill 已被本地修改，未覆盖现有内容');
  }
  const reference = role ? await ensureRole(directory, role) : {};
  const unchanged = currentHash === desiredHash && installedMarker.sha256 === desiredHash;
  if (currentHash !== desiredHash) await replaceFile(skillPath, source);
  if (!unchanged) await replaceFile(markerFile, marker);
  return { status: unchanged ? 'unchanged' : 'updated', skillPath, ...reference };
}

/** Installs only the managed Skill and immutable role references in the selected profile. */
export async function ensureHermesSkill(options: HermesSkillOptions): Promise<HermesSkillResult> {
  if (!options.hermesHome || !path.isAbsolute(options.hermesHome) || options.hermesHome.includes('\0')) {
    throw new HermesSkillError('invalid-home', 'Hermes Dashboard 未提供有效的本机 profile 绝对路径');
  }
  const hermesHome = path.resolve(options.hermesHome);
  const key = process.platform === 'win32' ? hermesHome.toLowerCase() : hermesHome;
  const previous = installations.get(key);
  const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => install({ ...options, hermesHome }));
  installations.set(key, operation);
  try { return await operation; }
  finally { if (installations.get(key) === operation) installations.delete(key); }
}
