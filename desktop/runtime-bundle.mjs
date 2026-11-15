import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson, readJson } from './windows.mjs';

const owner = 'local.feishu-codex.runtime';
const required = ['codex.exe', 'codex-code-mode-host.exe'];
const optional = ['codex-command-runner.exe', 'rg.exe'];
const allowed = new Set([...required, ...optional]);
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = info => `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
async function digest(file) {
  const sum = createHash('sha256');
  for await (const chunk of createReadStream(file)) sum.update(chunk);
  return sum.digest('hex');
}
async function executable(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2) throw new Error('运行文件不完整');
  const handle = await fs.open(file, 'r');
  try { const bytes = Buffer.alloc(2); await handle.read(bytes, 0, 2, 0); if (bytes.toString('ascii') !== 'MZ') throw new Error('运行文件格式无效'); }
  finally { await handle.close(); }
  return info;
}

export class RuntimeBundles {
  constructor(dataDir, { copyFile = fs.copyFile } = {}) {
    this.base = path.resolve(dataDir, 'desktop', 'codex-runtimes'); this.copyFile = copyFile;
    this.memo = new Map(); this.pending = new Map();
  }
  async prepare(sourcePath) {
    if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('未找到 Codex 运行文件，请先安装官方 Codex。');
    const source = path.resolve(sourcePath), files = [];
    try {
      for (const name of [...required, ...optional]) {
        try { files.push({ name, stamp: fingerprint(await executable(name === 'codex.exe' ? source : path.join(path.dirname(source), name))) }); }
        catch (error) { if (!required.includes(name) && error.code === 'ENOENT') continue; throw error; }
      }
    } catch (cause) { throw new Error('Codex 运行文件尚未准备完整，准备完成后将自动连接。', { cause }); }
    const signature = hash(JSON.stringify({ source: source.toLowerCase(), files }));
    if (this.pending.has(signature)) return this.pending.get(signature);
    const operation = this.materialize(source, files, signature).finally(() => this.pending.delete(signature));
    this.pending.set(signature, operation); return operation;
  }
  async materialize(sourcePath, files, signature) {
    await fs.mkdir(this.base, { recursive: true });
    const indexFile = path.join(this.base, signature + '.json');
    const index = await readJson(indexFile).catch(() => null);
    if (index?.owner === owner && new RegExp(`^${signature}-[0-9a-f-]{36}$`).test(index.folder)) {
      const directory = path.join(this.base, index.folder);
      try {
        const folder = await fs.lstat(directory);
        if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('Invalid runtime folder');
        const manifest = await readJson(path.join(directory, 'manifest.json'));
        if (manifest?.owner !== owner || manifest.signature !== signature || !Array.isArray(manifest.files)
          || manifest.files.length !== files.length || !files.every(item => manifest.files.some(saved => saved.name === item.name))) throw Error('Invalid runtime manifest');
        const stamps = [];
        for (const item of manifest.files) {
          if (!allowed.has(item.name)) throw Error('Invalid runtime file');
          stamps.push(fingerprint(await executable(path.join(directory, item.name))));
        }
        const remembered = this.memo.get(signature);
        if (!remembered || remembered.directory !== directory || JSON.stringify(remembered.stamps) !== JSON.stringify(stamps)) {
          for (const item of manifest.files) if (await digest(path.join(directory, item.name)) !== item.sha256) throw Error('Runtime checksum mismatch');
        }
        const result = { exe: path.join(directory, 'codex.exe'), sourcePath, directory, signature };
        this.memo.set(signature, { ...result, stamps }); return result;
      } catch { /* Publish a new immutable directory; never overwrite a running binary. */ }
    }
    const directory = path.join(this.base, `${signature}-${randomUUID()}`);
    await fs.mkdir(directory);
    const manifest = { owner, schema: 1, sourcePath, signature, files: [] };
    try {
      for (const item of files) {
        const input = item.name === 'codex.exe' ? sourcePath : path.join(path.dirname(sourcePath), item.name), output = path.join(directory, item.name);
        await this.copyFile(input, output);
        const [original, copied] = await Promise.all([digest(input), digest(output)]);
        if (original !== copied || fingerprint(await executable(input)) !== item.stamp) throw Error('Codex 运行文件正在变化，将在稳定后重试。');
        manifest.files.push({ name: item.name, sha256: copied });
      }
      // Publish only after the entire tool set has been copied and checked.
      for (const item of files) if (fingerprint(await executable(item.name === 'codex.exe' ? sourcePath : path.join(path.dirname(sourcePath), item.name))) !== item.stamp) throw Error('Codex 运行文件正在变化，将在稳定后重试。');
      await atomicJson(path.join(directory, 'manifest.json'), manifest);
      await atomicJson(indexFile, { owner, schema: 1, folder: path.basename(directory) });
      return { exe: path.join(directory, 'codex.exe'), sourcePath, directory, signature };
    } catch (error) {
      await this.removeDirectory(directory); throw error;
    }
  }
  async removeDirectory(directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.base || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(path.basename(resolved))) throw Error('Unsafe runtime cleanup path');
    const info = await fs.lstat(resolved).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      const base = await fs.realpath(this.base), target = await fs.realpath(resolved);
      if (path.dirname(target) !== base) throw Error('Unsafe resolved runtime cleanup path');
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  async prune(activePaths, keep = 2) {
    const entries = await fs.readdir(this.base, { withFileTypes: true }).catch(() => []), candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.base, entry.name), manifest = await readJson(path.join(directory, 'manifest.json')).catch(() => null);
      if (manifest?.owner !== owner) continue;
      const active = activePaths.some(file => file && path.dirname(path.resolve(file)).toLowerCase() === directory.toLowerCase());
      candidates.push({ directory, active, at: (await fs.stat(directory)).mtimeMs });
    }
    candidates.sort((a, b) => b.at - a.at);
    for (const candidate of candidates.slice(keep)) if (!candidate.active) await this.removeDirectory(candidate.directory).catch(() => {});
  }
}
