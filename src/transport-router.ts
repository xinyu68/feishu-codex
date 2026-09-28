import { messageKey, parseRoute } from './routing.js';
import type { FeishuTransport, MessageCard } from './types.js';

/** Keeps every outbound action on the same Feishu application as its incoming route. */
export class TransportRouter implements FeishuTransport {
  private readonly clients = new Map<string, FeishuTransport>();
  private readonly ready = new Set<string>();

  set(botId: string, client: FeishuTransport, ready = true): void { this.clients.set(botId, client); this.setReady(botId, ready); }
  setReady(botId: string, ready: boolean): void { if (ready && this.clients.has(botId)) this.ready.add(botId); else this.ready.delete(botId); }
  isAvailable(chatId: string): boolean { const { botId } = parseRoute(chatId); return this.clients.has(botId) && this.ready.has(botId); }
  get(botId: string): FeishuTransport | undefined { return this.clients.get(botId); }
  delete(botId: string): void { this.clients.delete(botId); this.ready.delete(botId); }
  async start(): Promise<void> { /* Connections are individually managed by the server. */ }
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.ready.clear();
    const results = await Promise.allSettled(clients.map(client => client.close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private target(key: string): { botId: string; id: string; client: FeishuTransport } {
    const { botId, id } = parseRoute(key);
    const client = this.clients.get(botId);
    if (!client || !this.ready.has(botId)) throw new Error('这个机器人的飞书连接尚未就绪，请在连接设置中检查。');
    return { botId, id, client };
  }
  private async send(chatId: string, action: (client: FeishuTransport, rawChatId: string) => Promise<string>): Promise<string> {
    const { botId, id, client } = this.target(chatId);
    const result = await action(client, id);
    return result ? messageKey(botId, result) : '';
  }
  sendText(chatId: string, text: string): Promise<string> { return this.send(chatId, (client, id) => client.sendText(id, text)); }
  sendCard(chatId: string, card: MessageCard): Promise<string> { return this.send(chatId, (client, id) => client.sendCard(id, card)); }
  sendImage(chatId: string, imagePath: string): Promise<string> { return this.send(chatId, (client, id) => client.sendImage(id, imagePath)); }
  sendFile(chatId: string, filePath: string): Promise<string> { return this.send(chatId, (client, id) => client.sendFile(id, filePath)); }
  async updateCard(messageId: string, card: MessageCard): Promise<void> {
    const { id, client } = this.target(messageId);
    await client.updateCard(id, card);
  }
  async recallCard(messageId: string): Promise<void> {
    const { id, client } = this.target(messageId);
    if (!client.recallCard) throw new Error('这个机器人的飞书连接不支持撤回卡片。');
    await client.recallCard(id);
  }
  async markCompleted(messageId: string): Promise<void> {
    const { id, client } = this.target(messageId);
    if (!client.markCompleted) throw new Error('这个机器人的飞书连接不支持完成表情。');
    await client.markCompleted(id);
  }
  async startTyping(messageId: string): Promise<() => Promise<void>> {
    const { id, client } = this.target(messageId);
    return client.startTyping(id);
  }
}
