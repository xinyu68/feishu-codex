import {
  GROUP_CONSULT_PATH, GROUP_CONSULT_TIMEOUT_MS, MAX_GROUP_CONSULT_ANSWER_LENGTH, MAX_GROUP_CONSULT_TARGET_LENGTH,
  groupConsultPort, validateGroupConsultRequest, type GroupConsultRequest, type GroupConsultResult,
} from './group-consult-request.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
type ConsultOptions = { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof globalThis.fetch };

export class GroupConsultClientError extends Error {
  constructor(public readonly code: 'cancelled' | 'timeout' | 'request' | 'invalid-response', message: string) {
    super(message);
    this.name = 'GroupConsultClientError';
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new GroupConsultClientError('invalid-response', '咨询服务返回空响应，请核对本次咨询状态，不要自动重试。');
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GroupConsultClientError('invalid-response', '咨询答复超过传输限制，请核对本次咨询状态，不要自动重试。');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new GroupConsultClientError('invalid-response', '咨询服务响应无效，请核对本次咨询状态，不要自动重试。'); }
}

/** Make one bounded loopback request; never retry a consultation whose dispatch status may be unknown. */
export async function consultFeishuGroupAgent(value: GroupConsultRequest, options: ConsultOptions = {}): Promise<GroupConsultResult> {
  const request = validateGroupConsultRequest(value);
  const timeoutMs = options.timeoutMs ?? GROUP_CONSULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GROUP_CONSULT_TIMEOUT_MS) throw new Error('consultation timeout is invalid');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(`http://127.0.0.1:${groupConsultPort(request.context_token)}${GROUP_CONSULT_PATH}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await readResponse(response);
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (!response.ok) {
      const detail = typeof record?.error === 'string' ? record.error.split(request.context_token).join('[已隐藏]').slice(0, 1000) : `HTTP ${response.status}`;
      throw new GroupConsultClientError('request', `咨询未完成：${detail}。不要自动重试或改用交接重复派发。`);
    }
    if (!record || typeof record.target !== 'string' || !record.target.trim() || [...record.target].length > MAX_GROUP_CONSULT_TARGET_LENGTH
      || typeof record.answer !== 'string' || !record.answer.trim() || [...record.answer].length > MAX_GROUP_CONSULT_ANSWER_LENGTH
      || (Object.hasOwn(record, 'truncated') && typeof record.truncated !== 'boolean')
      || (Object.hasOwn(record, 'groupReply') && record.groupReply !== 'sent' && record.groupReply !== 'uncertain')) {
      throw new GroupConsultClientError('invalid-response', '咨询服务没有返回有效的目标答复，请核对本次咨询状态，不要自动重试。');
    }
    return { target: record.target, answer: record.answer,
      ...(typeof record.truncated === 'boolean' ? { truncated: record.truncated } : {}),
      ...(record.groupReply === 'sent' || record.groupReply === 'uncertain' ? { groupReply: record.groupReply } : {}) };
  } catch (error) {
    if (options.signal?.aborted) throw new GroupConsultClientError('cancelled', '本次群咨询已取消。');
    if (timeout.aborted) throw new GroupConsultClientError('timeout', '等待群咨询答复超时，本次咨询状态尚未确认；不要自动重试或改用交接重复派发。');
    if (error instanceof GroupConsultClientError) throw error;
    // Do not expose the ticket, network stack, or a remote redirect destination.
    throw new GroupConsultClientError('request', '无法完成本机群咨询请求，请检查 Feishu Codex 连接；不要自动重试或改用交接重复派发。');
  }
}
