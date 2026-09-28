// Readiness checks are safe to repeat; launching or restarting the desktop is
// not. Keep retries here, before any desktop process is changed.
export async function waitForLaunchAccount(probe, url, {
  log = async () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 60_000, attemptMs = 45_000, retryDelayMs = 1_000,
} = {}) {
  const started = now(), deadline = started + timeoutMs;
  let attempts = 0;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('等待 Codex 登录状态超时，请检查网络后重新点击“打开 Codex”。账号和会话记录均已保留。');
    attempts++;
    try {
      const state = await probe(url, { account: true, timeout: Math.min(attemptMs, remaining) });
      if (!state?.ready || typeof state.authenticated !== 'boolean') throw new Error('Codex 返回的登录状态无效，请重试。');
      if (!state.authenticated) throw new Error('Codex 尚未登录，请先在官方 Codex 中完成登录，再连接飞书。');
      await log(`Codex 启动检查通过：登录状态已就绪（${now() - started}ms，第 ${attempts} 次检查）。`);
      return state;
    } catch (error) {
      const retryable = ['RUNTIME_PROBE_TIMEOUT', 'RUNTIME_CONNECTION_CLOSED', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(error.code);
      await log(`Codex 启动检查未通过：${error.code || 'ACCOUNT_CHECK_FAILED'} · ${error.stage || 'account/read'}（${now() - started}ms，第 ${attempts} 次检查）。`);
      if (!retryable) throw error;
      const remaining = deadline - now();
      if (remaining <= retryDelayMs) throw new Error('等待 Codex 登录状态超时，请检查网络后重新点击“打开 Codex”。账号和会话记录均已保留。');
      await sleep(retryDelayMs);
    }
  }
}
