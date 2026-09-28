import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { ConnectionStatus, FeishuOptions, FeishuTransport, InboundMessage, MessageCard } from './types.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;
const COMMAND_NAMES = new Set(['help', 'project', 'session', 'sessions', 'new', 'stop', 'model', 'effort', 'approve', 'reject', 'deny', 'answer', 'status', 'usage', 'notification']);
const MENU_COMMANDS: Record<string, string> = {
  'codex.workbench': '/help', 'codex.project': '/project', 'codex.session': '/session',
  'codex.new': '/new', 'codex.stop': '/stop',
};
type Attachment = { type: 'image' | 'file'; key: string; name?: string };
type NormalizedMessage = { message: InboundMessage; attachment?: Attachment };
type Dependencies = {
  api?: Lark.Client;
  ws?: Pick<Lark.WSClient, 'start' | 'close'>;
};

function boundedHttpClient(): Lark.HttpInstance {
  // Keep the SDK's response interceptors; axios.create() would discard them.
  return new Proxy(Lark.defaultHttpInstance, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof method !== 'function' || !['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].includes(property)) return method;
      return (...args: unknown[]) => {
        const optionsIndex = property === 'request' ? 0 : ['post', 'put', 'patch'].includes(property) ? 2 : 1;
        args[optionsIndex] = { ...(args[optionsIndex] as object | undefined), timeout: 20_000 };
        return Reflect.apply(method, target, args);
      };
    },
  }) as unknown as Lark.HttpInstance;
}

export class FeishuCredentialVerificationError extends Error {
  constructor(message: string, readonly invalid: boolean) { super(message); }
}

export async function verifyFeishuCredentials(appId: string, appSecret: string): Promise<void> {
  const logger: Lark.Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
  const client = new Lark.Client({ appId, appSecret, logger, loggerLevel: Lark.LoggerLevel.warn, httpInstance: boundedHttpClient() });
  let result: Awaited<ReturnType<typeof client.auth.v3.tenantAccessToken.internal>>;
  try {
    result = await client.auth.v3.tenantAccessToken.internal({ data: { app_id: appId, app_secret: appSecret } });
  } catch (error) {
    const code = /\bcode:\s*(\d{4,8})\b/i.exec(formatSdkLog([error], appSecret))?.[1];
    if (code) throw new FeishuCredentialVerificationError(`飞书未接受这组应用凭据（代码 ${code}），请检查 App ID 和 App Secret。`, true);
    throw new FeishuCredentialVerificationError('暂时无法向飞书验证应用凭据，请检查网络后重试。', false);
  }
  const token = result.data?.tenant_access_token || (result as typeof result & { tenant_access_token?: string }).tenant_access_token;
  if (result.code !== 0 || !token) {
    throw new FeishuCredentialVerificationError(`飞书未接受这组应用凭据${typeof result.code === 'number' ? `（代码 ${result.code}）` : ''}，请检查 App ID 和 App Secret。`, true);
  }
}

function redactLogText(value: string, appSecret: string): string {
  let text = appSecret ? value.split(appSecret).join('[redacted]') : value;
  text = text.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]');
  text = text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[redacted]');
  return text.replace(/(\b(?:app_?secret|client_?secret|(?:(?:tenant|app|user)_?)?(?:(?:access|refresh)_?)?token|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, '$1[redacted]');
}

export function formatSdkLog(args: unknown[], appSecret: string): string {
  const seen = new Set<object>();
  const parts: string[] = [];
  let remaining = 64;
  const visit = (value: unknown, depth: number): void => {
    if (remaining-- <= 0 || depth > 6) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(redactLogText(String(value), appSecret).slice(0, 400));
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    // SDK Axios errors may include request/config/response objects. Only inspect
    // these scalar diagnostics; never stringify headers, tokens, or request data.
    for (const name of ['code', 'msg', 'message']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      const field: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
        parts.push(`${name}: ${redactLogText(String(field), appSecret).slice(0, 400)}`);
      }
    }
  };
  visit(args, 0);
  return parts.join(' ').slice(0, 1200) || '[SDK detail omitted]';
}

export function parseMessageEvent(input: unknown): NormalizedMessage | undefined {
  const event = input as Partial<Lark.RawMessageEvent> | undefined;
  if (event?.message?.chat_type !== 'p2p' || event.sender?.sender_type !== 'user') return;
  const actorId = event.sender.sender_id?.open_id;
  const message = event.message;
  if (!actorId || !message.message_id || !message.chat_id) return;
  let content: Record<string, unknown>;
  try { content = JSON.parse(message.content) as Record<string, unknown>; } catch { return; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const base: InboundMessage = { id: message.message_id, chatId: message.chat_id, actorId, text: '' };
  const timestamp = Number(message.create_time);
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15) base.at = new Date(timestamp).toISOString();
  if (message.message_type === 'text' && typeof content.text === 'string') {
    base.text = content.text.trim();
    return base.text ? { message: base } : undefined;
  }
  if (message.message_type === 'image' && typeof content.image_key === 'string' && content.image_key.trim()) {
    base.text = '请查看这张图片';
    return { message: base, attachment: { type: 'image', key: content.image_key } };
  }
  if (message.message_type === 'file' && typeof content.file_key === 'string' && content.file_key.trim()) {
    const name = typeof content.file_name === 'string' ? content.file_name : 'attachment';
    base.text = `请查看附件：${safeFilename(name)}`;
    return { message: base, attachment: { type: 'file', key: content.file_key, name } };
  }
}

export function safeFilename(name: string): string {
  const basename = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = basename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(-100);
  if (!clean || /^\.+$/.test(clean)) return 'attachment';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

export function splitText(text: string, maxBytes = 12000): string[] {
  if (maxBytes < 4) throw new Error('Message byte limit must be at least 4');
  const result: string[] = [];
  let part = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) { result.push(part); part = ''; bytes = 0; }
    part += char;
    bytes += size;
  }
  if (part) result.push(part);
  return result;
}

export function renderMarkdown(text: string): string {
  // Feishu card markdown has no GFM table support. Preserve cells and links as rows.
  const lines = text.split('\n');
  const rendered: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) inFence = !inFence;
    const next = lines[index + 1];
    if (!inFence && line.includes('|') && next && /^\s*\|?\s*:?-{3,}:?\s*\|[\s|:\-]*$/.test(next)) {
      const headers = tableCells(line);
      index++;
      while (index + 1 < lines.length && lines[index + 1]!.trim().startsWith('|')) {
        const cells = tableCells(lines[++index]!);
        rendered.push(cells.map((cell, column) => `${headers[column] ?? ''}：${cell}`).join('\n'), '');
      }
    } else rendered.push(line);
  }
  return rendered.join('\n');
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

export function isAllowedCommand(command: unknown): command is string {
  if (typeof command !== 'string' || command.length > 4096 || /[\r\n\x00]/.test(command)) return false;
  const match = /^\/([a-z]+)(?:\s|$)/.exec(command);
  return !!match && COMMAND_NAMES.has(match[1]!);
}

export function actionSignature(secret: string, chatId: string, command: string): string {
  return createHmac('sha256', secret).update(`feishu-codex:v1\n${chatId}\n${command}`).digest('hex');
}

export function parseCardEvent(raw: Lark.RawCardActionEvent, secret: string): InboundMessage | undefined {
  if (!raw || typeof raw !== 'object') return;
  const event = Lark.normalizeCardAction(raw);
  if (!event || !event.action.value || typeof event.action.value !== 'object') return;
  const value = event.action.value as Record<string, unknown>;
  if (!isAllowedCommand(value.command) || typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature)) return;
  const expected = actionSignature(secret, event.chatId, value.command);
  if (!timingSafeEqual(Buffer.from(value.signature), Buffer.from(expected))) return;
  const identity = raw.token || createHash('sha256').update(`${event.messageId}\n${event.operator.openId}\n${value.command}`).digest('hex');
  return {
    id: `card:${identity}`, chatId: event.chatId, actorId: event.operator.openId,
    text: value.command, actionMessageId: event.messageId,
  };
}

export function renderCard(card: MessageCard, chatId: string, secret: string): object {
  const elements: object[] = [{ tag: 'markdown', content: renderMarkdown(card.text || ' ') }];
  const buttons = (card.buttons ?? []).filter(button => isAllowedCommand(button.command));
  // At most five buttons per action row, as required by the Feishu card schema.
  for (let index = 0; index < buttons.length; index += 5) {
    elements.push({ tag: 'action', actions: buttons.slice(index, index + 5).map(button => ({
      tag: 'button', text: { tag: 'plain_text', content: button.label }, type: button.primary ? 'primary' : 'default',
      value: { command: button.command, signature: actionSignature(secret, chatId, button.command) },
    })) });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: card.tone ?? 'blue', title: { tag: 'plain_text', content: card.title } },
    elements,
  };
}

export class FeishuClient implements FeishuTransport {
  private readonly api: Lark.Client;
  private readonly ws: Pick<Lark.WSClient, 'start' | 'close'>;
  private readonly logger: Lark.Logger;
  private active = false;
  private closed = false;
  private readonly cardChats = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly reactionCleanups = new Set<() => Promise<void>>();

  constructor(private readonly options: FeishuOptions, dependencies: Dependencies = {}) {
    this.logger = {
      error: (...args: unknown[]) => this.sdkLog('error', args),
      warn: (...args: unknown[]) => this.sdkLog('warn', args),
      info: () => {}, debug: () => {}, trace: () => {},
    };
    const config = { appId: options.appId, appSecret: options.appSecret, logger: this.logger, loggerLevel: Lark.LoggerLevel.warn, httpInstance: boundedHttpClient() };
    this.api = dependencies.api ?? new Lark.Client(config);
    this.ws = dependencies.ws ?? new Lark.WSClient({
      ...config, autoReconnect: true, handshakeTimeoutMs: 15000, wsConfig: { pingTimeout: 30 },
      onReady: () => this.setStatus('connected', '飞书长连接已建立'),
      onReconnected: () => this.setStatus('connected', '飞书长连接已恢复'),
      onReconnecting: () => this.setStatus('connecting', '连接中断，正在自动重连'),
      onError: error => this.setStatus('error', this.errorText(error)),
    });
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!/^cli_[\da-f]{16}$/i.test(this.options.appId) || !this.options.appSecret.trim()) {
      this.options.onStatus('error', '请填写有效的飞书 App ID 和 App Secret');
      throw new Error('Invalid Feishu app credentials');
    }
    this.closed = false;
    this.active = true;
    this.setStatus('connecting', '正在建立飞书长连接');
    const dispatcher = new Lark.EventDispatcher({ logger: this.logger, loggerLevel: Lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': event => {
        const normalized = parseMessageEvent(event);
        if (normalized) this.dispatch(() => this.receive(normalized));
      },
      'card.action.trigger': (raw: Lark.RawCardActionEvent) => {
        const message = parseCardEvent(raw, this.options.appSecret);
        if (!message) return;
        this.cardChats.set(message.actionMessageId!, message.chatId);
        this.dispatch(() => this.options.onMessage(message));
        return { toast: { type: 'info', content: '已收到操作' } };
      },
      'application.bot.menu_v6': event => {
        const command = event.event_key && MENU_COMMANDS[event.event_key];
        const actorId = event.operator?.operator_id?.open_id;
        if (!command || !actorId) return;
        this.dispatch(() => this.options.onMessage({
          id: `menu:${event.event_id ?? event.uuid ?? randomUUID()}`, actorId, chatId: actorId, text: command,
        }));
      },
    });
    try { await this.ws.start({ eventDispatcher: dispatcher }); }
    catch (error) { this.setStatus('error', this.errorText(error)); this.active = false; throw error; }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.active = false;
    this.ws.close({ force: true });
    await Promise.allSettled([...this.reactionCleanups].map(cleanup => cleanup()));
    this.options.onStatus('stopped', '飞书连接已停止');
  }

  async sendText(chatId: string, text: string): Promise<string> {
    let messageId = '';
    for (const part of splitText(text || '（无文本内容）')) {
      const result = await this.api.im.v1.message.create({
        params: { receive_id_type: recipientType(chatId) },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: part }) },
      });
      this.checkResult(result, '发送消息');
      if (!result.data?.message_id) throw new Error('Feishu send response is missing message_id');
      messageId = result.data.message_id;
    }
    return messageId;
  }

  async sendCard(chatId: string, card: MessageCard): Promise<string> {
    const result = await this.api.im.v1.message.create({
      params: { receive_id_type: recipientType(chatId) },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(renderCard(card, chatId, this.options.appSecret)) },
    });
    this.checkResult(result, '发送卡片');
    if (!result.data?.message_id) throw new Error('Feishu send response is missing message_id');
    // A native menu addresses a person by open_id; callbacks carry the actual chat_id.
    // Rebind signatures immediately when the API returns that canonical chat id.
    const canonicalChatId = result.data.chat_id ?? chatId;
    this.cardChats.set(result.data.message_id, canonicalChatId);
    if (canonicalChatId !== chatId && card.buttons?.length) await this.updateCard(result.data.message_id, card);
    if (this.cardChats.size > 2000) this.cardChats.delete(this.cardChats.keys().next().value!);
    return result.data.message_id;
  }

  async sendImage(chatId: string, imagePath: string): Promise<string> {
    const info = await stat(imagePath);
    if (!info.isFile() || info.size <= 0) throw new Error('图片文件为空或不可用');
    if (info.size > MAX_OUTBOUND_IMAGE_BYTES) throw new Error('图片超过飞书 10 MB 上限');
    const uploaded = await this.api.im.v1.image.create({
      data: { image_type: 'message', image: await readFile(imagePath) },
    });
    const imageKey = uploaded?.image_key;
    if (!imageKey) throw new Error('飞书上传图片未返回 image_key');
    const result = await this.api.im.v1.message.create({
      params: { receive_id_type: recipientType(chatId) },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    });
    this.checkResult(result, '发送图片');
    if (!result.data?.message_id) throw new Error('Feishu image response is missing message_id');
    return result.data.message_id;
  }

  async sendFile(chatId: string, filePath: string): Promise<string> {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) throw new Error('文件为空或不可用');
    if (info.size > MAX_OUTBOUND_FILE_BYTES) throw new Error('文件超过飞书 30 MB 上限');
    const uploaded = await this.api.im.v1.file.create({
      data: { file_type: 'stream', file_name: path.basename(filePath), file: await readFile(filePath) },
    });
    const fileKey = uploaded?.file_key;
    if (!fileKey) throw new Error('飞书上传文件未返回 file_key');
    const result = await this.api.im.v1.message.create({
      params: { receive_id_type: recipientType(chatId) },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    });
    this.checkResult(result, '发送文件');
    if (!result.data?.message_id) throw new Error('Feishu file response is missing message_id');
    return result.data.message_id;
  }

  async updateCard(messageId: string, card: MessageCard): Promise<void> {
    const chatId = this.cardChats.get(messageId);
    if (!chatId && card.buttons?.length) throw new Error('Unknown card destination; cannot sign interactive actions');
    const result = await this.api.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(renderCard(card, chatId ?? '', this.options.appSecret)) },
    });
    this.checkResult(result, '更新卡片');
  }

  async startTyping(messageId: string): Promise<() => Promise<void>> {
    let reactionId: string | undefined;
    try {
      const result = await this.api.im.v1.messageReaction.create({
        path: { message_id: messageId }, data: { reaction_type: { emoji_type: 'Typing' } },
      });
      this.checkResult(result, '添加处理表情');
      reactionId = result.data?.reaction_id;
    } catch (error) { this.options.log('warn', `处理表情不可用：${this.errorText(error)}`); }
    let cleared = false;
    const cleanup = async (): Promise<void> => {
      if (cleared) return;
      cleared = true;
      this.reactionCleanups.delete(cleanup);
      if (!reactionId) return;
      try {
        const result = await this.api.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
        this.checkResult(result, '移除处理表情');
      } catch (error) { this.options.log('warn', `清理处理表情失败：${this.errorText(error)}`); }
    };
    if (reactionId) this.reactionCleanups.add(cleanup);
    if (this.closed) await cleanup();
    return cleanup;
  }

  private dispatch(work: () => Promise<void>): void {
    if (!this.active) return;
    // Return to the SDK immediately: Feishu retries events whose ACK waits for Codex.
    const pending = Promise.resolve().then(() => this.active ? work() : undefined).catch(error => {
      this.options.log('error', `飞书消息处理失败：${this.errorText(error)}`);
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  private async receive(normalized: NormalizedMessage): Promise<void> {
    const { message, attachment } = normalized;
    if (attachment && (this.options.allowAttachments?.(message.actorId) ?? true)) {
      try {
        const file = await this.download(message.id, attachment);
        if (attachment.type === 'image') message.images = [file];
        else message.files = [file];
      } catch (error) {
        this.options.log('warn', `附件下载失败：${this.errorText(error)}`);
        await this.sendText(message.chatId, `附件未能接收：${this.errorText(error)}。请重新发送，单个附件上限为 20 MB。`);
        return;
      }
    }
    if (this.active) await this.options.onMessage(message);
  }

  private async download(messageId: string, attachment: Attachment): Promise<string> {
    const resource = await this.api.im.v1.messageResource.get({
      params: { type: attachment.type }, path: { message_id: messageId, file_key: attachment.key },
    });
    const length = Number(resource.headers?.['content-length']);
    if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) {
      resource.getReadableStream().destroy();
      throw new Error('文件超过 20 MB');
    }
    const mediaType = String(resource.headers?.['content-type'] ?? '').split(';')[0];
    const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[mediaType!] ?? '.png';
    const name = attachment.type === 'image' ? `image${extension}` : safeFilename(attachment.name ?? 'attachment');
    const prefix = createHash('sha256').update(`${messageId}\n${attachment.key}`).digest('hex').slice(0, 20);
    const directory = path.resolve(this.options.attachmentDir);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${prefix}-${name}`);
    const temporary = path.join(directory, `${prefix}-${randomUUID()}.part`);
    let bytes = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_ATTACHMENT_BYTES ? new Error('文件超过 20 MB') : null, chunk);
    } });
    try {
      await pipeline(resource.getReadableStream(), limiter, createWriteStream(temporary, { flags: 'wx' }), { signal: AbortSignal.timeout(60_000) });
      if (!bytes) throw new Error('附件内容为空');
      await rename(temporary, target);
      return target;
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private checkResult(result: { code?: number; msg?: string } | undefined, operation: string): void {
    if (!result || (result.code !== undefined && result.code !== 0)) {
      throw new Error(`${operation}失败（飞书错误码 ${result?.code ?? 'unknown'}）：${this.errorText(result?.msg ?? '空响应')}`);
    }
  }

  private setStatus(status: ConnectionStatus, detail: string): void {
    if (!this.active) return;
    this.options.onStatus(status, detail);
  }

  private sdkLog(level: 'warn' | 'error', args: unknown[]): void {
    this.options.log(level, `飞书 SDK：${formatSdkLog(args, this.options.appSecret)}`);
  }

  private errorText(error: unknown): string {
    return redactLogText(error instanceof Error ? error.message : String(error), this.options.appSecret).slice(0, 400);
  }
}

function recipientType(id: string): 'chat_id' | 'open_id' | 'user_id' {
  return id.startsWith('oc_') ? 'chat_id' : id.startsWith('ou_') ? 'open_id' : 'user_id';
}
