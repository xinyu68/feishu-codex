import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { CHANNEL_INSTRUCTIONS, channelContextParameters } from './channel-context.js';
import { readTurnTiming } from './turn-timing.js';
import { isThreadInitializationRace, isThreadWriterConflict, THREAD_WRITER_MESSAGE } from './codex-errors.js';
import { CodexRpcError, IGNORE_SERVER_REQUEST, WebsocketCodexConnection, validateCodexWebsocketUrl, type CodexConnection } from './codex-websocket.js';
import type { CodexRunInput, CodexRuntime, CodexUsage, HistoryMessage, ModelInfo, RuntimeAnswer, RuntimeRequest, RuntimeEvent, UsageLimit, UsageWindow } from './types.js';

type RecordValue = Record<string, unknown>;
type Wire = { id?: string | number; method?: string; params?: RecordValue; result?: unknown; error?: { message?: string; code?: number } };
type Command = { command: string; args: string[] };
export type CodexClientOptions = {
  bin?: string;
  codexHome?: string;
  websocketUrl?: string;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** A passive watcher must obey the same desktop ownership gate as a writer. */
  canWatch?: () => Promise<boolean>;
  /** Executable and arguments are separate; never invoke a command shell. Also useful for protocol fixtures. */
  command?: Command;
};

const ACCESS_CONFIG = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
const SNAPSHOT_INITIALIZATION_RETRY_DELAYS_MS = [75, 200, 500, 1_000] as const;
const WATCH_INITIALIZATION_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
const WATCH_RECONNECT_DELAY_MS = 2_000;
const GENERATED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.heic']);
type GeneratedImageStamp = { size: number; mtimeMs: number };

function threadInstructionOverrides(input: CodexRunInput, channelContextProvided = false): { developerInstructions?: string } {
  // Omitting a role preserves native thread settings. An explicitly empty role
  // removes a previously configured role while retaining the channel guidance.
  if (input.threadId && input.roleInstructions === undefined) return {};
  const role = input.roleInstructions?.trim();
  // The request-level application context already supplies these rules. Keep only
  // an explicit role here, leaving native/configured instructions alone otherwise.
  if (channelContextProvided) return input.roleInstructions === undefined ? {} : { developerInstructions: role ?? '' };
  return { developerInstructions: role ? `${CHANNEL_INSTRUCTIONS}\n\n${role}` : CHANNEL_INSTRUCTIONS };
}

/** Each turn owns a connection; only standalone mode also owns its app-server process. */
export class CodexClient implements CodexRuntime {
  private readonly connections = new Set<CodexConnection>();
  private readonly active = new Map<string, ActiveRun>();
  private closed = false;
  private modelsCache?: { value: ModelInfo[]; until: number };
  private sharedRuns = new Set<SharedRun>();
  private submitLocks = new Map<string, Promise<void>>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private publishers = new Map<string, CodexConnection>();
  private watchers = new Map<string, { connection?: CodexConnection; connecting?: Promise<void>; retry?: NodeJS.Timeout; subscribed?: boolean; established?: boolean }>();
  private loadedWatchTimer?: NodeJS.Timeout;
  private loadedWatchBusy = false;
  private observedLoaded = new Set<string>();

  get supportsSteering(): boolean { return Boolean(this.options.websocketUrl); }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(method: string, params: RecordValue): void {
    const event: RuntimeEvent = { method, threadId: string(params.threadId) || undefined, turnId: string(params.turnId) || string(record(params.turn).id) || undefined, params };
    for (const listener of this.listeners) { try { listener(event); } catch { /* A view cannot break the protocol. */ } }
  }
  private publishFrom(connection: CodexConnection, method: string, params: RecordValue): void {
    const threadId = string(params.threadId);
    if (!threadId) return;
    const previous = this.publishers.get(threadId);
    if (previous && !previous.isClosed && previous !== connection) return;
    if (previous !== connection) {
      this.publishers.set(threadId, connection);
      // App-server deltas have no sequence ID. A single socket is authoritative;
      // changing sockets discards the partial display rather than guessing which
      // token has already been appended by the old stream.
      this.emit('stream/reset', { threadId });
    }
    this.emit(method, params);
  }

  async watch(threadId: string): Promise<void> {
    if (!this.options.websocketUrl || this.closed) return;
    if (this.options.canWatch && !await this.options.canWatch()) { await this.unwatch(threadId); return; }
    let watcher = this.watchers.get(threadId);
    if (!watcher) { watcher = {}; this.watchers.set(threadId, watcher); }
    if (watcher.connecting) return watcher.connecting;
    if (watcher.connection && !watcher.connection.isClosed) return;
    if (watcher.retry) return;
    const entry = watcher;
    const scheduleReconnect = () => {
      if (this.closed || this.watchers.get(threadId) !== entry || entry.retry) return;
      entry.retry = setTimeout(() => { entry.retry = undefined; void this.watch(threadId).catch(() => {}); }, WATCH_RECONNECT_DELAY_MS);
      entry.retry.unref();
    };
    entry.connecting = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (this.closed || this.watchers.get(threadId) !== entry) return;
        const connection = this.connect();
        entry.connection = connection;
        entry.subscribed = false;
        connection.onNotification = (method, params) => { if (string(params.threadId) === threadId) this.publishFrom(connection, method, params); };
        connection.onFailure = error => {
          // Closing a failed initialization attempt is deliberate. Only an
          // established watcher should publish a loss or schedule reconnection.
          if (!entry.subscribed) return;
          entry.subscribed = false;
          this.observedLoaded.delete(threadId);
          this.emit('connection/lost', { threadId, error: error.message });
          scheduleReconnect();
        };
        try {
          await connection.initialize();
          // Merely opening a history preview must not load the thread and
          // acquire its writer lock in a second app-server process.
          const metadata = record(await connection.request('thread/read', { threadId, includeTurns: false }));
          const thread = record(metadata.thread);
          const loaded = string(thread.id) === threadId && ['active', 'idle', 'systemError'].includes(string(record(thread.status).type));
          const allowed = loaded && (!this.options.canWatch || await this.options.canWatch());
          if (!allowed || this.closed || this.watchers.get(threadId) !== entry) {
            connection.onFailure = undefined;
            if (entry.connection === connection) entry.connection = undefined;
            await this.disconnect(connection);
            return;
          }
          const response = record(await connection.request('thread/resume', { threadId, excludeTurns: true }));
          if (this.closed || this.watchers.get(threadId) !== entry) {
            connection.onFailure = undefined;
            if (entry.connection === connection) entry.connection = undefined;
            await this.disconnect(connection);
            return;
          }
          entry.subscribed = true;
          entry.established = true;
          this.emit('thread/status/changed', { threadId, status: record(response.thread).status });
          return;
        } catch (error) {
          connection.onFailure = undefined;
          if (entry.connection === connection) entry.connection = undefined;
          await this.disconnect(connection);
          if (this.closed || this.watchers.get(threadId) !== entry) return;
          if (!isThreadInitializationRace(errorText(error))) {
            // Once a watcher has worked, a transport failure during reconnection
            // should keep the one-timer recovery loop alive. RPC rejections are
            // durable thread errors and still stop immediately.
            if (entry.established && !(error instanceof CodexRpcError)) scheduleReconnect();
            throw error;
          }
          const retryDelay = WATCH_INITIALIZATION_RETRY_DELAYS_MS[attempt];
          // A caller normally starts watch() in the background. Exhausting this
          // bounded initialization window is therefore quiet; a later state read
          // may start a fresh window once the rollout exists.
          if (retryDelay === undefined) return;
          await delay(retryDelay);
        }
      }
    })().finally(() => { entry.connecting = undefined; });
    return entry.connecting;
  }

  async unwatch(threadId: string): Promise<void> {
    const watcher = this.watchers.get(threadId);
    if (!watcher) return;
    this.watchers.delete(threadId);
    if (watcher.retry) clearTimeout(watcher.retry);
    if (watcher.connection) { watcher.connection.onFailure = undefined; await this.disconnect(watcher.connection); }
  }

  async watchLoaded(): Promise<void> {
    if (!this.options.websocketUrl || this.closed || this.loadedWatchTimer) return;
    const poll = async () => {
      if (this.loadedWatchBusy || this.closed) return;
      this.loadedWatchBusy = true;
      try {
        const ids = await this.withConnection(async connection => {
          const result: string[] = [];
          let cursor: string | undefined;
          do {
            const page = record(await connection.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
            result.push(...array(page.data).map(string).filter(Boolean));
            cursor = string(page.nextCursor) || undefined;
          } while (cursor);
          return result;
        });
        for (const threadId of ids) {
          const firstSeen = !this.observedLoaded.has(threadId);
          this.observedLoaded.add(threadId);
          await this.watch(threadId).catch(() => undefined);
          if (!firstSeen) continue;
          await this.withConnection(async connection => {
            const turns = await readRecentSharedTurnsBestEffort(connection, threadId);
            for (const turn of turns?.slice(0, 3) ?? []) this.emit('turn/snapshot', { threadId, turn });
          }).catch(() => undefined);
        }
      } finally { this.loadedWatchBusy = false; }
    };
    await poll();
    // The shared runtime may be restarting; a failed background read must not
    // become an unhandled rejection that takes down the Feishu bridge too.
    this.loadedWatchTimer = setInterval(() => { void poll().catch(() => {}); }, 2_000);
    this.loadedWatchTimer.unref();
  }

  constructor(private readonly options: CodexClientOptions = {}) {
    if (options.websocketUrl !== undefined) validateCodexWebsocketUrl(options.websocketUrl);
  }

  async run(input: CodexRunInput): Promise<{ threadId: string; text: string; turnId?: string; images?: string[] }> {
    if (this.closed) throw new Error('Codex 服务已关闭');
    if (this.options.websocketUrl) return this.runShared(input);
    if (input.threadId && this.active.has(input.threadId)) throw new Error('这个 Codex 会话正在处理另一条消息，请等待完成或先停止。');
    const connection = this.connect(input.cwd);
    const run: ActiveRun = {
      connection, threadId: input.threadId, stopRequested: false, cancel: new AbortController(),
      submitted: false,
    };
    if (input.threadId) this.active.set(input.threadId, run);
    const tracker = new TurnTracker(input, this.options.idleTimeoutMs ?? 15 * 60_000);
    let mutationPending = false;
    connection.onNotification = (method, params) => tracker.notification(method, params);
    connection.onFailure = error => tracker.fail(error);
    connection.onRequest = (method, params) => handleRuntimeRequest(input, method, params);
    try {
      await connection.initialize();
      const channelContext = channelContextParameters(connection.initialized, input.channel !== undefined);
      const compactChannelHeader = Boolean(channelContext.additionalContext);
      const response = record(await connection.request(input.threadId ? 'thread/resume' : 'thread/start', {
        ...(input.threadId ? { threadId: input.threadId, excludeTurns: true } : {}),
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        sandbox: 'danger-full-access', approvalPolicy: 'never', config: ACCESS_CONFIG,
        ...threadInstructionOverrides(input, compactChannelHeader),
      }));
      const threadId = string(record(response.thread).id);
      if (!threadId) throw new Error('Codex 没有返回会话编号');
      run.threadId = threadId;
      this.active.set(threadId, run);
      tracker.threadId = threadId;
      input.onThread?.(threadId);
      const generatedBefore = await generatedImageSnapshot(this.options.codexHome, threadId);
      if (run.stopRequested) throw new Error('已停止当前任务');
      run.starting = (async () => {
        if (run.stopRequested) throw new Error('已停止当前任务');
        await input.onBeforeSubmit?.();
        const prompt = input.preparePrompt ? await input.preparePrompt(threadId, { compactChannelHeader }) : input.prompt;
        if (run.stopRequested) throw new Error('已停止当前任务');
        const turnParams = {
          threadId, cwd: input.cwd, ...channelContext,
          input: [
            { type: 'text', text: prompt, text_elements: [] },
            ...(input.images ?? []).map(image => ({ type: 'localImage', path: image })),
          ],
          approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        };
        input.onSubmitted?.({ threadId, mode: 'start', status: 'submitting' });
        run.submitted = true;
        mutationPending = true;
        // Never retry this call: a lost response may still mean the server accepted the message.
        const turnResponse = record(await connection.request('turn/start', turnParams));
        mutationPending = false;
        const turnId = string(record(turnResponse.turn).id);
        if (!turnId) {
          input.onSubmitted?.({ threadId, mode: 'start', status: 'uncertain' });
          throw new Error('Codex 没有返回任务编号');
        }
        run.turnId = turnId;
        tracker.setTurn(turnId);
        input.onSubmitted?.({ threadId, turnId, mode: 'start', status: 'submitted' });
        return turnId;
      })();
      await run.starting;
      if (run.stopRequested) await this.stop(threadId);
      const text = await tracker.result;
      const images = await newGeneratedImages(this.options.codexHome, threadId, generatedBefore);
      return images.length ? { threadId, turnId: run.turnId, text, images } : { threadId, turnId: run.turnId, text };
    } catch (error) {
      if (mutationPending && run.threadId) input.onSubmitted?.({ threadId: run.threadId, turnId: run.turnId, mode: 'start', status: error instanceof CodexRpcError ? 'rejected' : 'uncertain' });
      throw run.stopRequested ? new Error('已停止当前任务') : readableError(error);
    } finally {
      tracker.dispose();
      try { await this.disconnect(connection); }
      finally {
        if (run.threadId && this.active.get(run.threadId) === run) this.active.delete(run.threadId);
        if (input.threadId && this.active.get(input.threadId) === run) this.active.delete(input.threadId);
      }
    }
  }

  private async runShared(input: CodexRunInput): Promise<{ threadId: string; turnId: string; text: string; images?: string[] }> {
    const connection = this.connect(input.cwd);
    const tracker = new TurnTracker(input, this.options.idleTimeoutMs ?? 15 * 60_000, true);
    let resolveOwnership!: () => void;
    const ownershipReady = new Promise<void>(resolve => { resolveOwnership = resolve; });
    const run: SharedRun = { connection, tracker, threadId: input.threadId, stopped: false, ownsTurn: false, clientId: randomUUID(), ownershipReady, resolveOwnership };
    this.sharedRuns.add(run);
    let currentMode: 'start' | 'steer' = 'start';
    let mutationPending = false;
    const checkingInterruptions = new Set<string>();
    const observeTurn = (method: string, params: RecordValue) => {
      const turn = record(params.turn);
      if (method !== 'turn/completed' || turn.status !== 'interrupted' || run.stopped) {
        tracker.notification(method, params);
        return;
      }
      const turnId = string(turn.id);
      if (!turnId || checkingInterruptions.has(turnId)) return;
      checkingInterruptions.add(turnId);
      void (async () => {
        await run.ownershipReady;
        if (run.turnId !== turnId || !run.threadId) return;
        // A just-started turn can briefly be reported as interrupted even
        // while its input is still being processed. Check the same turn again
        // before telling Feishu that the user's message was stopped.
        await delay(150);
        const turns = await readRecentSharedTurnsBestEffort(connection, run.threadId);
        const current = turns?.find(item => string(item.id) === turnId);
        if (!current) {
          tracker.fail(new Error('Codex 返回了中断状态，但无法确认该轮是否仍在运行。请查看会话记录，消息不会自动重发。'));
          return;
        }
        if (['inProgress', 'in_progress', 'active'].includes(string(current.status))) return;
        tracker.notification('turn/completed', { threadId: run.threadId, turn: current });
      })().catch(error => tracker.fail(readableError(error))).finally(() => checkingInterruptions.delete(turnId));
    };
    connection.onNotification = (method, params) => {
      this.publishFrom(connection, method, params);
      observeTurn(method, params);
    };
    connection.onFailure = error => tracker.fail(error);
    connection.onRequest = async (method, params) => {
      if (string(params.threadId) !== run.threadId || !string(params.turnId)) return IGNORE_SERVER_REQUEST;
      await run.ownershipReady;
      const owner = [...this.sharedRuns].find(item => item.threadId === run.threadId && item.turnId === string(params.turnId) && (item.ownsTurn || method === 'item/tool/requestUserInput'));
      if (owner !== run) return IGNORE_SERVER_REQUEST;
      return handleRuntimeRequest(input, method, params);
    };
    try {
      await connection.initialize();
      const channelContext = channelContextParameters(connection.initialized, input.channel !== undefined);
      const compactChannelHeader = Boolean(channelContext.additionalContext);
      const response = record(await connection.request(input.threadId ? 'thread/resume' : 'thread/start', input.threadId
        ? { threadId: input.threadId, excludeTurns: true, ...threadInstructionOverrides(input, compactChannelHeader) }
        : { cwd: input.cwd, ...(input.model ? { model: input.model } : {}), sandbox: 'danger-full-access', approvalPolicy: 'never', config: ACCESS_CONFIG, ...threadInstructionOverrides(input, compactChannelHeader) }));
      const threadId = string(record(response.thread).id);
      if (!threadId) throw new Error('Codex 没有返回会话编号');
      run.threadId = threadId;
      tracker.threadId = threadId;
      input.onThread?.(threadId);
      const generatedBefore = await generatedImageSnapshot(this.options.codexHome, threadId);
      run.submitting = this.serializeSubmission(threadId, async () => {
        if (run.stopped) throw new Error('已停止当前任务');
        // A newly created thread has no turn or persisted rollout yet.
        let current = input.threadId ? await currentSharedTurn(connection, threadId) : undefined;
        const submit = async (turn: RecordValue | undefined): Promise<RecordValue> => {
          if (run.stopped) throw new Error('已停止当前任务');
          if (turn && input.allowSteering === false) throw new Error('目标角色正在桌面或其他入口处理任务，本次交接没有加入该任务。请等它结束后手动 @该机器人继续。');
          await input.onBeforeSubmit?.();
          // Resolve group context inside the submission lock, after the previous
          // start/steer acknowledged exactly which messages reached this thread.
          const prompt = input.preparePrompt ? await input.preparePrompt(threadId, { compactChannelHeader }) : input.prompt;
          if (run.stopped) throw new Error('已停止当前任务');
          const content = [{ type: 'text', text: prompt, text_elements: [] }, ...(input.images ?? []).map(image => ({ type: 'localImage', path: image }))];
          currentMode = turn ? 'steer' : 'start';
          const expectedTurnId = string(turn?.id);
          input.onSubmitted?.({ threadId, turnId: expectedTurnId || undefined, mode: currentMode, status: 'submitting' });
          mutationPending = true;
          const result = record(await connection.request(turn ? 'turn/steer' : 'turn/start', turn
            ? { threadId, expectedTurnId, input: content, ...channelContext }
            : { threadId, cwd: input.cwd, input: content, ...channelContext, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, clientUserMessageId: run.clientId,
                ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) }));
          mutationPending = false;
          const acceptedTurn = record(result.turn);
          const turnId = string(acceptedTurn.id) || string(result.turnId) || expectedTurnId;
          if (!turnId) {
            input.onSubmitted?.({ threadId, mode: currentMode, status: 'uncertain' });
            throw new Error('消息可能已被 Codex 接收，但未返回任务编号；不会自动重发，请检查会话记录。');
          }
          run.turnId = turnId;
          // A successful turn/start response identifies a turn created by this
          // run even when the returned snapshot has not been populated yet.
          // Steering joins an existing native turn and must never claim it.
          run.ownsTurn = !turn;
          run.resolveOwnership();
          tracker.setTurn(turnId);
          input.onSubmitted?.({ threadId, turnId, mode: currentMode, status: 'submitted' });
          return acceptedTurn;
        };
        let accepted: RecordValue;
        try { accepted = await submit(current); }
        catch (error) {
          // Only a definitive server rejection permits this one start. Timeouts,
          // disconnected sockets and arbitrary RPC failures never replay a prompt.
          if (current && error instanceof CodexRpcError && /no active turn|not active|turn.*(?:completed|finished)|expected.*turn.*(?:mismatch|does not match)/i.test(error.message)) {
            mutationPending = false;
            input.onSubmitted?.({ threadId, turnId: string(current.id), mode: 'steer', status: 'rejected' });
            current = await currentSharedTurn(connection, threadId);
            if (current) throw new Error('当前任务已经变化，补充消息未发送，请检查会话后重试。');
            accepted = await submit(undefined);
          } else throw error;
        }
        // Events can precede the response or a steer can finish while its response
        // is travelling. This snapshot is only an optimization: once the mutation
        // returned a turn ID, no read failure may turn it into a failed submission.
        let snapshot = accepted;
        if (!array(snapshot.items).length || !snapshot.status) {
          const turns = await readRecentSharedTurnsBestEffort(connection, threadId);
          if (turns) snapshot = turns.find(turn => string(turn.id) === run.turnId) ?? accepted;
        }
        if (['completed', 'failed', 'interrupted'].includes(string(snapshot.status))) observeTurn('turn/completed', { threadId, turn: snapshot });
      });
      await run.submitting;
      if (run.stopped) throw new Error('已停止当前任务');
      const text = await tracker.result;
      const images = await newGeneratedImages(this.options.codexHome, threadId, generatedBefore);
      return images.length ? { threadId, turnId: run.turnId!, text, images } : { threadId, turnId: run.turnId!, text };
    } catch (error) {
      if (mutationPending && run.threadId) input.onSubmitted?.({ threadId: run.threadId, turnId: run.turnId, mode: currentMode, status: error instanceof CodexRpcError ? 'rejected' : 'uncertain' });
      throw run.stopped ? new Error('已停止当前任务') : readableError(error);
    } finally {
      run.resolveOwnership();
      tracker.dispose();
      this.sharedRuns.delete(run);
      await this.disconnect(connection);
    }
  }

  private async serializeSubmission<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.submitLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.submitLocks.set(threadId, tail);
    await previous.catch(() => undefined);
    try { return await work(); }
    finally { release(); if (this.submitLocks.get(threadId) === tail) this.submitLocks.delete(threadId); }
  }

  async stop(threadId: string): Promise<void> {
    if (this.options.websocketUrl) {
      const matching = [...this.sharedRuns].filter(run => run.threadId === threadId);
      for (const run of matching) run.stopped = true;
      await Promise.allSettled(matching.map(run => run.submitting));
      // Explicit stop targets the selected native turn, regardless of who started it.
      await this.withConnection(async connection => {
        const turn = await currentSharedTurn(connection, threadId);
        if (turn) await connection.request('turn/interrupt', { threadId, turnId: string(turn.id) });
      });
      for (const run of matching) { run.tracker.fail(new Error('已停止当前任务')); await this.disconnect(run.connection); }
      return;
    }
    const run = this.active.get(threadId);
    if (!run) return;
    if (run.stopping) return run.stopping;
    run.stopping = (async () => {
      run.stopRequested = true;
      run.cancel.abort();
      if (run.turnId && !run.connection.isClosed) {
        await run.connection.request('turn/interrupt', { threadId, turnId: run.turnId }, 2_000).catch(() => undefined);
        await Promise.race([run.connection.exited, delay(1_000)]);
      }
      await this.disconnect(run.connection);
    })();
    return run.stopping;
  }

  async release(threadId: string): Promise<void> {
    await this.stop(threadId);
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && this.modelsCache.until > Date.now()) return this.modelsCache.value;
    return this.withConnection(async connection => {
      const models: ModelInfo[] = [];
      let cursor: string | undefined;
      do {
        const response = record(await connection.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
        for (const item of array(response.data)) {
          const model = record(item);
          const id = string(model.model) || string(model.id);
          if (!id || model.hidden === true) continue;
          models.push({ id, name: string(model.displayName) || id,
            efforts: array(model.supportedReasoningEfforts).map(value => string(record(value).reasoningEffort)).filter(Boolean),
            defaultEffort: string(model.defaultReasoningEffort) || 'medium' });
        }
        cursor = string(response.nextCursor) || undefined;
      } while (cursor);
      this.modelsCache = { value: models, until: Date.now() + 5 * 60_000 };
      return models;
    });
  }

  async history(threadId: string): Promise<HistoryMessage[]> {
    return this.withConnection(async connection => {
      // Recent turns suffice for the management preview; thread/read does not acquire a writer lock.
      const metadata = record(await connection.request('thread/read', { threadId, includeTurns: false }));
      const thread = record(metadata.thread);
      if (thread.historyMode === 'paginated') {
        const page = record(await connection.request('thread/turns/list', {
          threadId, limit: 30, sortDirection: 'desc', itemsView: 'full',
        }));
        return parseHistory(array(page.data).reverse());
      }
      const response = record(await connection.request('thread/read', { threadId, includeTurns: true }));
      return parseHistory(array(record(response.thread).turns).slice(-30));
    });
  }

  async status(): Promise<{ available: boolean; version?: string; authenticated?: boolean; error?: string }> {
    let available = false;
    let version: string | undefined;
    try {
      return await this.withConnection(async connection => {
        available = true;
        version = string(connection.initialized.userAgent) || undefined;
        const account = record(await connection.request('account/read', { refreshToken: false }));
        return { available: true, version, authenticated: Boolean(account.account) || account.requiresOpenaiAuth === false };
      });
    } catch (error) {
      return { available, version, error: readableError(error).message };
    }
  }

  async threadInfo(threadId: string): Promise<{ threadId: string; cwd: string; title: string; isUserThread: boolean }> {
    return this.withConnection(async connection => {
      const response = record(await connection.request('thread/read', { threadId, includeTurns: false }));
      const thread = record(response.thread);
      if (string(thread.id) !== threadId || !string(thread.cwd)) throw new Error('无法读取通知任务所属的 Codex 会话');
      return { threadId, cwd: string(thread.cwd), title: string(thread.name) || string(thread.preview) || `会话 ${threadId.slice(0, 8)}`,
        isUserThread: thread.ephemeral !== true && !Object.hasOwn(record(thread.source), 'subAgent') };
    });
  }

  async turnStatus(threadId: string, turnId: string): Promise<'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown'> {
    return this.withConnection(async connection => {
      const turns = await readRecentSharedTurnsBestEffort(connection, threadId);
      const status = string(turns?.find(turn => string(turn.id) === turnId)?.status);
      return ['inProgress', 'completed', 'failed', 'interrupted'].includes(status) ? status as 'inProgress' | 'completed' | 'failed' | 'interrupted' : 'unknown';
    });
  }

  async turnTiming(threadId: string, turnId: string) {
    return this.withConnection(async connection => {
      const turns = await readRecentSharedTurnsBestEffort(connection, threadId);
      return readTurnTiming(turns?.find(turn => string(turn.id) === turnId));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.loadedWatchTimer) clearInterval(this.loadedWatchTimer);
    for (const watcher of this.watchers.values()) if (watcher.retry) clearTimeout(watcher.retry);
    this.watchers.clear();
    // Detaching the product must never interrupt a native desktop task.
    for (const run of this.sharedRuns) run.tracker.fail(new Error('共享连接已关闭；未自动重发，请检查会话记录。'));
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    await Promise.all([...this.connections].map(connection => this.disconnect(connection)));
  }

  private connect(cwd = process.cwd()): CodexConnection {
    if (this.closed) throw new Error('Codex 服务已关闭');
    const connection = this.options.websocketUrl !== undefined
      ? new WebsocketCodexConnection(this.options.websocketUrl, this.options.requestTimeoutMs)
      : new RpcConnection(this.options.command ?? resolveCodexCommand(this.options.bin), cwd, this.options);
    this.connections.add(connection);
    return connection;
  }

  private async disconnect(connection: CodexConnection): Promise<void> {
    await connection.close();
    this.connections.delete(connection);
    for (const [threadId, publisher] of this.publishers) if (publisher === connection) this.publishers.delete(threadId);
  }

  private async withConnection<T>(work: (connection: CodexConnection) => Promise<T>): Promise<T> {
    const connection = this.connect();
    try { await connection.initialize(); return await work(connection); }
    finally { await this.disconnect(connection); }
  }

  /** Update only the bridge collaboration policy without replacing a role or its history. */
  async updateGroupHandoffPolicy(threadId: string, instructions: string): Promise<void> {
    if (!this.options.websocketUrl) throw new Error('现有群会话的协作升级需要本机 Codex 连接，请新建角色会话。');
    await this.serializeSubmission(threadId, () => this.withConnection(async connection => {
      const result = record(await connection.request('thread/resume', { threadId, excludeTurns: true }));
      if (string(record(record(result.thread).status).type) === 'active' || await currentSharedTurn(connection, threadId)) {
        throw new Error('当前角色会话正在执行任务，协作升级将在下次空闲时继续。');
      }
      await connection.request('thread/inject_items', {
        threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }],
      });
    }));
  }

  async usage(): Promise<CodexUsage> {
    return this.withConnection(async connection => {
      const response = usageRecord(await connection.request('account/read', { refreshToken: false }), 'account/read');
      if (!Object.hasOwn(response, 'account')) throw new Error('Codex account/read 返回了无效的账户信息');
      const account = response.account === null ? null : usageRecord(response.account, 'account/read');
      const accountType = account === null ? 'notLoggedIn' : usageString(account.type);
      if (!accountType) throw new Error('Codex account/read 未返回账户类型');
      const usage: CodexUsage = {
        accountType, planType: usageString(account?.planType), limits: [], resetCredits: null,
        ordinaryUsageAllowed: null, fetchedAt: new Date().toISOString(),
      };
      if (accountType !== 'chatgpt') return usage;
      const limits = usageRecord(await connection.request('account/rateLimits/read', {}), 'account/rateLimits/read');
      if (!Object.hasOwn(limits, 'rateLimits') && !Object.hasOwn(limits, 'rateLimitsByLimitId')) {
        throw new Error('Codex account/rateLimits/read 返回了无效的用量信息');
      }
      usage.limits = parseUsageLimits(limits);
      const resetCredits = usageNumber(record(limits.rateLimitResetCredits).availableCount);
      usage.resetCredits = resetCredits !== null && Number.isSafeInteger(resetCredits) && resetCredits >= 0 ? resetCredits : null;
      usage.ordinaryUsageAllowed = typeof limits.ordinaryUsageAllowed === 'boolean' ? limits.ordinaryUsageAllowed : null;
      usage.fetchedAt = new Date().toISOString();
      return usage;
    });
  }
}

type ActiveRun = {
  connection: CodexConnection; threadId?: string; turnId?: string; stopRequested: boolean;
  cancel: AbortController; submitted: boolean; starting?: Promise<string>; stopping?: Promise<void>;
};

type SharedRun = {
  connection: CodexConnection; tracker: TurnTracker; threadId?: string; turnId?: string;
  stopped: boolean; ownsTurn: boolean; clientId: string; submitting?: Promise<void>;
  ownershipReady: Promise<void>; resolveOwnership: () => void;
};

async function currentSharedTurn(connection: CodexConnection, threadId: string): Promise<RecordValue | undefined> {
  const metadata = record(await connection.request('thread/read', { threadId, includeTurns: false }));
  const status = string(record(record(metadata.thread).status).type);
  if (!['idle', 'notLoaded', 'active'].includes(status)) throw new Error('无法确认共享任务状态，本条消息尚未发送。');
  const turns = await readRecentSharedTurns(connection, threadId, record(metadata.thread));
  const current = turns.find(turn => ['inProgress', 'in_progress', 'active'].includes(string(turn.status)));
  if (current && string(current.id)) return current;
  if (status === 'idle' || status === 'notLoaded') return undefined;
  // The active turn may have finished between the two reads; confirm it, never guess.
  const latest = record(await connection.request('thread/read', { threadId, includeTurns: false }));
  if (['idle', 'notLoaded'].includes(string(record(record(latest.thread).status).type))) return undefined;
  throw new Error('任务正在运行，但未能确认任务编号；消息尚未发送，请稍后重试。');
}

async function readRecentSharedTurns(connection: CodexConnection, threadId: string, metadata?: RecordValue): Promise<RecordValue[]> {
  const thread = metadata ?? record(record(await connection.request('thread/read', { threadId, includeTurns: false })).thread);
  if (thread.historyMode === 'paginated') {
    try {
      const page = record(await connection.request('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' }));
      return array(page.data).map(record);
    } catch (error) {
      if (!(error instanceof CodexRpcError) || !/not supported|not implemented|method not found/i.test(error.message)) throw error;
    }
  }
  const response = record(await connection.request('thread/read', { threadId, includeTurns: true }));
  return array(record(response.thread).turns).map(record).reverse().slice(0, 10);
}

async function readRecentSharedTurnsBestEffort(connection: CodexConnection, threadId: string): Promise<RecordValue[] | undefined> {
  for (let attempt = 0; ; attempt++) {
    try { return await readRecentSharedTurns(connection, threadId); }
    catch (error) {
      if (!isThreadInitializationRace(errorText(error))) return undefined;
      const retryDelay = SNAPSHOT_INITIALIZATION_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) return undefined;
      await delay(retryDelay);
    }
  }
}

class RpcConnection {
  readonly shared = false;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  initialized: RecordValue = {};
  onNotification?: (method: string, params: RecordValue) => void;
  onFailure?: (error: Error) => void;
  onRequest?: (method: string, params: RecordValue) => Promise<unknown>;
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private stderr = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(command: Command, cwd: string, private readonly options: CodexClientOptions) {
    this.child = spawn(command.command, [...command.args, 'app-server', '--stdio',
      '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"'], {
      cwd, env: { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) },
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.fail(new Error(`无法启动 Codex：${error.message}`)); resolve(); });
      this.child.once('close', code => {
        this.fail(new Error(`Codex 进程已退出（${code ?? '已停止'}）${this.stderr ? `：${this.stderr.trim().slice(-600)}` : ''}`));
        resolve();
      });
    });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4_000); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message: Wire;
      try { message = JSON.parse(line) as Wire; } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.method === 'string') {
        if (message.id !== undefined) void this.serverRequest(message);
        else this.onNotification?.(message.method, record(message.params));
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexRpcError(message.error.message || 'Codex 协议请求失败', message.error.code));
      else pending.resolve(message.result);
    });
    this.child.once('close', () => lines.close());
  }

  get isClosed(): boolean { return this.closed; }

  async initialize(): Promise<void> {
    this.initialized = record(await this.request('initialize', {
      clientInfo: { name: 'feishu_codex', title: 'Feishu Codex', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }));
    this.write({ method: 'initialized', params: {} });
  }

  request(method: string, params: RecordValue, timeoutMs = this.options.requestTimeoutMs ?? 45_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(readableError(error)); }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail(new Error('Codex 连接已关闭'));
      this.child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { this.child.kill(); resolve(); }, 1_500);
      })]);
      if (timer) clearTimeout(timer);
      // Wait for the owned process to actually exit before another turn may acquire its thread.
      await this.exited;
    })();
    return this.closing;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onFailure?.(error);
  }

  private write(message: Wire): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Codex 连接已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async serverRequest(message: Wire): Promise<void> {
    try {
      if (!this.onRequest) throw new Error(`不支持的服务端请求：${message.method}`);
      const result = await this.onRequest(message.method!, record(message.params));
      if (!this.closed) this.write({ id: message.id, result });
    } catch (error) {
      if (!this.closed) this.write({ id: message.id, error: { code: -32603, message: readableError(error).message } });
    }
  }
}

class TurnTracker {
  threadId?: string;
  readonly result: Promise<string>;
  private resolve!: (text: string) => void;
  private reject!: (error: Error) => void;
  private turnId?: string;
  private done = false;
  private readonly items = new Map<string, { text: string; phase: string }>();
  private readonly earlyEvents: Array<{ method: string; params: RecordValue }> = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly input: CodexRunInput, private readonly idleTimeoutMs: number, private readonly strictTurn = false) {
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A process can fail before thread/start resolves; its error is still awaited by run().
    void this.result.catch(() => undefined);
    if (!strictTurn) this.touch();
  }

  setTurn(id: string): void {
    this.turnId = id;
    this.touch();
    for (const event of this.earlyEvents.splice(0)) this.notification(event.method, event.params);
  }

  notification(method: string, params: RecordValue): void {
    if (this.done || !this.threadId || string(params.threadId) !== this.threadId) return;
    if (!this.turnId) { this.earlyEvents.push({ method, params }); return; }
    const turn = record(params.turn);
    const eventTurn = string(params.turnId) || string(turn.id);
    if ((eventTurn && eventTurn !== this.turnId) || (this.strictTurn && !eventTurn)) return;
    this.touch();
    const item = record(params.item);
    const itemId = string(item.id) || string(params.itemId);
    if ((method === 'item/started' || method === 'item/completed') && item.type === 'agentMessage') {
      const previous = this.items.get(itemId);
      const text = string(item.text) || previous?.text || '';
      const phase = string(item.phase) || previous?.phase || '';
      this.items.set(itemId, { text, phase });
      if (method === 'item/completed' && phase === 'commentary' && text) this.progress(text);
    } else if (method === 'item/agentMessage/delta') {
      const previous = this.items.get(itemId) ?? { text: '', phase: '' };
      this.items.set(itemId, { ...previous, text: previous.text + string(params.delta) });
    } else if (method === 'turn/completed') {
      const snapshotMessages: Array<{ text: string; phase: string }> = [];
      for (const value of array(turn.items)) {
        const completed = record(value);
        if (completed.type === 'agentMessage') {
          const id = string(completed.id);
          const previous = this.items.get(id);
          const message = { text: string(completed.text) || previous?.text || '', phase: string(completed.phase) || previous?.phase || '' };
          snapshotMessages.push(message);
          this.items.set(id, message);
        }
      }
      this.done = true;
      this.dispose();
      if (turn.status === 'failed') this.reject(new Error(string(record(turn.error).message) || 'Codex 执行失败'));
      else if (turn.status === 'interrupted') this.reject(new Error('已停止当前任务'));
      else {
        // Steering can produce several final answers in one native turn. Only
        // the last answer is current. The terminal snapshot establishes order;
        // replayed item events may have populated the Map in a different order.
        const snapshot = snapshotMessages.reverse();
        const streamed = [...this.items.values()].reverse();
        const isFinal = (value: { text: string; phase: string }) => value.phase === 'final_answer' && value.text.trim();
        const isReply = (value: { text: string; phase: string }) => value.phase !== 'commentary' && value.text.trim();
        const finalText = snapshot.find(isFinal)?.text ?? streamed.find(isFinal)?.text
          ?? snapshot.find(isReply)?.text ?? streamed.find(isReply)?.text;
        this.resolve(finalText?.trim() || '本轮处理已完成，Codex 未返回文本。');
      }
    } else if (method === 'error' && params.willRetry !== true) {
      this.fail(new Error(string(record(params.error).message) || 'Codex 执行失败'));
    }
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.dispose();
    this.reject(error);
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); }
  private touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error('Codex 长时间未返回事件，请检查网络后重试。')), this.idleTimeoutMs);
  }
  private progress(text: string): void {
    try { void Promise.resolve(this.input.onProgress?.(text)).catch(() => undefined); }
    catch { /* Progress rendering cannot fail a turn. */ }
  }
}

async function handleRuntimeRequest(input: CodexRunInput, method: string, params: RecordValue): Promise<unknown> {
  if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1_000) };
  const id = randomUUID();
  const ask = async (request: Omit<RuntimeRequest, 'id'>): Promise<RuntimeAnswer> => {
    if (!input.onRequest) throw new Error('当前入口无法处理 Codex 的交互请求');
    return input.onRequest({ id, ...request });
  };
  if (method === 'item/tool/requestUserInput') {
    const questions = array(params.questions).map(value => {
      const question = record(value);
      return { id: string(question.id), question: string(question.question),
        options: array(question.options).map(option => ({ label: string(record(option).label), description: string(record(option).description) })) };
    });
    const answer = await ask({ kind: 'question', title: 'Codex 需要补充信息', text: questions.map(value => value.question).join('\n'), questions });
    return { answers: answer.answers ?? {} };
  }
  if (/^item\/(commandExecution|fileChange|permissions)\/requestApproval$/.test(method)) {
    const answer = await ask({ kind: 'approval', title: 'Codex 请求确认',
      text: [string(params.reason), string(params.command), string(params.grantRoot),
        params.permissions ? JSON.stringify(params.permissions) : ''].filter(Boolean).join('\n') || '请确认是否允许本次操作。' });
    if (method === 'item/permissions/requestApproval') return { permissions: answer.decision === 'accept' ? record(params.permissions) : {}, scope: 'turn' };
    return { decision: answer.decision === 'accept' ? 'accept' : 'decline' };
  }
  throw new Error(`不支持的 Codex 交互请求：${method}`);
}

export function resolveCodexCommand(bin = process.env.FEISHU_CODEX_BIN): Command {
  if (bin) {
    if (/\.(?:mjs|cjs|js)$/i.test(bin)) return { command: process.execPath, args: [bin] };
    if (/\.(?:cmd|bat|ps1)$/i.test(bin)) throw new Error('FEISHU_CODEX_BIN 请指向 codex.exe 或 codex.js，不能使用 Shell 启动脚本。');
    return { command: bin, args: [] };
  }
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const onPath = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory.replace(/^"|"$/g, ''), executable)).find(existsSync);
  if (onPath) return { command: onPath, args: [] };
  if (process.platform === 'win32') {
    const desktopRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const binaries = readdirSync(desktopRoot).map(directory => path.join(desktopRoot, directory, 'codex.exe')).filter(existsSync);
      binaries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (binaries[0]) return { command: binaries[0], args: [] };
    } catch { /* Fall back to the official npm package. */ }
    const npmCli = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(npmCli)) return { command: process.execPath, args: [npmCli] };
  }
  return { command: executable, args: [] };
}

function parseHistory(turns: unknown[]): HistoryMessage[] {
  return turns.flatMap(value => {
    const turn = record(value);
    const at = typeof turn.startedAt === 'number' ? new Date(turn.startedAt * 1_000).toISOString() : undefined;
    return array(turn.items).flatMap<HistoryMessage>(value => {
      const item = record(value);
      if (item.type === 'agentMessage' && item.phase !== 'commentary' && string(item.text)) return [{ role: 'assistant' as const, text: string(item.text), at, id: string(item.id), turnId: string(turn.id), phase: string(item.phase) }];
      if (item.type === 'userMessage') {
        const text = array(item.content).map(content => string(record(content).text)).filter(Boolean).join('\n');
        return text ? [{ role: 'user' as const, text, at, id: string(item.id), turnId: string(turn.id) }] : [];
      }
      return [];
    });
  });
}

function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readableError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isThreadWriterConflict(message)) return new Error(THREAD_WRITER_MESSAGE, { cause: error });
  if (/writer.*lock|already.*(?:running|in use)|thread.*busy|another.*process|会话正在处理/i.test(message)) {
    return new Error('这个 Codex 会话正在处理另一条消息，请等待完成或先停止。');
  }
  return error instanceof Error ? error : new Error(message);
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function generatedImageSnapshot(configuredHome: string | undefined, threadId: string): Promise<Map<string, GeneratedImageStamp>> {
  const snapshot = new Map<string, GeneratedImageStamp>();
  if (!threadId || path.basename(threadId) !== threadId || threadId === '.' || threadId === '..') return snapshot;
  const codexHome = configuredHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.resolve(codexHome, 'generated_images');
  const directory = path.resolve(root, threadId);
  if (!directory.startsWith(`${root}${path.sep}`)) return snapshot;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !GENERATED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(directory, entry.name);
      const info = await stat(file);
      if (info.isFile() && info.size > 0) snapshot.set(file, { size: info.size, mtimeMs: info.mtimeMs });
    }
  } catch { /* A turn without generated images has no output directory. */ }
  return snapshot;
}

async function newGeneratedImages(configuredHome: string | undefined, threadId: string, before: Map<string, GeneratedImageStamp>): Promise<string[]> {
  const after = await generatedImageSnapshot(configuredHome, threadId);
  return [...after.entries()]
    .filter(([file, stamp]) => {
      const previous = before.get(file);
      return !previous || previous.size !== stamp.size || previous.mtimeMs !== stamp.mtimeMs;
    })
    .sort((left, right) => left[1].mtimeMs - right[1].mtimeMs || left[0].localeCompare(right[0]))
    .map(([file]) => file);
}

function usageRecord(value: unknown, method: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Codex ${method} 返回了无效的响应`);
  return value as RecordValue;
}

function usageNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function usageString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }

function usageWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const window = record(value);
  return { usedPercent: usageNumber(window.usedPercent), windowDurationMins: usageNumber(window.windowDurationMins), resetsAt: usageNumber(window.resetsAt) };
}

function usageLimit(value: unknown, id?: string): UsageLimit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const limit = record(value);
  if (!['limitId', 'limitName', 'primary', 'secondary', 'credits', 'planType'].some(key => Object.hasOwn(limit, key))) return null;
  const credits = record(limit.credits);
  return {
    id: id || usageString(limit.limitId) || 'codex', name: usageString(limit.limitName), planType: usageString(limit.planType),
    primary: usageWindow(limit.primary), secondary: usageWindow(limit.secondary),
    credits: typeof credits.hasCredits === 'boolean' && typeof credits.unlimited === 'boolean'
      ? { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: usageString(credits.balance) } : null,
  };
}

function parseUsageLimits(response: RecordValue): UsageLimit[] {
  const buckets = Object.entries(record(response.rateLimitsByLimitId))
    .map(([id, value]) => id.trim() ? usageLimit(value, id) : null)
    .filter((value): value is UsageLimit => value !== null);
  if (buckets.length) return buckets;
  const legacy = usageLimit(response.rateLimits);
  if (legacy) return [legacy];
  if (response.rateLimits != null || (response.rateLimitsByLimitId != null &&
      (typeof response.rateLimitsByLimitId !== 'object' || Array.isArray(response.rateLimitsByLimitId) || Object.keys(record(response.rateLimitsByLimitId)).length))) {
    throw new Error('Codex account/rateLimits/read 返回了无效的用量分组');
  }
  return [];
}
