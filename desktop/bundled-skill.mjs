import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const name = 'feishu-codex';
export const managedSkillOwner = 'local.feishu-codex.desktop';
const hash = value => createHash('sha256').update(value).digest('hex');
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };

export function defaultCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

async function replaceFile(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(missing); }
}

// Only our one managed skill is updated. Codex's enable/disable configuration
// is untouched, and locally edited or unowned skills are never overwritten.
export async function installBundledSkill({ root, codexHome = defaultCodexHome() }) {
  const source = await fs.readFile(path.join(root, 'skills', name, 'SKILL.md'));
  const desiredHash = hash(source);
  const directory = path.join(path.resolve(codexHome), 'skills', name);
  const file = path.join(directory, 'SKILL.md');
  const markerFile = path.join(directory, '.feishu-codex-managed.json');
  const result = status => ({ status, path: file });
  const existing = await fs.lstat(directory).catch(missing);
  let fresh = false;
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) return result('conflict');
  if (!existing) {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    try { await fs.mkdir(directory); fresh = true; }
    catch (error) { if (error.code === 'EEXIST') return result('busy'); throw error; }
  }
  let currentHash;
  if (!fresh) {
    const markerInfo = await fs.lstat(markerFile).catch(missing);
    const fileInfo = await fs.lstat(file).catch(missing);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || !fileInfo?.isFile() || fileInfo.isSymbolicLink()) return result('conflict');
    let marker;
    try { marker = JSON.parse(await fs.readFile(markerFile, 'utf8')); } catch { return result('conflict'); }
    if (!marker || marker.owner !== managedSkillOwner || marker.schema !== 1 || typeof marker.sha256 !== 'string') return result('conflict');
    currentHash = hash(await fs.readFile(file));
    // Recover if a previous update replaced content before writing its marker.
    if (currentHash !== marker.sha256 && currentHash !== desiredHash) return result('modified');
    if (currentHash === desiredHash && marker.sha256 === desiredHash) return result('unchanged');
  }
  if (fresh) await fs.writeFile(file, source, { flag: 'wx' });
  else if (currentHash !== desiredHash) await replaceFile(file, source);
  await replaceFile(markerFile, JSON.stringify({ schema: 1, owner: managedSkillOwner, sha256: desiredHash }, null, 2));
  return result(fresh ? 'installed' : 'updated');
}

export async function removeBundledSkill({ codexHome = defaultCodexHome() } = {}) {
  const directory = path.join(path.resolve(codexHome), 'skills', name);
  const file = path.join(directory, 'SKILL.md');
  const markerFile = path.join(directory, '.feishu-codex-managed.json');
  const result = status => ({ status, path: directory });
  const existing = await fs.lstat(directory).catch(missing);
  if (!existing) return result('missing');
  if (!existing.isDirectory() || existing.isSymbolicLink()) return result('conflict');
  const entries = await fs.readdir(directory);
  if (entries.length !== 2 || !entries.includes('SKILL.md') || !entries.includes('.feishu-codex-managed.json')) return result('modified');
  const [skillInfo, markerInfo] = await Promise.all([fs.lstat(file).catch(missing), fs.lstat(markerFile).catch(missing)]);
  if (!skillInfo?.isFile() || skillInfo.isSymbolicLink() || !markerInfo?.isFile() || markerInfo.isSymbolicLink()) return result('conflict');
  let marker;
  try { marker = JSON.parse(await fs.readFile(markerFile, 'utf8')); } catch { return result('conflict'); }
  if (!marker || marker.owner !== managedSkillOwner || marker.schema !== 1 || !/^[a-f0-9]{64}$/.test(marker.sha256 || '')) return result('conflict');
  if (hash(await fs.readFile(file)) !== marker.sha256) return result('modified');
  await fs.unlink(file);
  await fs.unlink(markerFile);
  await fs.rmdir(directory);
  return result('removed');
}
