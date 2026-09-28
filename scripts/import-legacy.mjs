import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const source = process.argv[2] || path.join(os.homedir(), '.codex-channel-bridge');
const target = process.env.FEISHU_CODEX_DATA_DIR || path.join(os.homedir(), '.feishu-codex');
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const accounts = fs.readdirSync(path.join(source, 'accounts')).filter(file => file.endsWith('.json')).map(file => parse(path.join(source, 'accounts', file))).filter(account => account.channel === 'feishu');
if (accounts.length !== 1) throw new Error('Expected exactly one Feishu account; select the source account manually.');
if (fs.existsSync(path.join(target, 'config.json')) || fs.existsSync(path.join(target, 'state.json'))) throw new Error('Target already contains configuration. Import never overwrites existing data.');
const account = accounts[0];
const old = parse(path.join(source, 'runtime', account.accountId, 'state.json'));
const conversations = {};
const allowedActors = [...new Set([...(old.pairedSenderIds || []), ...Object.keys(old.authorizedConversationsByActor || {})])].filter(id => id.startsWith('ou_'));
for (const actorId of allowedActors) {
  const chatId = old.authorizedConversationsByActor?.[actorId] || actorId;
  const session = old.sessions.find(item => item.id === (old.activeSessionIds?.[chatId] || old.activeSessionIds?.[actorId]));
  const project = old.projects.find(item => item.id === (old.activeProjectIds?.[chatId] || old.activeProjectIds?.[actorId]));
  const cwd = project?.workspace || session?.workspace || process.cwd();
  const sameProject = session && (!project || session.projectId === project.id);
  conversations[chatId] = { chatId, actorId, title: '飞书对话', cwd,
    ...(sameProject && session.threadId ? { threadId: session.threadId } : {}),
    updatedAt: session?.updatedAt || new Date().toISOString(), preview: session?.lastPromptPreview || '' };
}
const config = { appId: account.appId, appSecret: account.appSecret, enabled: false,
  allowedActors, defaultWorkspace: Object.values(conversations)[0]?.cwd || process.cwd(), model: '', effort: '', progress: true };
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify({ version: 1, conversations, history: {}, pendingActors: [], seen: {}, logs: [], totalTurns: 0, dailyMessages: {} }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Imported ${allowedActors.length} authorized actor(s), ${Object.keys(conversations).length} conversation(s). Receiver is OFF until cutover; no secrets printed.`);
