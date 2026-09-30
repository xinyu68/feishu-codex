export const GROUP_CONSULT_TOOL_NAME = 'consult_feishu_group_agent';
export const GROUP_CONSULT_PATH = '/api/group/consult';
export const GROUP_CONSULT_EXECUTION_TIMEOUT_MS = 30 * 60_000;
export const GROUP_CONSULT_TIMEOUT_MS = GROUP_CONSULT_EXECUTION_TIMEOUT_MS + 10_000;
export const GROUP_CONSULT_MCP_TIMEOUT_SECONDS = GROUP_CONSULT_TIMEOUT_MS / 1000 + 20;
export const MAX_GROUP_CONSULT_TARGET_LENGTH = 100;
export const MAX_GROUP_CONSULT_QUESTION_LENGTH = 6000;
export const MAX_GROUP_CONSULT_CONTEXT_LENGTH = 12_000;
export const MAX_GROUP_CONSULT_ANSWER_LENGTH = 60_000;

export type GroupConsultRequest = { context_token: string; target: string; question: string; context?: string };
export type GroupConsultResult = { target: string; answer: string; truncated?: boolean; groupReply?: 'sent' | 'uncertain' };

export const GROUP_CONSULT_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    context_token: {
      type: 'string', pattern: '^fc1\\.([1-9][0-9]{0,4})\\.([a-f0-9]{64})$',
      description: '原样复制本轮飞书群上下文提供的咨询凭据；不得自行构造、复用历史凭据或转发给其他角色。',
    },
    target: {
      type: 'string', minLength: 1, maxLength: MAX_GROUP_CONSULT_TARGET_LENGTH,
      description: '本轮可咨询角色中的准确名称、角色 ID 或唯一别名；只选择一个其他角色。',
    },
    question: {
      type: 'string', minLength: 1, maxLength: MAX_GROUP_CONSULT_QUESTION_LENGTH,
      description: '委派该角色执行的具体任务或问题，必须属于当前用户已授权的范围；可包括查询、改文件、执行命令和外部应用操作。工具等待执行结果并在本轮返回。',
    },
    context: {
      type: 'string', minLength: 1, maxLength: MAX_GROUP_CONSULT_CONTEXT_LENGTH,
      description: '可选：该问题需要的本群公开背景或本轮工作摘要；不要传其他群、私聊、完整会话或密钥。',
    },
  },
  required: ['context_token', 'target', 'question'],
  additionalProperties: false,
};

/** The ticket selects only a local port; the bridge verifies its entire value against a live source turn. */
export function groupConsultPort(token: unknown): number {
  const match = typeof token === 'string' ? /^fc1\.([1-9][0-9]{0,4})\.([a-f0-9]{64})$/.exec(token) : null;
  const port = match ? Number(match[1]) : 0;
  if (!port || port > 65535) throw new Error('context_token must be a current Feishu group consultation ticket');
  return port;
}

/** Validate payload shape only; routing, authority and expiration belong to the bridge. */
export function validateGroupConsultRequest(value: unknown): GroupConsultRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('group consultation arguments must be an object');
  }
  if (Reflect.ownKeys(value).some(key => !['context_token', 'target', 'question', 'context'].includes(String(key)) || typeof key !== 'string')) {
    throw new Error('group consultation arguments may only contain context_token, target, question and context');
  }
  const input = value as Record<string, unknown>;
  if (!Object.hasOwn(input, 'context_token')) throw new Error('context_token is required');
  groupConsultPort(input.context_token);
  const field = (name: 'target' | 'question' | 'context', limit: number): string => {
    if (!Object.hasOwn(input, name) || typeof input[name] !== 'string') throw new Error(`${name} must be a string`);
    const normalized = input[name].trim();
    const length = [...normalized].length;
    if (!length || length > limit) throw new Error(`${name} must be 1-${limit} characters`);
    return normalized;
  };
  return {
    context_token: input.context_token as string,
    target: field('target', MAX_GROUP_CONSULT_TARGET_LENGTH),
    question: field('question', MAX_GROUP_CONSULT_QUESTION_LENGTH),
    ...(Object.hasOwn(input, 'context') ? { context: field('context', MAX_GROUP_CONSULT_CONTEXT_LENGTH) } : {}),
  };
}
