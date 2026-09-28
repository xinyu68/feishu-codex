import type { FeishuTransport, MessageCard } from './types.js';

export type TaskProgressOptions = {
  transport: FeishuTransport;
  chatId: string;
  card: MessageCard;
  canShow: () => boolean;
  log: (message: string) => void;
  throttleMs?: number;
};

/** Owns one task card, replacing its progress with the final answer when available. */
export class TaskProgress {
  private readonly throttleMs: number;
  private latest: MessageCard;
  private revision = 0;
  private publishedRevision = -1;
  private attemptedCreation = false;
  private messageId?: string;
  private lastMutationAt = 0;
  private terminal = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private finalCard?: MessageCard;
  private finalDelivered = false;
  private delivery?: Promise<string>;
  private finishing?: Promise<void>;

  constructor(private readonly options: TaskProgressOptions) {
    this.latest = structuredClone(options.card);
    this.throttleMs = duration(options.throttleMs, 4_000);
  }

  update(text: string, title?: string): void {
    if (this.terminal) return;
    const nextText = text.trim().slice(0, 2500);
    if (!nextText) return;
    const nextTitle = title ?? this.latest.title;
    if (nextText === this.latest.text && nextTitle === this.latest.title) { this.schedule(); return; }
    this.latest = { ...this.latest, text: nextText, title: nextTitle };
    this.revision++;
    this.schedule();
  }

  freeze(): void {
    this.terminal = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  deliver(card: MessageCard): Promise<string> {
    this.freeze();
    if (!this.delivery) {
      this.finalCard = withoutButtons(card);
      this.delivery = this.deliverFinal();
    }
    return this.delivery;
  }

  finish(delivered: boolean, fallback: MessageCard): Promise<void> {
    this.freeze();
    if (!this.finishing) this.finishing = this.finishExisting(delivered, structuredClone(fallback));
    return this.finishing;
  }

  private schedule(): void {
    if (this.terminal || this.inFlight || this.timer) return;
    if (this.attemptedCreation && (!this.messageId || this.revision <= this.publishedRevision)) return;
    const delay = this.attemptedCreation ? Math.max(0, this.lastMutationAt + this.throttleMs - Date.now()) : 0;
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
      this.timer.unref();
      return;
    }
    // The microtask permits freeze() to cancel an update that has not reached the transport yet.
    const work = Promise.resolve().then(() => this.mutate());
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
      // A disabled card waits for a later explicit update instead of spinning or polling.
      if (!this.terminal && this.canShow()) this.schedule();
    }).catch(error => this.log(`进度卡片处理失败：${errorMessage(error)}`));
  }

  private async mutate(): Promise<void> {
    if (this.terminal || !this.canShow()) return;
    const card = structuredClone(this.latest);
    const revision = this.revision;
    this.lastMutationAt = Date.now();
    if (!this.attemptedCreation) {
      this.attemptedCreation = true;
      try {
        const id = await this.options.transport.sendCard(this.options.chatId, card);
        if (!id) throw new Error('未返回消息编号');
        this.messageId = id;
      } catch (error) {
        // A lost response may mean that Feishu accepted it. Never create another card blindly.
        this.log(`进度卡片发送未确认，未自动重试：${errorMessage(error)}`);
      }
    } else if (this.messageId) {
      try { await this.options.transport.updateCard(this.messageId, card); }
      catch (error) { this.log(`进度卡片更新失败：${errorMessage(error)}`); }
    }
    // Failed updates can be replaced by newer progress, but are not automatically replayed.
    this.publishedRevision = revision;
  }

  private async deliverFinal(): Promise<string> {
    await this.inFlight;
    if (this.messageId) {
      await this.options.transport.updateCard(this.messageId, this.finalCard!);
    } else {
      const id = await this.options.transport.sendCard(this.options.chatId, this.finalCard!);
      if (!id) throw new Error('最终回复未返回消息编号，送达状态不确定');
      this.messageId = id;
    }
    this.finalDelivered = true;
    return this.messageId;
  }

  private async finishExisting(_delivered: boolean, fallback: MessageCard): Promise<void> {
    await this.inFlight;
    if (this.delivery) await this.delivery.catch(() => undefined);
    if (this.finalDelivered || !this.messageId) return;
    let card = withoutButtons(fallback);
    if (this.finalCard) {
      const note = [fallback.title.trim(), fallback.text.trim()].filter(Boolean).join('：').slice(0, 200);
      card = { ...this.finalCard, text: `${this.finalCard.text}${note ? `\n\n${note}` : ''}` };
    }
    // Authorization changes must not leave the already-visible stop button actionable.
    // An uncertain final update must retain the complete answer instead of replacing it with a status.
    try { await this.options.transport.updateCard(this.messageId, card); }
    catch (error) { this.log(`进度卡片收尾失败：${errorMessage(error)}`); }
  }

  private canShow(): boolean {
    try { return this.options.canShow(); }
    catch (error) { this.log(`无法确认是否显示进度：${errorMessage(error)}`); return false; }
  }

  private log(message: string): void {
    try { this.options.log(message); } catch { /* Logging must not affect task completion. */ }
  }
}

function withoutButtons(card: MessageCard): MessageCard {
  const result = structuredClone(card);
  delete result.buttons;
  return result;
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
