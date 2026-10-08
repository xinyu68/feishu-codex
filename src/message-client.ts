import http from 'node:http';
import { MESSAGE_CONNECTION_PATH, MESSAGE_SEND_PATH, MessageSendError, validateMessageRequest, type MessageResult } from './message-request.js';

/** One loopback exchange, without proxy, redirects, network retries or model-visible credentials. */
function exchange(port: number, route: string, signal: AbortSignal, body?: string, token?: string, engine?: 'codex' | 'hermes'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET', signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(token ? { 'X-Feishu-Mcp-Token': token } : {}), ...(engine ? { 'X-Feishu-Mcp-Engine': engine } : {}) },
    }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_384) response.destroy(new Error('Response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) throw new Error('Redirect rejected');
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response');
        resolve({ status: response.statusCode ?? 500, body: result as Record<string, unknown> });
      } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.end(body);
  });
}
export async function sendMessageToFeishu(value: unknown, options: { port?: number; signal?: AbortSignal; timeoutMs?: number; engine?: 'codex' | 'hermes' } = {}): Promise<MessageResult> {
  const input = validateMessageRequest(value);
  const port = options.port ?? Number(process.env.FEISHU_CODEX_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MessageSendError('invalid_connection', '飞书桥接端口配置无效。');
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 25_000), ...(options.signal ? [options.signal] : [])]);
  let submitted = false;
  try {
    const connection = await exchange(port, MESSAGE_CONNECTION_PATH, signal);
    if (connection.status !== 200 || connection.body.name !== 'feishu-codex-message' || typeof connection.body.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.body.token)) throw new Error('No bridge connection');
    signal.throwIfAborted();
    submitted = true;
    const response = await exchange(port, MESSAGE_SEND_PATH, signal, JSON.stringify(input), connection.body.token, options.engine ?? 'codex');
    if (response.status !== 200) {
      const detail = typeof response.body.error === 'string' ? response.body.error.split(connection.body.token).join('[已隐藏]').slice(0, 600) : '发送未完成，请检查默认通知设置。';
      throw new MessageSendError('send_failed', detail, response.status);
    }
    const result = response.body;
    if (result.status !== 'sent' || result.request_id !== input.request_id || typeof result.botName !== 'string' || !result.botName
      || typeof result.messageId !== 'string' || !result.messageId || typeof result.deduplicated !== 'boolean') throw new Error('Unconfirmed response');
    return result as MessageResult;
  } catch (error) {
    if (error instanceof MessageSendError) throw error;
    throw new MessageSendError(submitted ? 'uncertain' : 'unavailable', submitted
      ? '发送结果未确认，请保留原请求编号并核对飞书；不要换编号或改用 CLI 重发。'
      : '无法连接即时消息服务，消息未提交。请确认 Feishu Codex 已运行且已更新，再重试。', 503);
  }
}
