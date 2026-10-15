export type ConnectionIncident = { lostAt: number; recoveredAt?: number; threads: string[]; notified: boolean };
type Delivery = 'sent' | 'unavailable' | 'uncertain';

/** One outage produces at most one warning and one recovery for the default recipient. */
export class ConnectionAlerts {
  private timer?: ReturnType<typeof setTimeout>;
  private sending?: Promise<void>;
  constructor(private readonly options: {
    get: () => ConnectionIncident | undefined;
    save: (value: ConnectionIncident | undefined) => void;
    enabled: () => boolean;
    send: (recovered: boolean, incident: ConnectionIncident) => Promise<Delivery>;
    onError?: (error: unknown) => void;
    now?: () => number; graceMs?: number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  observe(key: string, lost: boolean): void {
    if (!this.options.enabled()) { this.clear(); return; }
    let incident = this.options.get();
    if (lost) {
      if (!incident || incident.recoveredAt) incident = { lostAt: this.now(), threads: [], notified: false };
      if (incident.threads.includes(key)) return;
      if (!incident.threads.includes(key)) incident.threads.push(key);
      incident.threads = incident.threads.slice(-128);
      this.options.save(incident);
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; this.flushInBackground(); }, this.options.graceMs ?? 10_000);
        this.timer.unref?.();
      }
    } else if (incident) {
      if (!incident.threads.includes(key)) return;
      incident.threads = incident.threads.filter(id => id !== key);
      if (!incident.threads.length) incident.recoveredAt = this.now();
      this.options.save(incident);
      this.flushInBackground();
    }
  }
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    const operation = this.deliver().finally(() => { if (this.sending === operation) this.sending = undefined; });
    this.sending = operation;
    return operation;
  }
  private flushInBackground() { void this.flush().catch(error => { this.options.onError?.(error); }); }
  private async deliver(): Promise<void> {
    const incident = this.options.get();
    if (!this.options.enabled()) { this.clear(); return; }
    if (!incident) return;
    const duration = (incident.recoveredAt ?? this.now()) - incident.lostAt;
    if (duration < (this.options.graceMs ?? 10_000)) { if (incident.recoveredAt) this.clear(); return; }
    if (!incident.recoveredAt && incident.notified) return;
    const recovered = Boolean(incident.recoveredAt);
    const outcome = await this.options.send(recovered, incident).catch(() => 'uncertain' as const);
    if (this.options.get() !== incident || outcome === 'unavailable') return;
    if (recovered) this.clear();
    else { incident.notified = true; this.options.save(incident); }
  }
  private clear() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; if (this.options.get()) this.options.save(undefined); }
  close() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
