import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { FeishuTransport } from './types.js';
import { MESSAGE_SEND_TIMEOUT_MS, MessageSendError, validateMessageRequest, type MessageDelivery, type MessageResult } from './message-request.js';

/** Each engine uses its own pinned private destination; never cross engine boundaries. */
export class DefaultMessageSender {
  private readonly pending = new Map<string, Promise<MessageResult>>();
  private readonly stop = new AbortController();
  constructor(private readonly store: Store, private readonly transport: FeishuTransport, private readonly timeoutMs = MESSAGE_SEND_TIMEOUT_MS) {}
  async close(): Promise<void> { this.stop.abort(); await Promise.allSettled([...this.pending.values()]); }
  hasPending(): boolean { return this.pending.size > 0; }
  private destination(engine: 'codex' | 'hermes') {
    const label = engine === 'hermes' ? 'Hermes' : 'Codex';
    const selected = engine === 'hermes' ? this.store.config.hermesNotificationTarget : this.store.config.desktopNotificationTarget;
    if (!selected) throw new MessageSendError('no_default', `请先在机器人设置中选择 ${label} 默认通知机器人及接收私聊。`, 409);
    const target = this.store.notificationTargets(this.store.config, engine).find(item =>
      item.chatId === selected.chatId && item.actorId === selected.actorId && item.botAppId === selected.botAppId);
    if (!target) throw new MessageSendError('invalid_default', `${label} 默认通知接收位置已失效，请重新选择；消息未发送。`, 409);
    const bot = this.store.bot(target.botId);
    if (!bot?.enabled || this.transport.isAvailable?.(target.chatId) === false) throw new MessageSendError('disconnected', `${label} 默认通知机器人的飞书连接未就绪，请在应用中检查连接。`, 503);
    return target;
  }
  async send(value: unknown, signal?: AbortSignal, engine: 'codex' | 'hermes' = 'codex'): Promise<MessageResult> {
    const request = validateMessageRequest(value);
    const key = createHash('sha256').update(request.request_id).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([request.text, request.title ?? ''])).digest('hex');
    const existing = this.store.state.messageSends[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new MessageSendError('request_conflict', '该请求编号已用于不同内容，请勿复用。', 409);
      const inFlight = this.pending.get(key);
      if (inFlight) return { ...await inFlight, deduplicated: true };
      if (existing.status === 'sent' && existing.messageId) return this.result(request.request_id, existing, true);
      throw new MessageSendError('uncertain', '这次发送的结果尚未确认，已阻止重复发送。请先核对飞书，不要换编号、换工具补发。', 409);
    }
    if (this.stop.signal.aborted || signal?.aborted) throw new MessageSendError('cancelled', '发送已取消，消息未提交。', 409);
    const target = this.destination(engine);
    const delivery: MessageDelivery = { fingerprint, status: 'sending', at: new Date().toISOString(), botName: target.botName,
      chatId: target.chatId, actorId: target.actorId, botAppId: target.botAppId };
    // Persist the claim before the network call; restart cannot safely retry an unacknowledged send.
    this.store.state.messageSends[key] = delivery;
    try { this.store.save(); } catch (error) { delete this.store.state.messageSends[key]; throw error; }
    const sendSignal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const canSend = () => {
      if (sendSignal.aborted) return false;
      try { const current = this.destination(engine); return current.chatId === target.chatId && current.actorId === target.actorId && current.botAppId === target.botAppId; }
      catch { return false; }
    };
    const operation = (async () => {
      let abort!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Message send interrupted')); sendSignal.addEventListener('abort', abort, { once: true }); if (sendSignal.aborted) abort(); });
      try {
        if (!canSend()) throw new Error('Destination changed before send');
        const messageId = await Promise.race([this.transport.sendCard(target.chatId, { title: request.title || '消息', text: request.text }, { signal: sendSignal, canSend }), interrupted]);
        if (!messageId?.trim()) throw new Error('Send did not return a message identity');
        delivery.status = 'sent'; delivery.messageId = messageId;
        this.store.save();
        this.store.log('info', `主动消息已发送 · ${target.botName}`);
        return this.result(request.request_id, delivery, false);
      } catch {
        delivery.status = 'uncertain';
        this.store.save();
        throw new MessageSendError('uncertain', '飞书未确认本次发送结果，可能已经送达。请先核对飞书，不要重复发送或改用 CLI 补发。', 502);
      } finally { sendSignal.removeEventListener('abort', abort); }
    })();
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }
  private result(requestId: string, delivery: MessageDelivery, deduplicated: boolean): MessageResult {
    return { status: 'sent', request_id: requestId, botName: delivery.botName, messageId: delivery.messageId!, deduplicated };
  }
}
