let stage = 'arguments';
try {
  const url = new URL(process.argv[2]);
  if (process.argv.length !== 3 || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) < 1024 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('必须指定本机共享后台地址。');
  stage = 'load';
  // Loading inside the try also reports incomplete packaged dependencies.
  const { runtimeProbe } = await import('../desktop/host.mjs');
  stage = 'probe';
  const first = await runtimeProbe(url.toString(), { idle: true, timeout: 30_000 });
  await new Promise(resolve => setTimeout(resolve, 300));
  const second = await runtimeProbe(url.toString(), { idle: true, timeout: 30_000 });
  if (![first.active, second.active].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('共享后台返回的活动任务数量无效。');
  const activeCount = Math.max(first.active, second.active);
  console.log(JSON.stringify({ ok: true, activeCount }));
  process.exitCode = activeCount ? 2 : 0;
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 80) : 'RUNTIME_PROBE_FAILED';
  const missingPackage = String(error?.message || '').match(/Cannot find package '([@\w./-]+)'/);
  const message = code === 'ERR_MODULE_NOT_FOUND' && missingPackage
    ? `安装文件缺少运行依赖“${missingPackage[1]}”，请重新安装完整版本。`
    : String(error?.message || '共享后台状态检查失败。').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 700);
  // No stack, task content, RPC payload or environment values enter diagnostics.
  console.log(JSON.stringify({ ok: false, error: { code, message, stage } }));
  process.exitCode = 1;
}
