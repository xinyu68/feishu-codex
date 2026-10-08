export const MESSAGE_TOOL_NAME = 'send_message_to_feishu';
export const MESSAGE_CONNECTION_PATH = '/api/mcp/message-connection';
export const MESSAGE_SEND_PATH = '/api/mcp/messages/default';
export const MESSAGE_SEND_TIMEOUT_MS = 20_000;
export type MessageRequest = { text: string; title?: string; request_id: string };
export type MessageResult = { status: 'sent'; request_id: string; botName: string; messageId: string; deduplicated: boolean };
export type MessageDelivery = {
  fingerprint: string; status: 'sending' | 'sent' | 'uncertain'; at: string;
  botName: string; chatId: string; actorId: string; botAppId: string; messageId?: string;
};
export class MessageSendError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
export const MESSAGE_REQUEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 6000, description: '用户明确要求立即发送的文字，可使用 Markdown。' },
    title: { type: 'string', minLength: 1, maxLength: 80, description: '可选的简短消息标题。' },
    request_id: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$', description: '自行生成本次发送的唯一编号（例如 UUID），不要向用户索要。核对或重试同一次发送必须复用原编号；新的发送使用新编号。' },
  }, required: ['text', 'request_id'],
};
export function validateMessageRequest(value: unknown): MessageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageSendError('invalid_request', '消息参数必须是对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['text', 'title', 'request_id'].includes(key))) throw new MessageSendError('invalid_request', '只接受消息正文、标题和请求编号；接收位置由执行端来源和通知设置决定。');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : undefined;
  if (!text || text.length > 6000) throw new MessageSendError('invalid_request', '消息正文须为 1–6000 个字符。');
  if (Object.hasOwn(input, 'title') && (!title || title.length > 80)) throw new MessageSendError('invalid_request', '消息标题须为 1–80 个字符。');
  if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(input.request_id)) throw new MessageSendError('invalid_request', '请为本次发送生成 8–100 位请求编号。');
  return { text, ...(title ? { title } : {}), request_id: input.request_id };
}
