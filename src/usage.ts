import type { CodexUsage, UsageLimit, UsageWindow } from './types.js';

const plans: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function formatUsage(usage: CodexUsage): string {
  if (usage.accountType === 'notLoggedIn') return '本机 Codex 尚未登录。请在 Codex 桌面登录 ChatGPT 账号后，再发送 /usage。';
  if (usage.accountType === 'apiKey') return '当前 Codex 使用 API Key 登录，无法查询 ChatGPT 套餐余量。API 账单与 ChatGPT 套餐额度分别计算。';
  if (usage.accountType === 'amazonBedrock') return '当前 Codex 使用 Amazon Bedrock，无法查询 ChatGPT 套餐余量。';

  const plan = usage.planType || usage.limits.find(limit => limit.planType)?.planType;
  const lines = [`套餐：${plan ? `ChatGPT ${plans[plan.toLowerCase()] || displayText(plan)}` : '暂未返回'}`];
  if (!usage.limits.length) lines.push('', '暂未返回额度数据，无法判断当前余量。');
  for (const limit of usage.limits) {
    lines.push('', `**${displayText(limit.name || (limit.id === 'codex' ? 'Codex' : limit.id))}**`);
    if (limit.primary) lines.push(formatWindow(limit.primary, '主额度'));
    if (limit.secondary) lines.push(formatWindow(limit.secondary, '次额度'));
    if (!limit.primary && !limit.secondary) lines.push('暂未返回额度窗口，无法判断当前余量。');
    const credits = formatCredits(limit);
    if (credits) lines.push(credits);
  }
  if (usage.resetCredits !== null && Number.isFinite(usage.resetCredits) && usage.resetCredits >= 0) lines.push('', `可用额度重置：${Math.floor(usage.resetCredits)} 次`);
  if (usage.ordinaryUsageAllowed === false) lines.push('', '服务端提示：当前套餐内用量暂不可用。');
  const fetched = new Date(usage.fetchedAt);
  if (!Number.isNaN(fetched.getTime())) lines.push('', `查询时间：${dateFormat.format(fetched)}`);
  lines.push('时间均为北京时间（UTC+8）。额度由同一账号共享，不仅限于此飞书会话。');
  return lines.join('\n');
}

function formatWindow(window: UsageWindow, fallback: string): string {
  const used = window.usedPercent;
  const remaining = used !== null && Number.isFinite(used) ? Math.round(Math.min(100, Math.max(0, 100 - used)) * 10) / 10 : null;
  const label = windowLabel(window.windowDurationMins, fallback);
  const reset = window.resetsAt === null || !Number.isFinite(window.resetsAt) ? null : new Date(window.resetsAt * 1000);
  return `${label}：剩余 ${remaining === null ? '未知' : `**${remaining}%**`}\n重置时间：${reset && !Number.isNaN(reset.getTime()) ? dateFormat.format(reset) : '暂未返回'}`;
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10080) return '周额度';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

function formatCredits(limit: UsageLimit): string | undefined {
  const credits = limit.credits;
  if (!credits) return;
  if (credits.unlimited) return '额外 Credits：不限额';
  if (credits.balance !== null) return `额外 Credits：${displayText(credits.balance)}`;
  return credits.hasCredits ? '额外 Credits：可用，余额暂未返回' : '额外 Credits：当前无可用余额';
}

function displayText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[\\*_`\[\]<>]/g, '\\$&').slice(0, 100);
}
