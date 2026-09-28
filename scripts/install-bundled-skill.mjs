import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBundledSkill } from '../desktop/bundled-skill.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--codex-home' || !path.isAbsolute(args[1]))) throw new Error('Usage: install-bundled-skill.mjs [--codex-home <absolute path>]');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
console.log(JSON.stringify(await installBundledSkill({ root, ...(args.length ? { codexHome: args[1] } : {}) })));
