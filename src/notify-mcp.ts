import { createInterface } from 'node:readline';
import { ARTIFACT_TOOL_NAME, MAX_ARTIFACTS, validateArtifactPaths } from './artifact-request.js';
import { GROUP_HANDOFF_REQUEST_SCHEMA, GROUP_HANDOFF_TOOL_NAME, validateGroupHandoffRequest } from './group-handoff-request.js';
import { GROUP_CONSULT_REQUEST_SCHEMA, GROUP_CONSULT_TOOL_NAME, validateGroupConsultRequest } from './group-consult-request.js';
import { consultFeishuGroupAgent } from './group-consult-client.js';
import { MESSAGE_REQUEST_SCHEMA, MESSAGE_TOOL_NAME, validateMessageRequest } from './message-request.js';
import { sendMessageToFeishu } from './message-client.js';

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const NOTIFICATION_TOOL_NAME = 'request_feishu_completion_notification';
// Hermes artifact receipts are reconciled by its bound runtime. Desktop completion
// notifications still require Codex's native turn lifecycle.
const hermesMode = process.env.FEISHU_CODEX_MCP_MODE === 'hermes';
const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [{
  name: NOTIFICATION_TOOL_NAME,
  description: '当用户明确要求当前任务完成、失败或停止后通过飞书/Lark通知他时调用一次。应理解“做完飞书告诉我”“完成后给我发个飞书消息”等不同表达。仅讨论这个功能是否可行、询问如何使用、或任务本身来自飞书时不要调用。此工具只登记当前任务的完成通知，真正的消息会在本轮结束后由 Feishu Codex 发送。',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string', description: '用一句简短中文说明正在处理的任务，便于完成通知辨认。不要包含密钥或隐私数据。' } },
    required: ['summary'], additionalProperties: false,
  },
}, {
  name: ARTIFACT_TOOL_NAME,
  description: '仅当用户明确要求把某个已知的本地成品图片或文件发送到飞书时调用。发送到当前任务绑定的私聊或群聊，不使用默认通知机器人；Hermes 在本轮结束后由桥接发送。只传用户点名或本轮明确生成的成品文件，不要扫描项目、不要发送目录、通配符、源码改动、密钥或其他未明确要求的文件。图片会作为飞书图片发送，其他文件会作为飞书文件发送。返回已提交不等于送达，以桥接的实际发送结果为准。普通编码任务结束时不要自动调用。',
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
}, {
  name: GROUP_HANDOFF_TOOL_NAME,
  description: '仅在当前飞书群聊任务确需名单中的另一角色继续用户已授权工作时，提交一次结构化交接申请。只指定一个角色和具体任务；不要传群、账号、机器人来源或会话编号。工具只提交申请：当前群聊轮次结束且回复确认送达后，Feishu Codex 桥接才会校验授权、角色和交接限制并执行。私聊、本地预览、讨论或示例不使用此工具；提交后正常完成本轮回复，不等待目标角色的结果。',
  inputSchema: GROUP_HANDOFF_REQUEST_SCHEMA,
}, {
  name: GROUP_CONSULT_TOOL_NAME,
    description: '当前真实飞书群任务需要委派另一角色完成工作，等它返回后自己继续处理时调用。目标可按用户授权使用所有可用工具，包含查询、改文件、执行命令、测试和外部应用操作，不限定搜索方式。同步等待最多 30 分钟；不等待结果、由对方接手继续时使用交接。原样复制当前轮次的 context_token，选择名单中的一个其他角色并说明问题；桥接先以你的机器人身份公开问题并 @目标，再由目标在原群展示实际进度和答复，工具等待实际答复，返回后在同一轮继续。不要自行重复发送问题。根据返回的群回复送达状态说明结果，已送达时不要完整复述目标答复，只补充自己的结论和后续处理。只用于用户已授权的当前任务，不用于私聊、本地预览、桌面续聊或历史群上下文。不要转发凭据；失败或超时不要自动重试或改用交接重复派发。',
  inputSchema: GROUP_CONSULT_REQUEST_SCHEMA,
}];
tools.push({
  name: MESSAGE_TOOL_NAME,
  description: '用户明确要求现在把一段文字发到自己的飞书时调用；通过应用配置的同类型默认通知机器人发到已授权私聊，Codex 与 Hermes 各自独立，不跨类型兜底，立即等待飞书确认，不必结束本轮。自行生成 request_id，同一次发送核对或重试复用原编号。普通飞书回复已自动转发，不调用此工具重复发送；' + (hermesMode ? '用户要求完成后通知时，先完成任务再调用；不要提前声称已登记。' : '“做完通知我”使用完成通知工具。') + '通过本应用发给对应类型的默认接收人优先用此工具；用户明确指定飞书 CLI 时遵循其选择，同一发送不得再调用 CLI 或其他工具补发。',
  inputSchema: MESSAGE_REQUEST_SCHEMA,
});
const hermesTools = new Set([ARTIFACT_TOOL_NAME, GROUP_HANDOFF_TOOL_NAME, GROUP_CONSULT_TOOL_NAME, MESSAGE_TOOL_NAME]);
const consultations = new Map<string | number, { controller: AbortController; cancelled: boolean }>();

function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id: RpcRequest['id'], value: unknown): void { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result: value }); }
function failure(id: RpcRequest['id'], code: number, message: string): void { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => {
  for (const pending of consultations.values()) { pending.cancelled = true; pending.controller.abort(); }
});
input.on('line', line => {
  void (async () => {
    let request: RpcRequest;
    try { request = JSON.parse(line) as RpcRequest; } catch { return; }
    if (request.method === 'initialize') {
      result(request.id, { protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'feishu-codex-notify', version: '0.2.0' } });
      return;
    }
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'notifications/cancelled') {
      const requestId = request.params?.requestId;
      const pending = typeof requestId === 'string' || typeof requestId === 'number' ? consultations.get(requestId) : undefined;
      if (pending) { pending.cancelled = true; pending.controller.abort(); }
      return;
    }
    if (request.method === 'ping') { result(request.id, {}); return; }
    if (request.method === 'tools/list') { result(request.id, { tools: hermesMode ? tools.filter(tool => hermesTools.has(tool.name)) : tools }); return; }
    if (request.method === 'tools/call') {
      if (hermesMode && (typeof request.params?.name !== 'string' || !hermesTools.has(request.params.name))) { failure(request.id, -32602, 'This tool is not available for the Hermes bridge'); return; }
      const args = request.params?.arguments as Record<string, unknown> | undefined;
      if (request.params?.name === MESSAGE_TOOL_NAME) {
        if (typeof request.id !== 'string' && typeof request.id !== 'number') return;
        const id = request.id;
        if (consultations.has(id)) { failure(id, -32600, 'A request with this id is already in progress'); return; }
        let message;
        try { message = validateMessageRequest(args); }
        catch (error) { failure(id, -32602, error instanceof Error ? error.message : 'Invalid message'); return; }
        const pending = { controller: new AbortController(), cancelled: false };
        consultations.set(id, pending);
        try {
          const sent = await sendMessageToFeishu(message, { signal: pending.controller.signal, engine: hermesMode ? 'hermes' : 'codex' });
          if (!pending.cancelled) result(id, { content: [{ type: 'text', text: `${sent.deduplicated ? '此前已发送，本次未重复发送' : '已发送'} · ${sent.botName}的通知私聊。` }], structuredContent: sent, isError: false });
        } catch (error) {
          if (!pending.cancelled) result(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : '发送结果未确认，请勿重复发送。' }], isError: true });
        } finally { if (consultations.get(id) === pending) consultations.delete(id); }
        return;
      }
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
      if (request.params?.name === GROUP_HANDOFF_TOOL_NAME) {
        try {
          const handoff = validateGroupHandoffRequest(args);
          result(request.id, {
            content: [{ type: 'text', text: '交接申请已提交；尚未执行交接。当前群聊轮次结束且回复确认送达后，Feishu Codex 桥接会校验授权、目标角色和交接限制，符合条件才会执行。请正常完成本轮回复，不等待目标角色结果。' }],
            structuredContent: handoff, isError: false,
          });
        } catch (error) { failure(request.id, -32602, error instanceof Error ? error.message : String(error)); }
        return;
      }
      if (request.params?.name === GROUP_CONSULT_TOOL_NAME) {
        if (typeof request.id !== 'string' && typeof request.id !== 'number') return;
        const id = request.id;
        if (consultations.has(id)) { failure(id, -32600, 'A request with this id is already in progress'); return; }
        let consultation;
        try { consultation = validateGroupConsultRequest(args); }
        catch (error) { failure(id, -32602, error instanceof Error ? error.message : 'Invalid group consultation arguments'); return; }
        const pending = { controller: new AbortController(), cancelled: false };
        consultations.set(id, pending);
        try {
          const answer = await consultFeishuGroupAgent(consultation, { signal: pending.controller.signal });
          const groupReplyNote = answer.groupReply === 'sent'
            ? '\n（目标答复已由目标角色发送到原群，请继续处理，只补充自己的结论和后续安排，不要完整复述。）'
            : answer.groupReply === 'uncertain'
              ? '\n（目标答复的群内送达状态未确认；以上为已取得的实际答复。请据此继续处理，不要声称群内已送达，也不要自动重试或重复派发。）'
              : '';
          if (!pending.cancelled) result(id, {
            content: [{ type: 'text', text: `${answer.target} 的答复：\n${answer.answer}${answer.truncated ? '\n（答复因长度限制已截断）' : ''}${groupReplyNote}` }],
            structuredContent: answer, isError: false,
          });
        } catch (error) {
          if (!pending.cancelled) result(id, {
            content: [{ type: 'text', text: error instanceof Error ? error.message : '群咨询未完成，请核对本次咨询状态，不要自动重试。' }], isError: true,
          });
        } finally { if (consultations.get(id) === pending) consultations.delete(id); }
        return;
      }
      failure(request.id, -32602, 'Unknown tool');
      return;
    }
    failure(request.id, -32601, 'Method not found');
  })().catch(error => process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`));
});
