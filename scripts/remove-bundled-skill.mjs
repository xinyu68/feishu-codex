import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCodexHome, managedSkillOwner, removeBundledSkill } from '../desktop/bundled-skill.mjs';

const args = process.argv.slice(2);
const includeHermes = args.length === 1 && args[0] === '--include-hermes';
if (includeHermes) args.length = 0;
if (args.length && (args.length !== 2 || args[0] !== '--codex-home' || !path.isAbsolute(args[1]))) {
  throw new Error('Usage: remove-bundled-skill.mjs [--include-hermes | --codex-home <absolute path>]');
}

const homes = new Set(args.length ? [path.resolve(args[1])] : [defaultCodexHome()]);
if (!args.length) {
  const dataDir = path.resolve(process.env.FEISHU_CODEX_DATA_DIR || path.join(os.homedir(), '.feishu-codex'));
  const locationFile = path.join(dataDir, 'desktop', 'managed-skill-home.json');
  try {
    const saved = JSON.parse(await fs.readFile(locationFile, 'utf8'));
    if (saved?.schema === 1 && saved.owner === managedSkillOwner && typeof saved.codexHome === 'string' && path.isAbsolute(saved.codexHome)) {
      homes.add(path.resolve(saved.codexHome));
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

const results = [];
if (includeHermes) {
  const { removeHermesIntegrations } = await import('../build/server/hermes-cleanup.js');
  const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(process.env.FEISHU_CODEX_DATA_DIR || path.join(os.homedir(), '.feishu-codex'));
  results.push(...await removeHermesIntegrations({ productRoot, dataDir }));
}
for (const codexHome of homes) results.push(await removeBundledSkill({ codexHome }));
process.stdout.write(`${JSON.stringify(results)}\n`);
