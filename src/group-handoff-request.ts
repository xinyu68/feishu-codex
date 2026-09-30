export const GROUP_HANDOFF_TOOL_NAME = 'request_feishu_group_handoff';
export const MAX_GROUP_HANDOFF_TARGET_LENGTH = 100;
export const MAX_GROUP_HANDOFF_TASK_LENGTH = 6000;

export type GroupHandoffRequest = { target: string; task: string };

export const GROUP_HANDOFF_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'string', minLength: 1, maxLength: MAX_GROUP_HANDOFF_TARGET_LENGTH,
      description: '本轮可交接角色中的准确名称、角色 ID 或唯一别名；只选择一个其他角色。',
    },
    task: {
      type: 'string', minLength: 1, maxLength: MAX_GROUP_HANDOFF_TASK_LENGTH,
      description: '交给该角色继续处理的具体任务，可包含多行说明和问题；必须属于用户已授权的任务。',
    },
  },
  required: ['target', 'task'],
  additionalProperties: false,
};

/** Validate only the request payload; the bridge determines all routing and authority. */
export function validateGroupHandoffRequest(value: unknown): GroupHandoffRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('group handoff arguments must be an object');
  }
  if (Reflect.ownKeys(value).some(key => key !== 'target' && key !== 'task')) {
    throw new Error('group handoff arguments may only contain target and task');
  }
  const input = value as Record<string, unknown>;
  const field = (name: keyof GroupHandoffRequest, limit: number): string => {
    if (!Object.hasOwn(input, name) || typeof input[name] !== 'string') throw new Error(`${name} must be a string`);
    const normalized = input[name].trim();
    const length = [...normalized].length;
    if (!length || length > limit) throw new Error(`${name} must be 1-${limit} characters`);
    return normalized;
  };
  return { target: field('target', MAX_GROUP_HANDOFF_TARGET_LENGTH), task: field('task', MAX_GROUP_HANDOFF_TASK_LENGTH) };
}
