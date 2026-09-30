import type { FeishuTransport, MessageCard } from './types.js';

type Options = {
  transport: Pick<FeishuTransport, 'sendCard' | 'updateCard'>;
  chatId: string; name: string;
  signal: AbortSignal;
  canPublish: () => boolean;
  canNotify: () => boolean;
  showProgress: () => boolean;
  remember: (messageId: string, text: string) => void;
  log: (message: string) => void;
  throttleMs?: number;
};

/** One target-owned consultation card; publishing never dispatches another model task. */
export class GroupConsultReply {
  private terminal = false;
  private attempted = false;
  private messageId?: string;
  private latest = '';
  private published = '';
  private lastMutationAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private delivery?: Promise<'sent' | 'uncertain'>;
  private failure?: Promise<void>;

  constructor(private readonly options: Options) {}

  update(text: string): void {
    if (this.terminal) return;
    const next = cleanConsultationText(text).slice(0, 2500);
    if (!next) return;
    this.latest = next;
    this.schedule();
  }

  private freeze(): void {
    this.terminal = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.terminal || this.timer || this.inFlight || !this.options.showProgress()
      || !this.canPublish() || this.latest === this.published || (this.attempted && !this.messageId)) return;
    const delay = this.attempted ? Math.max(0, this.lastMutationAt + (this.options.throttleMs ?? 4000) - Date.now()) : 0;
    if (delay) {
      this.timer = setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
      this.timer.unref();
      return;
    }
    const work = Promise.resolve().then(async () => {
      if (this.terminal || !this.options.showProgress() || !this.canPublish()) return;
      const text = this.latest;
      this.lastMutationAt = Date.now();
      try { await this.write({ title: `${this.options.name} · 正在答复`, text }, false); }
      catch { this.log('咨询进度送达未确认，未另建卡片。'); }
      this.published = text;
    });
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
      this.schedule();
    }).catch(() => undefined);
  }

  deliver(chunks: string[]): Promise<'sent' | 'uncertain'> {
    // An abort/failure may already have frozen the card while the model was finishing.
    if (this.failure) return Promise.resolve('uncertain');
    this.freeze();
    return this.delivery ??= this.deliverAnswer(chunks);
  }

  private async deliverAnswer(chunks: string[]): Promise<'sent' | 'uncertain'> {
    await this.inFlight;
    try {
      for (const [index, raw] of chunks.entries()) {
        const text = cleanConsultationText(raw);
        if (!text || !this.canPublish()) throw new Error('Consultation publication cancelled');
        const card: MessageCard = { title: `${this.options.name} · 咨询答复${index ? '（续）' : ''}`, text, tone: 'green' };
        const id = index === 0 ? await this.write(card, false)
          : await this.options.transport.sendCard(this.options.chatId, card, this.sendOptions(false));
        if (!id) throw new Error('No delivery acknowledgement');
        // Persist only acknowledged public content; never bind the temporary native conversation.
        if (this.options.canNotify()) this.options.remember(id, text);
        if (!this.canPublish()) throw new Error('Consultation publication cancelled');
      }
      return 'sent';
    } catch {
      this.log('咨询答复的群消息送达未确认；保留模型答复，不自动重新发送。');
      return 'uncertain';
    }
  }

  fail(cancelled: boolean): Promise<void> {
    this.freeze();
    return this.failure ??= this.finishFailure(cancelled);
  }

  private async finishFailure(cancelled: boolean): Promise<void> {
    await this.inFlight;
    // Do not overwrite a real answer after an uncertain final update, or create a second result.
    if (this.delivery) { await this.delivery; return; }
    if (!this.options.canNotify()) return;
    try {
      await this.write({ title: `${this.options.name} · ${cancelled ? '咨询已停止' : '咨询未完成'}`,
        text: cancelled ? '本次咨询已取消或超时，未取得可确认的答复。' : '本次咨询未取得可确认的答复，请查看发起方的说明。', tone: 'orange' }, true);
    } catch { this.log('咨询结束状态送达未确认，未自动重发。'); }
  }

  private async write(card: MessageCard, terminalNotice: boolean): Promise<string> {
    if (!(terminalNotice ? this.options.canNotify() : this.canPublish())) throw new Error('Consultation publication cancelled');
    if (this.messageId) {
      await this.options.transport.updateCard(this.messageId, card, this.sendOptions(terminalNotice));
      return this.messageId;
    }
    // A lost creation response may still have created a card. Never create another blindly.
    if (this.attempted) throw new Error('Previous card creation unconfirmed');
    this.attempted = true;
    const id = await this.options.transport.sendCard(this.options.chatId, card, this.sendOptions(terminalNotice));
    if (!id) throw new Error('No delivery acknowledgement');
    this.messageId = id;
    return id;
  }

  private canPublish(): boolean { return !this.options.signal.aborted && this.options.canPublish(); }

  private sendOptions(terminalNotice: boolean): { signal?: AbortSignal; canSend: () => boolean } {
    if (!terminalNotice) return { signal: this.options.signal, canSend: () => this.canPublish() };
    const signal = AbortSignal.timeout(5000);
    return { signal, canSend: () => !signal.aborted && this.options.canNotify() };
  }

  private log(message: string): void {
    try { this.options.log(message); } catch { /* Logging must not fail a consultation or its cancellation callback. */ }
  }
}

export function cleanConsultationText(text: string): string {
  return text.replace(/fc1\.\d{1,5}\.[a-f0-9]{64}/g, '[咨询凭据已省略]').trim();
}
