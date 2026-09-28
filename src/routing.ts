import type { InboundMessage } from './types.js';

export const DEFAULT_BOT_ID = 'default';

// Default IDs remain unchanged so existing private bindings and signed cards survive updates.
export function conversationKey(botId: string, id: string): string {
  return botId === DEFAULT_BOT_ID ? id : `bot:${encodeURIComponent(botId)}:${encodeURIComponent(id)}`;
}
export const messageKey = conversationKey;

export function parseRoute(key: string): { botId: string; id: string } {
  const match = /^bot:([^:]+):(.+)$/.exec(key);
  if (!match) return { botId: DEFAULT_BOT_ID, id: key };
  try { return { botId: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) }; }
  catch { throw new Error('无效的机器人消息标识'); }
}

export function namespaceMessage(botId: string, message: InboundMessage): InboundMessage {
  return {
    ...message, botId, rawChatId: message.chatId,
    chatId: conversationKey(botId, message.chatId), id: messageKey(botId, message.id),
    ...(message.actionMessageId ? { actionMessageId: messageKey(botId, message.actionMessageId) } : {}),
  };
}
