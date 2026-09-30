import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { ConnectionStatus, FeishuOptions, FeishuSendOptions, FeishuTransport, InboundMessage, MessageCard } from './types.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;
const MAX_QUOTED_TEXT = 12_000;
const MAX_POST_ATTACHMENTS = 8;
const COMMAND_NAMES = new Set(['help', 'project', 'session', 'sessions', 'new', 'stop', 'model', 'effort', 'approve', 'reject', 'deny', 'answer', 'status', 'usage', 'notification']);
const MULTI_MENTION_COMMANDS = new Set(['new', 'status', 'stop', 'session']);
const MENU_COMMANDS: Record<string, string> = {
  'codex.workbench': '/help', 'codex.project': '/project', 'codex.session': '/session',
  'codex.new': '/new', 'codex.stop': '/stop',
};
type Attachment = { type: 'image' | 'file'; key: string; name?: string };
type NormalizedMessage = { message: InboundMessage; attachment?: Attachment; attachments?: Attachment[]; observation?: boolean };
type MessageParsingOptions = { botOpenId?: string; observeGroup?: boolean };
type Dependencies = {
  api?: Lark.Client;
  ws?: Pick<Lark.WSClient, 'start' | 'close'>;
  retryDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

// Generated SDK methods do not forward a signal; retain per-call options across token lookup.
const outboundContext = new AsyncLocalStorage<FeishuSendOptions>();

function assertMaySend(options?: FeishuSendOptions): void {
  options?.signal?.throwIfAborted();
  if (options?.canSend && !options.canSend()) throw new Error('消息发送已取消或授权已变化');
}

function boundedHttpClient(): Lark.HttpInstance {
  // Keep the SDK's response interceptors; axios.create() would discard them.
  return new Proxy(Lark.defaultHttpInstance, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof method !== 'function' || !['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].includes(property)) return method;
      return (...args: unknown[]) => {
        const publication = outboundContext.getStore();
        assertMaySend(publication);
        const optionsIndex = property === 'request' ? 0 : ['post', 'put', 'patch'].includes(property) ? 2 : 1;
        args[optionsIndex] = { ...(args[optionsIndex] as object | undefined), timeout: 20_000,
          ...(publication?.signal ? { signal: publication.signal } : {}) };
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

export function parseMessageEvent(input: unknown, options: MessageParsingOptions = {}): NormalizedMessage | undefined {
  const event = input as Partial<Lark.RawMessageEvent> | undefined;
  if (!event?.message || !['p2p', 'group'].includes(event.message.chat_type) || event.sender?.sender_type !== 'user') return;
  const actorId = event.sender.sender_id?.open_id;
  const message = event.message;
  if (!actorId || !message.message_id || !message.chat_id) return;
  const isGroup = message.chat_type === 'group';
  // Group delivery must never turn into reply-all when bot identity is unavailable.
  if (isGroup && !options.botOpenId) return;
  const mentioned = !!options.botOpenId && (message.mentions ?? []).some(mention => mention.id?.open_id === options.botOpenId);
  const observation = isGroup && !mentioned;
  if (observation && !options.observeGroup) return;
  if (observation && !['text', 'post'].includes(message.message_type)) return;
  let content: Record<string, unknown>;
  try { content = JSON.parse(message.content) as Record<string, unknown>; } catch { return; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const base: InboundMessage = { id: message.message_id, chatId: message.chat_id, actorId, text: '', chatType: message.chat_type };
  // Identity links come only from the authenticated event envelope, never from
  // message text or quoted content supplied by a participant.
  const actorUnionId = event.sender.sender_id?.union_id;
  const actorUserId = event.sender.sender_id?.user_id;
  const actorTenantKey = event.sender.tenant_key;
  if (typeof actorUnionId === 'string' && actorUnionId.trim()) base.actorUnionId = actorUnionId.trim();
  if (typeof actorUserId === 'string' && actorUserId.trim()) base.actorUserId = actorUserId.trim();
  if (typeof actorTenantKey === 'string' && actorTenantKey.trim()) base.actorTenantKey = actorTenantKey.trim();
  if (message.parent_id) base.replyTo = message.parent_id;
  const senderName = (event.sender as typeof event.sender & { name?: unknown }).name;
  if (typeof senderName === 'string' && senderName.trim()) base.senderName = senderName.trim().slice(0, 100);
  const timestamp = Number(message.create_time);
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15) base.at = new Date(timestamp).toISOString();
  if (message.message_type === 'text' && typeof content.text === 'string') {
    let body = content.text;
    for (const mention of [...(message.mentions ?? [])].sort((a, b) => b.key.length - a.key.length)) {
      if (mention.key) body = body.split(mention.key).join('');
    }
    if (isGroup && mentioned && !body.trim()) return { message: { ...base, mentionOnly: true } };
    base.text = (isGroup && mentioned ? groupCommandAfterMentions(content.text, message.mentions) : undefined)
      ?? replaceMentionKeys(content.text, message.mentions, observation ? undefined : options.botOpenId).trim();
    return base.text ? { message: base, ...(observation ? { observation: true } : {}) } : undefined;
  }
  if (message.message_type === 'post') {
    const post = normalizePost(content);
    if (!post) return;
    const attachments: Attachment[] = [];
    let hasContent = Boolean(stringField(post.title).trim());
    const rows = Array.isArray(post.content) ? post.content : [];
    const lines = rows.filter(Array.isArray).map(row => row.map((raw: unknown) => {
      const node = record(raw);
      if (!node) return '';
      if (node.tag === 'text' || node.tag === 'md') {
        const text = replaceMentionKeys(stringField(node.text), message.mentions, options.botOpenId);
        if (text.trim()) hasContent = true;
        return stringField(node.text);
      }
      if (node.tag === 'a') {
        if (stringField(node.text).trim() || stringField(node.href).trim()) hasContent = true;
        return `${stringField(node.text)}${typeof node.href === 'string' ? ` (${node.href})` : ''}`;
      }
      if (node.tag === 'at') {
        const id = stringField(node.user_id);
        const mention = message.mentions?.find(item => item.key === id || item.id?.open_id === id);
        if (!observation && options.botOpenId && (id === options.botOpenId || mention?.id?.open_id === options.botOpenId)) return '';
        return `@${mention?.name || stringField(node.user_name) || id}`;
      }
      if (node.tag === 'img' && typeof node.image_key === 'string' && node.image_key.trim()) {
        attachments.push({ type: 'image', key: node.image_key });
        return observation ? '[图片]' : '';
      }
      if (node.tag === 'file' && typeof node.file_key === 'string' && node.file_key.trim()) {
        attachments.push({ type: 'file', key: node.file_key, name: stringField(node.file_name) || 'attachment' });
        return observation ? `[附件：${safeFilename(stringField(node.file_name) || 'attachment')}]` : '';
      }
      return '';
    }).join(''));
    if (isGroup && mentioned && !hasContent && !attachments.length) return { message: { ...base, mentionOnly: true } };
    base.text = replaceMentionKeys([stringField(post.title), ...lines].filter(Boolean).join('\n'), message.mentions, observation ? undefined : options.botOpenId).trim();
    if (!base.text && attachments.length && !observation) base.text = '请查看附件';
    if (!base.text) return;
    return { message: base, ...(observation ? { observation: true } : { attachments: attachments.slice(0, MAX_POST_ATTACHMENTS) }) };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string { return typeof value === 'string' ? value : ''; }

function normalizePost(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Array.isArray(content.content)) return content;
  return record(content.zh_cn) ?? record(content.en_us) ?? Object.values(content).map(record).find(value => Array.isArray(value?.content));
}

function replaceMentionKeys(text: string, mentions: Lark.RawMessageEvent['message']['mentions'], botOpenId?: string): string {
  // Replace longer keys first: @_user_1 must not corrupt @_user_10.
  for (const mention of [...(mentions ?? [])].sort((a, b) => b.key.length - a.key.length)) {
    if (!mention.key) continue;
    const label = botOpenId && mention.id?.open_id === botOpenId ? '' : `@${mention.name || mention.id?.open_id || '用户'}`;
    text = text.split(mention.key).join(label);
  }
  return text;
}

function groupCommandAfterMentions(text: string, mentions: Lark.RawMessageEvent['message']['mentions']): string | undefined {
  let remainder = text.trim();
  const keys = (mentions ?? []).map(mention => mention.key).filter(Boolean).sort((a, b) => b.length - a.length);
  let removed = 0;
  while (true) {
    const key = keys.find(value => remainder.startsWith(value) && /^\s/.test(remainder.slice(value.length, value.length + 1)));
    if (!key) break;
    remainder = remainder.slice(key.length).trimStart();
    removed++;
  }
  const command = /^\/([a-z]+)$/i.exec(remainder)?.[1]?.toLowerCase();
  return removed > 0 && command && MULTI_MENTION_COMMANDS.has(command) ? `/${command}` : undefined;
}

export function quotedMessageText(type: string, rawContent: string): string | undefined {
  let content: Record<string, unknown> | undefined;
  try { content = record(JSON.parse(rawContent)); } catch { return; }
  if (!content) return;
  if (type === 'text') return stringField(content.text).trim().slice(0, MAX_QUOTED_TEXT) || undefined;
  if (type !== 'post' && type !== 'interactive') return;
  const parts: string[] = [];
  let budget = 400;
  const visit = (value: unknown, depth = 0): void => {
    if (budget-- <= 0 || depth > 10) return;
    if (typeof value === 'string') { parts.push(value); return; }
    if (Array.isArray(value)) { for (const node of value) visit(node, depth + 1); return; }
    const node = record(value);
    if (!node || ['action', 'button', 'img', 'image'].includes(stringField(node.tag))) return;
    // Read display text only, never card action values or unrelated metadata.
    for (const key of ['title', 'header', 'body', 'elements', 'fields', 'text', 'content']) {
      if (node[key] !== undefined) visit(node[key], depth + 1);
    }
  };
  visit(type === 'post' ? normalizePost(content) : content);
  return parts.join('\n').trim().slice(0, MAX_QUOTED_TEXT) || undefined;
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
  if (card.mention) {
    if (typeof card.mention.openId !== 'string' || !/^ou_[a-zA-Z0-9_-]{1,180}$/.test(card.mention.openId)) {
      throw new Error('卡片提及对象的 open_id 无效');
    }
    elements.unshift({ tag: 'markdown', content: `<at id=${card.mention.openId}></at>` });
  }
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
  private retryStop = new AbortController();
  private readonly retryDelay: NonNullable<Dependencies['retryDelay']>;
  private botOpenId?: string;
  private identityAttemptAt = 0;
  private identityPending?: Promise<void>;

  constructor(private readonly options: FeishuOptions, dependencies: Dependencies = {}) {
    this.retryDelay = dependencies.retryDelay ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
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
    if (this.retryStop.signal.aborted) this.retryStop = new AbortController();
    this.active = true;
    this.setStatus('connecting', '正在建立飞书长连接');
    if (this.options.allowGroup || this.options.onGroupMessage || this.options.onBotIdentity) await this.resolveBotIdentity();
    if (!this.active) return;
    const dispatcher = new Lark.EventDispatcher({ logger: this.logger, loggerLevel: Lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': event => {
        if (event.message?.chat_type === 'group') {
          this.dispatch(() => this.receiveGroup(event));
          return;
        }
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
    this.retryStop.abort();
    this.active = false;
    this.ws.close({ force: true });
    await Promise.allSettled([...this.reactionCleanups].map(cleanup => cleanup()));
    this.options.onStatus('stopped', '飞书连接已停止');
  }

  async sendText(chatId: string, text: string): Promise<string> {
    let messageId = '';
    for (const part of splitText(text || '（无文本内容）')) {
      const result = await this.createMessage(chatId, 'text', JSON.stringify({ text: part }), '发送消息');
      messageId = result.message_id;
    }
    return messageId;
  }

  async sendCard(chatId: string, card: MessageCard, options?: FeishuSendOptions): Promise<string> {
    const result = await this.createMessage(chatId, 'interactive', JSON.stringify(renderCard(card, chatId, this.options.appSecret)), '发送卡片', options);
    // A native menu addresses a person by open_id; callbacks carry the actual chat_id.
    // Rebind signatures immediately when the API returns that canonical chat id.
    const canonicalChatId = result.chat_id ?? chatId;
    this.cardChats.set(result.message_id, canonicalChatId);
    if (canonicalChatId !== chatId && card.buttons?.length) await this.updateCard(result.message_id, card, options);
    if (this.cardChats.size > 2000) this.cardChats.delete(this.cardChats.keys().next().value!);
    return result.message_id;
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
    const result = await this.createMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }), '发送图片');
    return result.message_id;
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
    const result = await this.createMessage(chatId, 'file', JSON.stringify({ file_key: fileKey }), '发送文件');
    return result.message_id;
  }

  async updateCard(messageId: string, card: MessageCard, options?: FeishuSendOptions): Promise<void> {
    const chatId = this.cardChats.get(messageId);
    if (!chatId && card.buttons?.length) throw new Error('Unknown card destination; cannot sign interactive actions');
    await this.retryTransient(() => this.api.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(renderCard(card, chatId ?? '', this.options.appSecret)) },
    }), '更新卡片', options);
  }

  async recallCard(messageId: string): Promise<void> {
    const result = await this.api.im.v1.message.delete({ path: { message_id: messageId } });
    this.checkResult(result, '撤回卡片');
    this.cardChats.delete(messageId);
  }

  async markCompleted(messageId: string): Promise<void> {
    const result = await this.api.im.v1.messageReaction.create({
      path: { message_id: messageId }, data: { reaction_type: { emoji_type: 'DONE' } },
    });
    this.checkResult(result, '添加完成表情');
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
    let cleanupPending: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (cleared || !reactionId) return Promise.resolve();
      if (cleanupPending) return cleanupPending;
      cleanupPending = this.retryTransient(() => this.api.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId! } }), '移除处理表情')
        .then(() => {
          cleared = true;
          this.reactionCleanups.delete(cleanup);
        })
        .catch(error => this.options.log('warn', `清理处理表情失败，表情可能仍保留：${this.errorText(error)}`))
        .finally(() => { cleanupPending = undefined; });
      return cleanupPending;
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
    const authorized = (message.chatType !== 'group' || this.options.allowGroup?.(message.chatId) === true)
      && (this.options.allowAttachments?.(message.actorId, message.chatId, message.chatType) ?? (message.chatType !== 'group'));
    const attachments = [...(attachment ? [attachment] : []), ...(normalized.attachments ?? [])];
    if (attachments.length && authorized) {
      try {
        for (const item of attachments) {
          const file = await this.download(message.id, item);
          if (item.type === 'image') (message.images ??= []).push(file);
          else (message.files ??= []).push(file);
        }
      } catch (error) {
        this.options.log('warn', `附件下载失败：${this.errorText(error)}`);
        await this.sendText(message.chatId, `附件未能接收：${this.errorText(error)}。请重新发送，单个附件上限为 20 MB。`);
        return;
      }
    }
    if (authorized && message.replyTo && this.active) {
      message.quotedText = await this.readQuotedMessage(message.replyTo, message.chatId);
    }
    if (this.active) await this.options.onMessage(message);
  }

  private async resolveBotIdentity(): Promise<void> {
    if (this.botOpenId) return;
    if (this.identityPending) return this.identityPending;
    if (Date.now() - this.identityAttemptAt < 60_000) return;
    this.identityAttemptAt = Date.now();
    this.identityPending = (async () => {
      try {
        const response = await this.api.request<{ code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } }>({
          url: '/open-apis/bot/v3/info', method: 'GET',
        });
        this.checkResult(response, '识别机器人');
        if (!response.bot?.open_id?.startsWith('ou_')) throw new Error('飞书未返回机器人 open_id');
        this.botOpenId = response.bot.open_id;
        if (this.active) {
          try { this.options.onBotIdentity?.({ openId: this.botOpenId, name: stringField(response.bot.app_name).trim() }); }
          catch (error) { this.options.log('warn', `机器人身份信息同步失败：${this.errorText(error)}`); }
        }
      } catch (error) {
        this.options.log('warn', `机器人身份暂未确认，群聊暂不响应，私聊不受影响：${this.errorText(error)}`);
      }
    })().finally(() => { this.identityPending = undefined; });
    return this.identityPending;
  }

  private async receiveGroup(input: unknown): Promise<void> {
    const event = input as Partial<Lark.RawMessageEvent>;
    if (!event.message || event.sender?.sender_type !== 'user' || (!this.options.allowGroup && !this.options.onGroupMessage)) return;
    await this.resolveBotIdentity();
    if (!this.active) return;
    const observedGroup = this.options.allowGroup?.(event.message.chat_id) ?? false;
    const normalized = parseMessageEvent(event, { botOpenId: this.botOpenId, observeGroup: observedGroup });
    if (!normalized) return;
    if (normalized.observation) {
      const message = normalized.message;
      if (observedGroup && this.options.allowAttachments?.(message.actorId, message.chatId, 'group')) {
        await this.options.onGroupMessage?.(message);
      }
      return;
    }
    await this.receive(normalized);
  }

  private async readQuotedMessage(messageId: string, chatId: string): Promise<string | undefined> {
    try {
      const response = await this.api.im.v1.message.get({ path: { message_id: messageId } });
      this.checkResult(response, '读取引用消息');
      // Fail closed: knowing an ID is not permission to import another conversation.
      const item = response.data?.items?.find(item => item.message_id === messageId && item.chat_id === chatId);
      if (!item?.body?.content || !item.msg_type || item.deleted) return;
      return quotedMessageText(item.msg_type, item.body.content);
    } catch (error) {
      this.options.log('warn', `引用消息暂时不可读取：${this.errorText(error)}`);
      return;
    }
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
      throw Object.assign(new Error(`${operation}失败（飞书错误码 ${result?.code ?? 'unknown'}）：${this.errorText(result?.msg ?? '空响应')}`), { code: result?.code });
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

  private async createMessage(chatId: string, type: string, content: string, operation: string, options?: FeishuSendOptions): Promise<{ message_id: string; chat_id?: string }> {
    // Feishu deduplicates create requests with the same UUID for one hour. Keep
    // one UUID per logical message (including each text chunk), never per retry.
    const uuid = randomUUID();
    const result = await this.retryTransient(() => this.api.im.v1.message.create({
      params: { receive_id_type: recipientType(chatId) },
      data: { receive_id: chatId, msg_type: type, content, uuid },
    }), operation, options);
    if (!result.data?.message_id) throw new Error('Feishu send response is missing message_id');
    return { message_id: result.data.message_id, chat_id: result.data.chat_id };
  }

  private async retryTransient<T extends { code?: number; msg?: string } | undefined>(request: () => Promise<T>, operation: string, options?: FeishuSendOptions): Promise<T> {
    const signal = options?.signal ? AbortSignal.any([options.signal, this.retryStop.signal]) : this.retryStop.signal;
    const publication = options ? { ...options, signal } : undefined;
    for (let attempt = 0; ; attempt++) {
      assertMaySend(publication);
      try {
        const result = await (publication ? outboundContext.run(publication, request) : request());
        this.checkResult(result, operation);
        return result;
      }
      catch (error) {
        // Each HTTP attempt already has a 20-second timeout. Shutdown cancels
        // backoff and prevents new attempts, including reaction cleanup retries.
        if (attempt >= 2 || this.closed || signal.aborted || options?.canSend?.() === false || !isTransientFailure(error)) throw error;
        try { await this.retryDelay(attempt === 0 ? 300 : 900, signal); }
        catch { throw error; }
        if (this.closed || signal.aborted) throw error;
      }
    }
  }
}

function recipientType(id: string): 'chat_id' | 'open_id' | 'user_id' {
  return id.startsWith('oc_') ? 'chat_id' : id.startsWith('ou_') ? 'open_id' : 'user_id';
}

function isTransientFailure(error: unknown): boolean {
  const details = record(error);
  if (!details) return false;
  // Feishu also reports application rate limits as HTTP 400 / code 99991400.
  if (details.code === 99991400 || record(record(details.response)?.data)?.code === 99991400) return true;
  const status = record(details.response)?.status ?? details.status;
  if (typeof status === 'number') return status === 429 || (status >= 500 && status <= 599);
  return typeof details.code === 'string' && [
    'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  ].includes(details.code);
}
