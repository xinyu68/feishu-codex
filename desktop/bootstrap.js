const api = window.feishuCodex;
const element = id => document.getElementById(id);
function render(state) {
  const migration = state.migration;
  const active = ['starting', 'waiting_for_elevation', 'waiting_for_codex', 'running', 'migrating'].includes(migration?.status);
  const blocked = state.state === 'setup' && ['blocked', 'restore'].includes(state.setupMode);
  const fresh = state.state === 'setup' && state.setupMode === 'fresh';
  element('title').textContent = blocked ? '发现已有本机数据' : fresh ? '开始连接飞书' : state.state === 'setup' ? '正在准备本机服务' : state.state === 'error' ? '连接需要一点帮助' : '连接你的工作空间';
  element('description').textContent = state.reason || '服务已经就绪，正在打开工作台…';
  element('fresh').hidden = !fresh;
  element('fresh').disabled = Boolean(state.setupInstalling || active);
  element('fresh').textContent = state.setupInstalling ? '正在设置…' : '开始设置';
  element('restore').hidden = !blocked;
  element('restore').disabled = Boolean(state.setupInstalling || active);
  element('restore').textContent = state.setupInstalling ? '正在恢复…' : '恢复连接';
  element('retry').hidden = state.state === 'setup';
  for (const name of ['runtime', 'bridge']) {
    const status = state[name]?.state;
    element(`${name}Dot`).className = `dot ${status === 'ready' ? 'ready' : status === 'blocked' || status === 'unhealthy' ? 'error' : ''}`;
    element(`${name}Label`).textContent = ({ ready: '已连接', starting: '启动中', unhealthy: '暂未就绪', blocked: '需要处理', backoff: '等待重试' })[status] || (state.state === 'setup' ? (blocked ? '等待处理' : '设置后连接') : '等待连接');
  }
  element('error').textContent = state.actionError || (migration?.status === 'failed' ? '详细原因已保存在本机日志。可点击“查看日志”。' : '');
  const switching = state.launch?.state === 'switching' || state.launch?.state === 'confirming';
  const independent = state.desktop?.mode === 'independent';
  const opening = state.launch?.state === 'opening';
  const launchError = state.launch?.state === 'error';
  const showLaunch = state.state !== 'setup' && (switching || independent || opening || launchError);
  const canOpenDesktop = state.desktop?.mode === 'shared' || (state.canWrite === true && state.runtime?.state === 'ready' && state.bridge?.state === 'ready');
  element('desktopGuidance').hidden = !showLaunch;
  element('desktopTitle').textContent = switching ? '正在连接飞书' : independent ? 'Codex 已打开，但尚未连接飞书' : opening ? '正在打开 Codex' : 'Codex 尚未打开';
  element('desktopDescription').textContent = switching ? state.launch.message : independent ? (launchError ? state.launch.message : '飞书发送已暂停。连接会重启 Codex；若有正在运行的任务，将会停止。') : opening ? '正在连接 Codex 和飞书…' : state.launch?.message || '可以重试打开 Codex；如果飞书已连接，也可以先在飞书继续使用。';
  element('switch').hidden = !showLaunch || !independent || switching;
  element('openCodex').hidden = !showLaunch || !launchError || independent;
  element('openCodex').textContent = canOpenDesktop ? '重试打开 Codex' : '重试连接';
  element('openCodex').dataset.action = canOpenDesktop ? 'openCodex' : 'retry';
  if (!element('openCodex').hidden) element('retry').hidden = true;
}
for (const [id, action] of [['retry', 'retry'], ['logs', 'openLogs'], ['fresh', 'setupFresh'], ['restore', 'restoreExisting'], ['switch', 'switchToShared'], ['openCodex', 'openCodex']]) element(id).addEventListener('click', async () => {
  element(id).disabled = true; element('error').textContent = '';
  try { const method = id === 'openCodex' ? element(id).dataset.action || action : action; const result = await api[method](); if (!result?.cancelled && (result?.error || result?.ok === false)) throw new Error(result.error || result.message || '操作未完成'); render(await api.getStatus()); }
  catch (error) { element('error').textContent = error.message; }
  finally { element(id).disabled = false; }
});
api.onStatus(render); api.getStatus().then(render).catch(error => { element('error').textContent = error.message; });
