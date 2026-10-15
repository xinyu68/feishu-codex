/** Task state informs the user; it is never a veto after confirmation. */
export async function quitWithConfirmation({ assess, confirm, shutdown }) {
  let assessment;
  try { assessment = await assess(); }
  catch { assessment = { needsConfirmation: true, detail: '暂时无法确认是否有任务运行，继续退出可能中断任务。' }; }
  if (assessment.needsConfirmation && !await confirm(assessment)) return { ok: false, cancelled: true };
  return shutdown();
}
