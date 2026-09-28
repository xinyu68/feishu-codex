'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  alert: '<path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  command: '<path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 8-8L22 6l-3 3-2-2"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  messages: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.messages}</svg>`; }
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function time(value, full = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', full ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false} : {hour:'2-digit',minute:'2-digit',hour12:false});
}
function relative(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return '尚未开始';
  if (elapsed < 60000) return '刚刚';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return time(value, true);
}
function basename(path) { return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未选择项目'; }
function sessionLabel(c) { return c?.threadId ? `会话 ${c.threadId.slice(0, 8)}` : '等待第一条消息'; }
function empty(title, description, symbol = 'messages') { return `<div class="empty-state"><div class="empty-symbol">${icon(symbol)}</div><strong>${esc(title)}</strong><p>${esc(description)}</p></div>`; }
function loading(text = '正在读取…') { return `<div class="loading-state"><span class="spinner"></span>${esc(text)}</div>`; }
function setText(selector, value) { const el = $(selector); if (el.textContent !== String(value)) el.textContent = value; }

let state = null;
let settingsLoaded = false;
let settingsDirty = false;
let settingsConfigSignature = '';
let models = [];
let modelsLoaded = false;
let stateRequest = null;
let logLevel = 'all';
let historyChat = null;
let historyPreview = false;
let historyBinding = '';
let historySignature = '';
let historyRequest = null;
let previewSending = false;
let picker = null;
let pickerGeneration = 0;
let toastTimer;
const signatures = new Map();
const statusNames = { stopped:'未连接', connecting:'连接中', connected:'已连接', error:'连接异常' };

async function api(path, options = {}) {
  const headers = {'Accept':'application/json', ...options.headers};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') {
    if (!state?.csrfToken) throw new Error('尚未连接本地服务，请稍后重试。');
    headers['X-Bridge-Token'] = state.csrfToken;
  }
  const response = await fetch(path, { ...options, headers, cache:'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  if (body === null) throw new Error('本地服务返回了无效响应。');
  return body;
}
function mutate(path, body, method = 'POST') { return api(path, {method, body:JSON.stringify(body)}); }
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-region').innerHTML = `<div class="toast${error ? ' error' : ''}">${icon(error ? 'alert' : 'check')}<span>${esc(message)}</span></div>`;
  toastTimer = setTimeout(() => { $('#toast-region').innerHTML = ''; }, error ? 7000 : 3500);
}
async function act(button, operation) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await operation(); }
  catch (error) { toast(error.message || '操作未完成，请重试。', true); }
  finally {
    if (button?.isConnected) button.disabled = false;
    if (button?.id === 'preview-send') renderHistoryHeader();
  }
}
function changed(key, value) {
  const signature = JSON.stringify(value);
  if (signatures.get(key) === signature) return false;
  signatures.set(key, signature);
  return true;
}
function showView() {
  const hash = location.hash.slice(1);
  const view = ['overview','settings','activity'].includes(hash) ? hash : 'overview';
  $$('.view').forEach(el => { el.hidden = el.id !== `view-${view}`; });
  $$('[data-nav]').forEach(el => {
    const active = el.dataset.nav === view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  document.title = `${{overview:'工作台',settings:'连接与设置',activity:'运行记录'}[view]} · Feishu Codex`;
}
window.addEventListener('hashchange', showView);
showView();

function refreshState(fresh = false) {
  if (stateRequest) return fresh ? stateRequest.then(() => refreshState()) : stateRequest;
  stateRequest = (async () => {
    try {
      const result = await api('/api/state');
      state = result;
      $('#service-error').hidden = true;
      $('#server-dot').classList.remove('offline');
      renderState();
      if (!settingsLoaded || (!settingsDirty && settingsConfigSignature !== JSON.stringify(state.config))) fillSettings();
      if (!modelsLoaded) void loadModels();
      return true;
    } catch (error) {
      $('#service-error').hidden = false;
      setText('#service-error-text', `本地服务暂时不可用。${error.message === 'Failed to fetch' ? '请确认服务正在运行。' : error.message}`);
      $('#server-dot').classList.add('offline');
      $('#connection-toggle').disabled = true;
      setText('#sidebar-version', state ? '连接中断，正在重试' : '等待本地服务');
      return false;
    } finally { stateRequest = null; }
  })();
  return stateRequest;
}

function renderState() {
  const connection = state.connection || {status:'stopped'};
  const codex = state.codex || {};
  const config = state.config || {};
  const conversations = (state.conversations || []).filter(c => c.chatId !== 'local-preview');
  const badgeColor = connection.status === 'connected' ? 'green' : connection.status === 'error' ? 'red' : connection.status === 'connecting' ? 'amber' : 'neutral';
  const connectionBadge = $('#connection-badge');
  connectionBadge.className = `badge ${badgeColor}`;
  setText('#connection-badge', statusNames[connection.status] || connection.status);
  setText('#settings-status', config.appId && config.hasSecret ? '应用凭据已配置' : '等待配置应用');
  $('#settings-status').className = `badge ${config.appId && config.hasSecret ? 'green' : 'neutral'}`;
  setText('#feishu-detail', config.appId || '还没有配置机器人');
  const version = codex.version?.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  setText('#codex-detail', !codex.available ? (codex.mode === 'shared' ? '共享 Codex 暂不可用' : '未检测到 Codex') : codex.authenticated === false ? '需要登录 Codex' : `Codex${version ? ` ${version}` : ''}${codex.authenticated === true ? ' · 已登录' : ''}${codex.mode === 'shared' ? ' · 共享会话' : ''}`);
  $('#codex-detail').title = codex.version || codex.error || '';
  const detail = connection.detail || (connection.status === 'connected' ? '长连接已就绪，在飞书中发送消息即可开始。' : !config.appId || !config.hasSecret ? '先配置飞书应用，再开始连接。' : connection.status === 'connecting' ? '正在与飞书建立长连接…' : '应用已配置，点击连接机器人即可开始。');
  setText('#connection-detail', codex.error ? `${detail} · Codex：${codex.error}` : detail);
  const toggle = $('#connection-toggle');
  toggle.disabled = false;
  toggle.textContent = config.enabled ? '断开连接' : config.appId && config.hasSecret ? '连接机器人' : '配置机器人';
  setText('#metric-messages', Number(state.stats?.messagesToday || 0).toLocaleString('zh-CN'));
  setText('#metric-turns', Number(state.stats?.totalTurns || 0).toLocaleString('zh-CN'));
  setText('#metric-conversations', conversations.length);
  const busy = (state.conversations || []).filter(c => c.busy).length;
  setText('#metric-busy', busy ? `${busy} 个会话正在处理` : '随时可以继续');
  const minutes = Math.floor((state.service?.uptimeSeconds || 0) / 60);
  setText('#sidebar-version', `v${state.service?.version || '0.1.0'} · 已运行 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}`);
  setText('#conversation-count', conversations.length);
  if (changed('conversations', conversations)) renderConversations(conversations);
  renderActors();
  renderRequests();
  renderLogs();
  if (historyChat) renderHistoryHeader();
}

function renderConversations(conversations) {
  if (!conversations.length) {
    $('#conversations-list').innerHTML = empty('第一条对话，从飞书开始', '配置机器人并授权你的账号后，向它发送消息。项目、会话和处理状态都会出现在这里。');
    return;
  }
  $('#conversations-list').innerHTML = conversations.map(c => `<article class="conversation-row" data-preview-chat="${esc(c.chatId)}">
    <div class="conversation-avatar" title="飞书私聊">${icon('messages')}</div>
    <div class="conversation-content"><div class="conversation-project"><span class="context-label">当前项目</span><strong title="${esc(c.cwd || '')}">${esc(basename(c.cwd))}</strong></div><p class="conversation-path" title="${esc(c.cwd || '')}">${esc(c.cwd || '尚未选择项目目录')}</p><div class="conversation-title"><span class="context-label">当前会话</span><button type="button" data-action="history" data-chat="${esc(c.chatId)}" title="${esc(c.title || '新会话')} · 继续对话">${esc(c.title || '新会话')}</button><span class="badge ${c.busy ? 'amber' : 'green'}">${c.busy ? '处理中' : '就绪'}${c.queued ? ` · 排队 ${Number(c.queued)}` : ''}</span></div><div class="conversation-meta"><span class="conversation-session" title="${esc(c.threadId || '')}">${esc(sessionLabel(c))}</span><span>·</span><time datetime="${esc(c.updatedAt)}">${esc(relative(c.updatedAt))}</time></div><p class="conversation-preview${c.preview ? '' : ' placeholder'}">${esc(c.preview || (c.threadId ? '点击卡片，查看记录并继续对话。' : '点击卡片发送第一条消息，开始这段新会话。'))}</p></div>
    <div class="conversation-actions"><button type="button" class="button small primary" data-action="history" data-chat="${esc(c.chatId)}">${icon('messages')}继续对话</button><button class="button small ghost" data-action="project" data-chat="${esc(c.chatId)}">${icon('folder')}切换项目</button><button class="button small ghost" data-action="session" data-chat="${esc(c.chatId)}">${icon('messages')}切换会话</button><button class="button small ${c.busy ? 'danger' : 'secondary'}" data-action="${c.busy ? 'stop' : 'new'}" data-chat="${esc(c.chatId)}">${icon(c.busy ? 'stop' : 'plus')}${c.busy ? '停止回复' : '新建会话'}</button></div>
  </article>`).join('');
}
$('#conversations-list').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    const row = event.target.closest('[data-preview-chat]');
    if (row && !window.getSelection()?.toString().trim()) openHistory(row.dataset.previewChat, true);
    return;
  }
  const chatId = button.dataset.chat;
  const action = button.dataset.action;
  if (action === 'history') openHistory(chatId, true);
  if (action === 'project') openPicker('project', chatId);
  if (action === 'session') openPicker('session', chatId);
  if (action === 'stop') act(button, () => stopConversation(chatId));
  if (action === 'new') act(button, () => newConversation(chatId));
});

function renderActors() {
  const actors = (state.pendingActors || []).filter(actor => !(state.config.allowedActors || []).includes(actor.actorId));
  $('#pending-overview-section').hidden = actors.length === 0;
  setText('#pending-count', `${actors.length} 个账号`);
  if (!changed('actors', actors)) return;
  const html = actors.map(actor => `<div class="actor-row"><div><p>${esc(actor.actorId)}</p><small>最近发来消息 · ${esc(time(actor.lastSeenAt, true))}</small></div><button class="button secondary small" data-allow-actor="${esc(actor.actorId)}">${icon('check')}允许使用</button></div>`).join('');
  $('#pending-overview').innerHTML = html;
  $('#settings-pending').innerHTML = actors.length ? `<p class="field-help">等待授权</p>${html}` : '';
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-allow-actor]');
  if (!button) return;
  act(button, async () => {
    await mutate('/api/actors', {actorId:button.dataset.allowActor,allow:true});
    const actors = new Set($('#allowed-actors').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    actors.add(button.dataset.allowActor);
    $('#allowed-actors').value = [...actors].join('\n');
    toast('账号已授权，现在可以在飞书里继续。');
    await refreshState(true);
  });
});

function renderRequests() {
  const requests = state.pendingRequests || [];
  $('#requests-section').hidden = !requests.length;
  if (!changed('requests', requests)) return;
  const drafts = new Map($$('.request-card').map(form => [form.dataset.requestId, $$('textarea,select', form).map(input => input.value)]));
  const focused = document.activeElement;
  const focusRequest = focused?.closest('.request-card')?.dataset.requestId;
  const focusIndex = focusRequest ? $$('textarea,select', focused.closest('.request-card')).indexOf(focused) : -1;
  $('#requests-list').innerHTML = requests.map((request, index) => `<form class="request-card" data-request-id="${esc(request.id)}"><h3>${esc(request.title || (request.kind === 'approval' ? '等待确认' : '需要补充信息'))}</h3><p>${esc(request.text)}</p>${request.kind === 'question' ? (request.questions || []).map((question, q) => `<div class="question-field"><label for="answer-${index}-${q}">${esc(question.question)}</label>${question.options?.length ? `<select id="answer-${index}-${q}" data-question-option="${q}"><option value="">选择一个回答…</option>${question.options.map(option => `<option value="${esc(option.label)}">${esc(option.label)}${option.description ? ` · ${esc(option.description)}` : ''}</option>`).join('')}</select>` : ''}<textarea ${!question.options?.length ? `id="answer-${index}-${q}"` : ''} data-question-text="${q}" aria-label="${esc(question.question)}" placeholder="${question.options?.length ? '也可以直接输入其他回答' : '输入你的回答'}"></textarea></div>`).join('') : ''}<div class="request-actions">${request.kind === 'approval' ? '<button type="submit" name="decision" value="accept" class="button primary small">允许</button><button type="submit" name="decision" value="decline" class="button secondary small">拒绝</button>' : '<button type="submit" class="button primary small">提交回复</button>'}</div></form>`).join('');
  $$('.request-card').forEach(form => {
    const values = drafts.get(form.dataset.requestId);
    if (values) $$('textarea,select', form).forEach((input, index) => { input.value = values[index] || ''; });
    if (focusRequest === form.dataset.requestId && focusIndex >= 0) $$('textarea,select', form)[focusIndex]?.focus();
  });
}
$('#requests-list').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const request = state.pendingRequests.find(item => item.id === form.dataset.requestId);
  if (!request) return toast('该请求已经处理或失效。', true);
  const body = {id:request.id};
  if (request.kind === 'approval') body.decision = event.submitter?.value || 'decline';
  else {
    body.answers = {};
    for (let index = 0; index < (request.questions || []).length; index++) {
      const value = $(`[data-question-text="${index}"]`, form)?.value.trim() || $(`[data-question-option="${index}"]`, form)?.value;
      if (!value) return toast('请回答每个问题后再提交。', true);
      body.answers[request.questions[index].id] = {answers:[value]};
    }
  }
  act(event.submitter, async () => { await mutate('/api/answer', body); toast('回复已提交。'); await refreshState(true); });
});

function renderLogs(force = false) {
  if (!state) return;
  const query = $('#log-search').value.trim().toLowerCase();
  const logs = (state.logs || []).filter(log => (logLevel === 'all' || log.level === logLevel) && (!query || log.text.toLowerCase().includes(query)));
  if (!changed('logs', [logs,logLevel,query]) && !force) return;
  $('#logs-list').innerHTML = logs.length ? logs.map(log => `<div class="log-row"><time class="log-time" datetime="${esc(log.at)}">${esc(time(log.at, true))}</time><span class="log-level ${esc(log.level)}">${{info:'INFO',warn:'WARN',error:'ERROR'}[log.level] || esc(log.level)}</span><p class="log-text">${esc(log.text)}</p></div>`).join('') : empty(query || logLevel !== 'all' ? '没有匹配的记录' : '这里还很安静', query || logLevel !== 'all' ? '换个关键词，或切换到全部记录。' : '连接和会话开始后，运行状态会显示在这里。', 'activity');
  setText('#logs-footnote', `显示 ${logs.length} 条记录 · 最近的记录在最上方`);
}
$('#log-search').addEventListener('input', () => renderLogs());
$$('[data-log-level]').forEach(button => button.addEventListener('click', () => {
  logLevel = button.dataset.logLevel;
  $$('[data-log-level]').forEach(el => el.classList.toggle('active', el === button));
  renderLogs();
}));

function fillSettings() {
  const config = state.config;
  $('#app-id').value = config.appId || '';
  $('#app-secret').value = '';
  $('#app-secret').placeholder = config.hasSecret ? '已配置 · 留空保留当前密钥' : '输入应用密钥';
  setText('#secret-status', config.hasSecret ? '已安全保存' : '');
  $('#workspace').value = config.defaultWorkspace || '';
  $('#progress').checked = Boolean(config.progress);
  $('#allowed-actors').value = (config.allowedActors || []).join('\n');
  renderModelOptions(config.model || '');
  renderEffortOptions(config.effort || '');
  settingsLoaded = true;
  settingsDirty = false;
  settingsConfigSignature = JSON.stringify(config);
}
async function loadModels() {
  modelsLoaded = true;
  try {
    const result = await api('/api/models');
    models = result.models || [];
    const current = $('#model').value;
    const effort = $('#effort').value;
    renderModelOptions(current);
    renderEffortOptions(effort);
  } catch { modelsLoaded = false; }
}
function renderModelOptions(selected) {
  const options = [...models];
  if (selected && !options.some(model => model.id === selected)) options.unshift({id:selected,name:selected});
  $('#model').innerHTML = '<option value="">沿用本机 Codex 设置</option>' + options.map(model => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('');
  $('#model').value = selected;
}
function renderEffortOptions(selected = '') {
  const model = models.find(item => item.id === $('#model').value);
  const options = model?.efforts?.length ? [...model.efforts] : ['low','medium','high','xhigh'];
  if (selected && !options.includes(selected)) options.push(selected);
  const labels = {none:'不额外思考',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高'};
  $('#effort').innerHTML = '<option value="">跟随模型默认</option>' + options.map(effort => `<option value="${esc(effort)}">${labels[effort] || esc(effort)}</option>`).join('');
  $('#effort').value = selected;
}
$('#model').addEventListener('change', () => renderEffortOptions(''));
function markSettingsDirty() {
  settingsDirty = true;
  $('#settings-save-note').className = 'dirty';
  setText('#settings-save-note', '有尚未保存的更改');
}
$('#settings-form').addEventListener('input', markSettingsDirty);
$('#settings-form').addEventListener('change', markSettingsDirty);
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  act($('#save-settings'), async () => {
    const values = {
      appId:$('#app-id').value.trim(), appSecret:$('#app-secret').value.trim(),
      defaultWorkspace:$('#workspace').value.trim(), model:$('#model').value, effort:$('#effort').value,
      progress:$('#progress').checked,
      allowedActors:[...new Set($('#allowed-actors').value.split(/[\r\n,，]+/).map(s => s.trim()).filter(Boolean))],
    };
    const result = await mutate('/api/config', values, 'PUT');
    state.config = result.config;
    await refreshState(true);
    fillSettings();
    $('#settings-save-note').className = 'saved';
    setText('#settings-save-note', '设置已保存');
    toast('设置已保存。');
  });
});
$('#connection-toggle').addEventListener('click', event => act(event.currentTarget, async () => {
  if (!state.config.appId || !state.config.hasSecret) { location.hash = 'settings'; $('#app-id').focus(); return; }
  await mutate('/api/connection', {enabled:!state.config.enabled});
  toast(state.config.enabled ? '已断开飞书连接。' : '正在连接飞书机器人。');
  await refreshState(true);
}));
$('#retry-service').addEventListener('click', () => refreshState());
$('#choose-default-project').addEventListener('click', () => openPicker('project', null));

function conversation(chatId) { return state?.conversations?.find(item => item.chatId === chatId); }
function workspace(chatId) { return conversation(chatId)?.cwd || state?.config?.defaultWorkspace || ''; }
async function openPicker(kind, chatId) {
  if (!state) return toast('请等待本地服务连接。', true);
  if (kind === 'session' && !workspace(chatId)) return openPicker('project', chatId);
  const generation = ++pickerGeneration;
  picker = {kind,chatId,items:[],selected:kind === 'project' ? (chatId ? workspace(chatId) : $('#workspace').value) : conversation(chatId)?.threadId,loading:true};
  setText('#picker-title', kind === 'project' ? '选择项目' : '继续已有会话');
  setText('#picker-eyebrow', kind === 'project' ? 'WORKSPACE' : 'CONVERSATIONS');
  setText('#picker-description', kind === 'project' ? '从本机 Codex 历史项目中选择，或输入一个目录。' : workspace(chatId));
  $('#picker-search').value = '';
  $('#picker-search').placeholder = kind === 'project' ? '搜索名称或路径…' : '搜索会话标题或内容…';
  $('#manual-workspace-form').hidden = kind !== 'project';
  $('#manual-workspace').value = '';
  $('#picker-list').innerHTML = loading(kind === 'project' ? '正在读取本机项目…' : '正在读取历史会话…');
  if (!$('#picker-dialog').open) $('#picker-dialog').showModal();
  $('#picker-search').focus();
  try {
    const result = await api(kind === 'project' ? '/api/projects' : `/api/sessions?cwd=${encodeURIComponent(workspace(chatId))}`);
    if (generation !== pickerGeneration) return;
    picker.items = result[kind === 'project' ? 'projects' : 'sessions'] || [];
    picker.loading = false;
    renderPicker();
  } catch (error) {
    if (generation === pickerGeneration) { picker.loading = false; $('#picker-list').innerHTML = empty('暂时无法读取', error.message, 'alert'); }
  }
}
function renderPicker() {
  if (!picker || picker.loading) return;
  const search = $('#picker-search').value.trim().toLowerCase();
  const project = picker.kind === 'project';
  const items = picker.items.map((item, index) => ({item,index})).filter(({item}) => (project ? `${item.name} ${item.path}` : `${item.title} ${item.preview} ${item.id}`).toLowerCase().includes(search));
  if (!items.length) {
    $('#picker-list').innerHTML = empty(search ? '没有找到匹配结果' : project ? '还没有历史项目' : '这个项目还没有会话', search ? '试试其他名称或关键词。' : project ? '在下方输入本机项目目录，就可以开始了。' : '关闭窗口后，点击“新会话”开始一段对话。', project ? 'folder' : 'messages');
    return;
  }
  $('#picker-list').innerHTML = items.map(({item,index}) => {
    const selected = (project ? item.path : item.id) === picker.selected;
    return `<button class="picker-option${selected ? ' selected' : ''}" type="button" data-picker-index="${index}" ${selected ? 'aria-current="true"' : ''}><span class="option-icon">${icon(project ? 'folder' : 'messages')}</span><div><strong>${esc(project ? item.name : item.title || '未命名会话')}</strong><p>${esc(project ? item.path : item.preview || item.id)}</p></div><small>${selected ? '当前选择' : project ? `${Number(item.threadCount || 0)} 个会话` : esc(time(item.updatedAt, true))}</small>${selected ? icon('check') : ''}</button>`;
  }).join('');
}
$('#picker-search').addEventListener('input', renderPicker);
$('#picker-list').addEventListener('click', event => {
  const button = event.target.closest('[data-picker-index]');
  if (!button || !picker) return;
  const item = picker.items[Number(button.dataset.pickerIndex)];
  act(button, () => chooseItem(item));
});
async function chooseItem(item) {
  if (!picker) return;
  const {kind,chatId} = picker;
  if (kind === 'project' && chatId === null) {
    $('#workspace').value = item.path;
    markSettingsDirty();
  } else {
    await mutate('/api/bind', kind === 'project' ? {chatId,cwd:item.path} : {chatId,cwd:workspace(chatId),threadId:item.id});
    toast(kind === 'project' ? `已切换到 ${item.name || basename(item.path)}` : '已切换会话。');
    await refreshState(true);
    if (historyChat === chatId) { historySignature = ''; await refreshHistory(); }
  }
  $('#picker-dialog').close();
}
$('#manual-workspace-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('#manual-workspace').value.trim();
  if (!value) return;
  act(event.submitter, () => chooseItem({path:value,name:basename(value)}));
});
$('#picker-dialog').addEventListener('close', () => { pickerGeneration++; picker = null; });

async function newConversation(chatId) {
  const cwd = workspace(chatId);
  if (!cwd) { await openPicker('project', chatId); return; }
  await mutate('/api/new', {chatId,cwd});
  toast('已新建会话。');
  await refreshState(true);
  if (historyChat === chatId) { historySignature = ''; await refreshHistory(); }
}
async function stopConversation(chatId) {
  await mutate('/api/stop', {chatId});
  toast('已请求停止当前回复。');
  await refreshState(true);
  if (historyChat === chatId) await refreshHistory();
}
function openHistory(chatId, preview = false) {
  if (!state) return toast('请等待本地服务连接。', true);
  historyChat = chatId;
  historyPreview = preview;
  historySignature = '';
  $('#history-messages').innerHTML = loading('正在读取对话记录…');
  renderHistoryHeader();
  if (!$('#history-dialog').open) $('#history-dialog').showModal();
  refreshHistory();
  if (preview) $('#preview-input').focus();
}
function renderHistoryHeader() {
  if (!historyChat) return;
  const c = conversation(historyChat);
  const preview = historyPreview;
  const sharedPreview = preview && historyChat !== 'local-preview';
  const binding = JSON.stringify([historyChat, c?.threadId || '', workspace(historyChat)]);
  if (historyBinding !== binding) {
    historyBinding = binding;
    historySignature = '';
    $('#history-messages').innerHTML = loading('正在读取当前会话…');
  }
  setText('#history-eyebrow', `${sharedPreview ? '飞书会话 · 本地预览' : preview ? '本机独立预览' : '当前会话'} · ${sessionLabel(c)}`);
  $('#history-eyebrow').title = c?.threadId || '';
  setText('#history-title', c?.title || (preview ? '与本机 Codex 对话' : '新会话'));
  $('#history-title').title = c?.title || '';
  setText('#history-workspace', `当前项目：${basename(workspace(historyChat))}${workspace(historyChat) ? ` · ${workspace(historyChat)}` : ''}`);
  $('#history-workspace').title = workspace(historyChat);
  $('#preview-form').hidden = !preview;
  $('#history-readonly').hidden = preview;
  $('#history-stop').hidden = !c?.busy;
  $('#history-status').hidden = !c?.busy;
  setText('#history-status>span:last-child', c?.queued ? `Codex 正在处理 · 还有 ${c.queued} 条消息排队` : 'Codex 正在处理…');
  $('#history-project').disabled = previewSending || Boolean(c?.busy);
  $('#history-session').disabled = previewSending || Boolean(c?.busy);
  $('#history-new').disabled = previewSending || Boolean(c?.busy);
  $('#preview-send').disabled = previewSending || Boolean(c?.busy);
  $('#preview-input').placeholder = !workspace(historyChat) ? '请先点击上方“切换项目”选择目录' : c?.busy ? 'Codex 正在处理，可以先写下下一条消息…' : sharedPreview ? '继续当前飞书会话，回复只在后台显示…' : '给 Codex 一条消息…';
  setText('#preview-form .composer-footer>span', '回复只显示后台 · Enter 发送 · Shift + Enter 换行');
}
function refreshHistory() {
  if (!historyChat || !$('#history-dialog').open) return Promise.resolve();
  if (historyRequest?.binding === historyBinding) return historyRequest.promise;
  const chatId = historyChat;
  const request = {chatId,binding:historyBinding,promise:null};
  request.promise = (async () => {
    try {
      const result = await api(`/api/history?chatId=${encodeURIComponent(chatId)}`);
      if (historyChat !== chatId || historyBinding !== request.binding || !$('#history-dialog').open) return;
      const messages = result.messages || [];
      const signature = JSON.stringify(messages);
      if (historySignature === signature) return;
      const container = $('#history-messages');
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      const first = !historySignature;
      historySignature = signature;
      container.innerHTML = messages.length ? messages.map(message => `<article class="chat-message ${esc(message.role)}"><div class="chat-message-header"><strong>${message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '系统'}</strong><time datetime="${esc(message.at)}">${esc(time(message.at, true))}</time></div><div class="chat-message-body">${esc(message.text)}</div></article>`).join('') : empty(historyPreview ? '从一句话开始' : '等待第一条消息', historyPreview ? chatId === 'local-preview' ? '还没有飞书对话，选择项目后可以先在这里试用。回复只显示在后台。' : '这里与主页使用同一个项目和会话。直接发送消息，回复只显示在后台。' : '在飞书中发送消息后，对话记录会显示在这里。', 'terminal');
      if (nearBottom || first) container.scrollTop = container.scrollHeight;
    } catch (error) {
      if (historyChat === chatId && historyBinding === request.binding && !historySignature) $('#history-messages').innerHTML = empty('暂时无法读取对话', error.message, 'alert');
    } finally { if (historyRequest === request) historyRequest = null; }
  })();
  historyRequest = request;
  return request.promise;
}
$('#open-preview').addEventListener('click', () => {
  const current = (state?.conversations || []).filter(c => c.chatId !== 'local-preview').sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
  openHistory(current?.chatId || 'local-preview', true);
});
$('#history-project').addEventListener('click', () => openPicker('project', historyChat));
$('#history-session').addEventListener('click', () => openPicker('session', historyChat));
$('#history-new').addEventListener('click', event => act(event.currentTarget, () => newConversation(historyChat)));
$('#history-stop').addEventListener('click', event => act(event.currentTarget, () => stopConversation(historyChat)));
$('#history-dialog').addEventListener('close', () => { historyChat = null; historyPreview = false; historyBinding = ''; historySignature = ''; });
$('#preview-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!historyPreview || !historyChat || previewSending || conversation(historyChat)?.busy) return;
  const chatId = historyChat;
  const text = $('#preview-input').value.trim();
  if (!text) return;
  const cwd = workspace(chatId);
  if (!cwd) { openPicker('project',chatId); return; }
  act($('#preview-send'), async () => {
    previewSending = true;
    renderHistoryHeader();
    try {
      await mutate('/api/chat', {chatId,text,cwd});
      if (historyChat === chatId && $('#preview-input').value.trim() === text) $('#preview-input').value = '';
      await refreshState(true);
      await refreshHistory();
    } finally { previewSending = false; renderHistoryHeader(); }
  });
});
$('#preview-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#preview-form').requestSubmit(); }
});

$$('[data-copy-command]').forEach(button => button.addEventListener('click', () => act(button, async () => {
  await navigator.clipboard.writeText(button.dataset.copyCommand);
  toast(`已复制 ${button.dataset.copyCommand}，可粘贴到飞书。`);
})));

$$('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
window.addEventListener('beforeunload', event => { if (settingsDirty) { event.preventDefault(); event.returnValue = ''; } });
async function poll() {
  await refreshState();
  await refreshHistory();
  setTimeout(poll, 3000);
}
poll();
