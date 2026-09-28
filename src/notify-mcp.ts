import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const NOTIFICATION_TOOL_NAME = 'request_feishu_completion_notification';
const ARTIFACT_TOOL_NAME = 'send_artifact_to_feishu';
const MAX_ARTIFACTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const tools = [{
  name: NOTIFICATION_TOOL_NAME,
  description: '当用户明确要求当前任务完成、失败或停止后通过飞书/Lark通知他时调用一次。应理解“做完飞书告诉我”“完成后给我发个飞书消息”等不同表达。仅讨论这个功能是否可行、询问如何使用、或任务本身来自飞书时不要调用。此工具只登记当前任务的完成通知，真正的消息会在本轮结束后由 Feishu Codex 发送。',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string', description: '用一句简短中文说明正在处理的任务，便于完成通知辨认。不要包含密钥或隐私数据。' } },
    required: ['summary'], additionalProperties: false,
  },
}, {
  name: ARTIFACT_TOOL_NAME,
  description: '仅当用户明确要求把某个已知的本地成品图片或文件发送到飞书时调用。只传用户点名或本轮明确生成的成品文件，不要扫描项目、不要发送目录、通配符、源码改动、密钥或其他未明确要求的文件。图片会作为飞书图片发送，其他文件会作为飞书文件发送。普通编码任务结束时不要自动调用。',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array', minItems: 1, maxItems: MAX_ARTIFACTS,
        items: { type: 'string' },
        description: '1 到 5 个明确的本地绝对文件路径。不能是目录或通配符。',
      },
    },
    required: ['paths'], additionalProperties: false,
  },
}];

function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id: RpcRequest['id'], value: unknown): void { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result: value }); }
function failure(id: RpcRequest['id'], code: number, message: string): void { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function validateArtifactPaths(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARTIFACTS) throw new Error(`paths must contain 1-${MAX_ARTIFACTS} files`);
  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || /[*?]/.test(entry)) throw new Error('each path must be an absolute file path without wildcards');
    const candidate = entry.trim();
    if (!path.isAbsolute(candidate)) throw new Error('each path must be absolute');
    const linkInfo = await lstat(candidate).catch(() => undefined);
    if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) throw new Error(`not a regular file: ${path.basename(candidate) || candidate}`);
    const canonical = await realpath(candidate);
    const info = await stat(canonical);
    const limit = IMAGE_EXTENSIONS.has(path.extname(canonical).toLowerCase()) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (info.size <= 0) throw new Error(`file is empty: ${path.basename(canonical)}`);
    if (info.size > limit) throw new Error(`${path.basename(canonical)} exceeds the ${limit / 1024 / 1024} MB limit`);
    resolved.push(canonical);
  }
  return [...new Set(resolved)];
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void (async () => {
    let request: RpcRequest;
    try { request = JSON.parse(line) as RpcRequest; } catch { return; }
    if (request.method === 'initialize') {
      result(request.id, { protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'feishu-codex-notify', version: '0.2.0' } });
      return;
    }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return;
    if (request.method === 'ping') { result(request.id, {}); return; }
    if (request.method === 'tools/list') { result(request.id, { tools }); return; }
    if (request.method === 'tools/call') {
      const args = request.params?.arguments as Record<string, unknown> | undefined;
      if (request.params?.name === NOTIFICATION_TOOL_NAME) {
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
        if (!summary || summary.length > 200) { failure(request.id, -32602, 'summary must be 1-200 characters'); return; }
        result(request.id, { content: [{ type: 'text', text: '已登记：本轮任务结束后，Feishu Codex 会发送一条新的飞书通知。' }], isError: false });
        return;
      }
      if (request.params?.name === ARTIFACT_TOOL_NAME) {
        try {
          const paths = await validateArtifactPaths(args?.paths);
          result(request.id, {
            content: [{ type: 'text', text: `已提交 ${paths.length} 个成品文件给 Feishu Codex；实际发送结果会显示在飞书中。` }],
            structuredContent: { paths }, isError: false,
          });
        } catch (error) { failure(request.id, -32602, error instanceof Error ? error.message : String(error)); }
        return;
      }
      failure(request.id, -32602, 'Unknown tool');
      return;
    }
    failure(request.id, -32601, 'Method not found');
  })().catch(error => process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`));
});
