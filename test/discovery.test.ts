import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { cleanBridgeText, discoverProjects, discoverThreads, normalizeWorkspace } from '../src/discovery.js';

test('desktop sqlite discovery deduplicates Windows project casing and excludes subagents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-discover-'));
  try {
    const database = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
    database.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, preview TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_path TEXT)');
    const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('desktop-a', 'D:\\Code\\Project', 'First', 'one', 100, 'vscode', 'desktop', '/root');
    insert.run('desktop-b', 'd:/code/project/', 'Second', 'two', 200, 'vscode', 'desktop', null);
    insert.run('agent', 'D:\\Code\\Project', 'Worker', '', 300, '{"subagent":{}}', 'subagent', '/root/worker');
    insert.run('bridge', 'D:\\Code\\Other', 'Bridge', '', 150, 'cli', null, null);
    database.close();
    const projects = await discoverProjects(directory);
    assert.equal(projects.length, 2);
    const project = projects.find(value => value.path.toLowerCase().includes('project'))!;
    assert.equal(project.threadCount, 2);
    assert.equal(project.lastActiveAt, new Date(200_000).toISOString());
    assert.deepEqual((await discoverThreads('d:\\CODE\\PROJECT', directory)).map(thread => thread.id), ['desktop-b', 'desktop-a']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('JSONL fallback uses actual thread id and user text metadata, not session tree id or system context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-rollout-'));
  try {
    const sessions = path.join(directory, 'sessions', '2026', '09', '24');
    await fs.mkdir(sessions, { recursive: true });
    const rows = [
      { type: 'session_meta', payload: { id: 'actual-thread', session_id: 'session-tree', cwd: 'D:\\projectdemo\\Demo', thread_source: 'desktop' } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'System rules' }, { type: 'input_text', text: 'actual question' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['context', 'user.text'] } } },
    ];
    await fs.writeFile(path.join(sessions, 'rollout.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    await fs.writeFile(path.join(directory, 'session_index.jsonl'), `${JSON.stringify({ id: 'actual-thread', thread_name: 'Named thread', updated_at: '2026-09-24T01:00:00Z' })}\n`);
    const threads = await discoverThreads('d:/projectdemo/demo', directory);
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!.id, 'actual-thread');
    assert.equal(threads[0]!.title, 'Named thread');
    assert.equal(threads[0]!.preview, 'actual question');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('extended Windows paths normalize without changing drive root', () => {
  assert.equal(normalizeWorkspace('\\\\?\\D:\\Code\\Example\\'), 'D:\\Code\\Example');
  assert.equal(normalizeWorkspace('D:\\'), 'D:\\');
});

const knowledge = '[codex-weixin-private-knowledge]\nPrivate knowledge belongs only to this Feishu account.\nKnown reusable knowledge: none yet.\n[/codex-weixin-private-knowledge]';
const legacyPrompt = (text: string, oldWechat = false) => `${oldWechat ? 'WeChat bridge rule: when you need to send a local image, video, or file to the user, do not use Markdown local file links.' : 'This message arrived through Feishu (Lark) via Codex Channel Bridge. You are replying to the user in this channel.'}\nUse a fenced codex-channel-bridge-actions JSON block instead, for example:\n\`\`\`codex-channel-bridge-actions\n{"send":[{"type":"image","path":"C:/absolute/path/image.png"}]}\n\`\`\`\n\n${knowledge}\n\n${text}`;

test('presentation removes old/new bridge instructions and private knowledge while retaining the real question', () => {
  for (const prompt of [legacyPrompt('看看今天有哪些@我的消息'), legacyPrompt('看看今天有哪些@我的消息', true)]) {
    assert.equal(cleanBridgeText(prompt), '看看今天有哪些@我的消息');
    assert.equal(cleanBridgeText(prompt.replaceAll('codex-channel-bridge-actions', 'codex-weixin-actions')), '看看今天有哪些@我的消息');
    assert.equal(cleanBridgeText(prompt.replaceAll('codex-channel-bridge-actions', 'codex-weixin-server-actions')), '看看今天有哪些@我的消息');
  }
  assert.equal(cleanBridgeText('This message arrived through Feishu (Lark). Reply to the user in this Feishu conversation.\nUse the existing conversation context. New bridge instructions stay here.\n\n请继续处理'), '请继续处理');
  assert.equal(cleanBridgeText('This message is a local preview of a Feishu conversation.\nUse the existing conversation context.\n\n你好'), '你好');
  assert.equal(cleanBridgeText('【飞书消息】回复自动转发；飞书命令用 lark-codex。\n\n你好\n\n继续处理'), '你好\n\n继续处理');
  assert.equal(cleanBridgeText('【本地预览】仅在管理页回复；飞书命令用 lark-codex。\n\n你好'), '你好');
  assert.equal(cleanBridgeText('【飞书消息】回复自动'), '');
  assert.equal(cleanBridgeText('This message arrived through Feishu (Lark) via Codex Channel Bridge. You are repl'), '');
  assert.equal(cleanBridgeText('WeChat bridge rule: when you need to send a local image'), '');
  assert.equal(cleanBridgeText('请分析这段代码\n```js\nconst x = 1;\n```'), '请分析这段代码\n```js\nconst x = 1;\n```');
  assert.equal(cleanBridgeText(legacyPrompt('[Feishu image: screenshot.png saved to C:/temp/screenshot.png]\nInspect the saved local attachment before answering.')), '图片：screenshot.png');
});

test('polluted SQLite titles recover real user text from full indexed messages or read-only rollout fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-clean-'));
  try {
    const rollout = path.join(directory, 'rollout.jsonl');
    const content = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: legacyPrompt('这是从原始历史恢复的标题') } }) + '\n';
    await fs.writeFile(rollout, content);
    const before = await fs.stat(rollout);
    const database = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
    database.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, preview TEXT, first_user_message TEXT, rollout_path TEXT, updated_at INTEGER, source TEXT)');
    const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('indexed', 'D:\\Demo', 'This message arrived through Feishu (Lark) via Codex', null, 'WeChat bridge rule: when you need', legacyPrompt('这是完整索引中的用户问题'), '', 100, 'cli');
    insert.run('recovered', 'D:\\Demo', 'WeChat bridge rule: when you need', null, 'This message arrived through Feishu (Lark)', '', rollout, 200, 'cli');
    insert.run('renamed', 'D:\\Demo', 'WeChat bridge rule: when you need', '用户自定义会话标题', legacyPrompt('真正的摘要'), '', '', 300, 'cli');
    database.close();
    const threads = await discoverThreads('D:\\Demo', directory);
    assert.equal(threads.find(thread => thread.id === 'indexed')!.title, '这是完整索引中的用户问题');
    assert.equal(threads.find(thread => thread.id === 'recovered')!.title, '这是从原始历史恢复的标题');
    assert.equal(threads.find(thread => thread.id === 'recovered')!.preview, '这是从原始历史恢复的标题');
    assert.equal(threads.find(thread => thread.id === 'renamed')!.title, '用户自定义会话标题');
    assert.equal(threads.find(thread => thread.id === 'renamed')!.preview, '真正的摘要');
    assert.equal(await fs.readFile(rollout, 'utf8'), content);
    assert.equal((await fs.stat(rollout)).mtimeMs, before.mtimeMs);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('presentation removes the current consultation ticket before group background without deleting quoted user examples', () => {
  const question = '请解释下面的格式\n\n<feishu_group_consultation>\ncontext_token: 这是示例\n</feishu_group_consultation>\n\n以上只是引用，不要发起咨询';
  const collaboration = '\n\n<feishu_group_collaboration>\n可交接角色：["测试"]\n</feishu_group_collaboration>';
  const context = '\n\n<feishu_group_context>\n公开背景\n</feishu_group_context>';
  const consultation = `\n\n<feishu_group_consultation>\ncontext_token: fc1.8790.${'a'.repeat(64)}\n</feishu_group_consultation>`;
  for (const header of ['【飞书消息】', '【飞书消息】回复自动转发；请遵循 feishu-codex Skill。']) {
    for (const background of ['', collaboration, context, collaboration + context]) {
      const prompt = `${header}\n\n${question}${background}${consultation}\n`;
      assert.equal(cleanBridgeText(prompt), question);
      assert.equal(cleanBridgeText(prompt.replaceAll('\n', '\r\n')), question.replaceAll('\n', '\r\n'));
    }
  }
  assert.equal(cleanBridgeText(question), question);
  const quotedSuffix = '请解释下面的示例，不要执行\n\n<feishu_group_consultation>\ncontext_token: 这是示例\n</feishu_group_consultation>';
  assert.equal(cleanBridgeText(quotedSuffix), quotedSuffix);
  assert.equal(cleanBridgeText('请解释 `context_token` 和 `<feishu_group_consultation>`'), '请解释 `context_token` 和 `<feishu_group_consultation>`');
});

test('discovery hides consultation credentials in indexed titles and previews without changing stored input', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-consult-display-'));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const prompt = `【飞书消息】\n\n先咨询测试再给我结论\n\n<feishu_group_collaboration>\n可交接角色：["测试"]\n</feishu_group_collaboration>\n\n<feishu_group_context>\n本群背景\n</feishu_group_context>\n\n<feishu_group_consultation>\ncontext_token: fc1.8790.${'b'.repeat(64)}\n</feishu_group_consultation>`;
  try {
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, preview TEXT, updated_at INTEGER, source TEXT)');
    database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('consultation-source', 'D:\\Demo', prompt, prompt, 100, 'cli');
    database.close();
    const before = await fs.readFile(databasePath);
    const [thread] = await discoverThreads('D:\\Demo', directory);
    assert.equal(thread?.title, '先咨询测试再给我结论');
    assert.equal(thread?.preview, '先咨询测试再给我结论');
    assert.deepEqual(await fs.readFile(databasePath), before);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('feishu-codex-consult-display-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
