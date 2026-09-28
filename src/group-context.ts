import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseRoute } from './routing.js';
import type { GroupMessage, InboundMessage } from './types.js';

export type GroupContextPlan = { text: string; seen: Record<string, number> };
export const GROUP_CONTEXT_LIMIT = 16000;
export const normalizeGroupWorkspace = (cwd: string): string => path.resolve(cwd).toLowerCase();

/** Receipts count original text characters, so an omitted tail remains eligible next time. */
export function planGroupContext(journal: GroupMessage[], message: InboundMessage, cwd: string,
  known: Record<string, number> = {}, threadId?: string): GroupContextPlan {
  const route = parseRoute(message.chatId);
  const currentId = parseRoute(message.id).id;
  const quoteId = message.replyTo ? parseRoute(message.replyTo).id : undefined;
  const scoped = journal.filter(item => normalizeGroupWorkspace(item.cwd) === normalizeGroupWorkspace(cwd));
  const quoted = quoteId ? scoped.find(item => parseRoute(item.id).id === quoteId) : undefined;
  const seen: Record<string, number> = {};
  const current = scoped.find(item => parseRoute(item.id).id === currentId);
  if (current && !message.handoff) seen[current.id] = current.text.length;
  const parts: string[] = [];
  const quote = message.quotedText || quoted?.text;
  if (quote) {
    const matchingSource = quoted && (quoted.text.startsWith(quote) || quote.startsWith(quoted.text));
    const header = `明确引用的群消息${matchingSource ? ' · ' + speakerLabel(quoted!) : ''}：`;
    const length = fittingLength(Math.min(10000, quote.length), size => `${header}\n${quoteLines(quote.slice(0, size))}\n[引用已截断]`.length <= 12000);
    const excerpt = quote.slice(0, length);
    parts.push(`${header}\n${quoteLines(excerpt)}${excerpt.length < quote.length ? '\n[引用已截断]' : ''}`);
    // External quoted text is not necessarily identical to our journal entry.
    if (quoted && quoted.text.startsWith(excerpt)) seen[quoted.id] = Math.max(known[quoted.id] ?? 0, excerpt.length);
  }
  const recent: string[] = [];
  let remaining = GROUP_CONTEXT_LIMIT - parts.join('\n\n').length - 100;
  const previous = scoped.filter(item => parseRoute(item.id).id !== currentId);
  const recentIds = new Set(previous.slice(-20).map(item => item.id));
  const eligible = previous.filter(item => recentIds.has(item.id)
    || (Object.hasOwn(known, item.id) && known[item.id]! < item.text.length));
  for (const item of eligible.reverse()) {
    if (parseRoute(item.id).id === quoteId || (quote && item.text === quote)) continue;
    if (threadId && item.role === 'assistant' && item.botId === route.botId && item.threadId === threadId) continue;
    const offset = Math.min(item.text.length, known[item.id] ?? 0);
    if (offset >= item.text.length) continue;
    // Zero records a pending candidate, not successful delivery. Keep omitted
    // entries eligible even if newer messages move them outside the recent window.
    seen[item.id] = offset;
    if (remaining < 200) continue;
    const serialize = (length: number) => `${speakerLabel(item)}${offset || offset + length < item.text.length ? `（片段 ${offset + 1}–${offset + length}/${item.text.length}）` : ''}\n${quoteLines(item.text.slice(offset, offset + length))}`;
    const low = fittingLength(Math.min(6000, item.text.length - offset), size => serialize(size).length + 2 <= remaining);
    if (!low) continue;
    const part = serialize(low);
    recent.unshift(part); remaining -= part.length + 2;
    seen[item.id] = offset + low;
  }
  if (recent.length) parts.push(`新增群聊：\n${recent.join('\n\n')}`);
  return { text: parts.join('\n\n'), seen };
}

function fittingLength(max: number, fits: (size: number) => boolean): number {
  let low = 0, high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function referenceText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function quoteLines(text: string): string {
  return referenceText(text).split('\n').map(line => '> ' + line).join('\n');
}

function speakerLabel(item: GroupMessage): string {
  // Keep unknown participants distinguishable without exposing a long open_id.
  const name = /^ou_[a-zA-Z0-9_-]+$/.test(item.sender)
    ? '群友·' + createHash('sha256').update(item.sender).digest('hex').slice(0, 8)
    : item.sender.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || (item.role === 'assistant' ? '机器人' : '群友');
  const date = new Date(item.at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = Number.isNaN(date.getTime()) ? '' : [pad(date.getMonth() + 1) + '-' + pad(date.getDate()), pad(date.getHours()) + ':' + pad(date.getMinutes())].join(' ');
  return (time ? time + ' · ' : '') + referenceText(name);
}
