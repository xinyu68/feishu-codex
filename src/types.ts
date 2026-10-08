export type ConnectionStatus = 'stopped' | 'connecting' | 'connected' | 'error';
export type BotProfile = {
  id: string; name: string; appId: string; appSecret: string; enabled: boolean;
  engine?: 'codex' | 'hermes';
  allowedActors: string[]; allowedGroups: string[]; roleInstructions: string; privateRoleInstructions?: string; model: string; effort: string;
  /** Automatically supplement recent group discussion; omitted legacy values default to true. */
  includeGroupContext?: boolean;
};
export type BridgeConfig = {
  appId: string; appSecret: string; enabled: boolean; allowedActors: string[];
  defaultWorkspace: string; model: string; effort: string; progress: boolean; autoNotifyDesktop: boolean;
  desktopNotificationMode: 'all' | 'long'; desktopNotificationMinMinutes: number;
  botName?: string; roleInstructions?: string; privateRoleInstructions?: string; allowedGroups?: string[]; bots?: BotProfile[];
  includeGroupContext?: boolean;
  desktopNotificationTarget?: DesktopNotificationTarget | null;
  hermesNotificationTarget?: DesktopNotificationTarget | null;
  engine?: 'codex' | 'hermes';
  /** The legacy first bot was explicitly removed; do not recreate its empty placeholder. */
  defaultBotRemoved?: boolean;
};
export type DesktopNotificationTarget = { chatId: string; actorId: string; botAppId: string };
export type DesktopNotificationTargetOption = DesktopNotificationTarget & { botId: string; botName: string };
export type Project = { path: string; name: string; threadCount: number; lastActiveAt: string };
export type ThreadSummary = { id: string; title: string; cwd: string; updatedAt: string; preview: string };
export type ModelInfo = { id: string; name: string; efforts: string[]; defaultEffort: string };
export type HistoryMessage = { role: 'user' | 'assistant'; text: string; at?: string; id?: string; turnId?: string; phase?: string };
export type GroupContextBoundary = { afterSequence: number; startedAt: string };
export type Conversation = {
  chatId: string; actorId: string; title: string; cwd: string; threadId?: string;
  botId?: string; rawChatId?: string; chatType?: 'p2p' | 'group'; botName?: string;
  revision?: number;
  /** Stable across a native session ID change caused by compaction; reset on an explicit switch. */
  consultationIdentity?: string;
  model?: string; effort?: string; updatedAt: string; preview: string;
  /** Automatic group background starts here; explicit quotations remain available. */
  groupContextBoundary?: GroupContextBoundary;
};
export type LogEntry = { id: string; at: string; level: 'info' | 'warn' | 'error'; text: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string; streaming?: boolean; phase?: string; turnId?: string };
export type InboundMessage = {
  id: string; chatId: string; actorId: string; text: string; at?: string;
  /** A real group mention without a question or attachment; acknowledge without running an agent. */
  mentionOnly?: boolean;
  botId?: string; rawChatId?: string; chatType?: 'p2p' | 'group'; senderName?: string; replyTo?: string; quotedText?: string;
  /** Identity fields from the authenticated Feishu event, never parsed from message text. */
  actorUnionId?: string; actorUserId?: string; actorTenantKey?: string;
  /** Internal bridge-only relay metadata; never accepted from an IM event or management request. */
  handoff?: { chainId: string; fromBotId: string; fromName: string; hop: number; sourceMessageId: string; originalTask: string };
  groupHandoffGuidance?: string;
  groupHumanGeneration?: number;
  /** Captured public background for this accepted message, never a live view of future messages. */
  groupContext?: string;
  images?: string[]; files?: string[]; actionMessageId?: string;
  /** Internal management preview flag; never accepted from Feishu event payloads. */
  localOnly?: boolean;
  expectedRevision?: number;
  expectedThreadId?: string;
};
export type CardButton = { label: string; command: string; primary?: boolean };
export type MessageCard = {
  title: string; text: string; tone?: 'blue' | 'green' | 'orange' | 'red'; buttons?: CardButton[];
  /** Bridge-resolved recipient identity; never inferred from display names or model text. */
  mention?: { openId: string };
};
export type CodexQuestion = { id: string; question: string; options?: { label: string; description?: string }[] };
export type RuntimeRequest = {
  id: string; kind: 'approval' | 'question'; title: string; text: string;
  questions?: CodexQuestion[];
};
export type RuntimeAnswer = { decision?: 'accept' | 'decline'; answers?: Record<string, { answers: string[] }> };
export type CodexRunInput = {
  cwd: string; threadId?: string; prompt: string; images?: string[]; model?: string; effort?: string;
  roleInstructions?: string;
  /** Bridge-owned channel identity; never inferred from user text. */
  channel?: 'feishu' | 'local-preview';
  /** Automated relay work must not steer a task already started on the desktop. */
  allowSteering?: boolean;
  onThread?: (id: string) => void;
  /** Completed Codex commentary only; transport acknowledgements are not task progress. */
  onProgress?: (text: string) => void;
  onRequest?: (request: RuntimeRequest) => Promise<RuntimeAnswer>;
  onSubmitted?: (event: { threadId: string; turnId?: string; mode: 'start' | 'steer'; status: 'submitting' | 'submitted' | 'uncertain' | 'rejected' }) => void;
  onBeforeSubmit?: () => void | Promise<void>;
  /** Resolve incremental background inside the runtime submission lock. */
  preparePrompt?: (threadId: string, options?: { compactChannelHeader: boolean }) => string | Promise<string>;
};
export type RuntimeEvent = { method: string; threadId?: string; turnId?: string; params?: Record<string, unknown> };
export type BridgeEvent = { type: 'state' | 'history' | 'runtime'; chatId?: string; threadId?: string; event?: RuntimeEvent; delta?: { threadId: string; turnId: string; itemId: string; text: string; phase?: string } };
export type GroupContextReceipt = { key: string; seen: Record<string, number>; promptHash: string; confirmed?: boolean };
export type Operation = { groupContext?: GroupContextReceipt; id: string; chatId: string; actorId: string; cwd: string; threadId?: string; revision: number; source: 'feishu' | 'management'; status: 'received' | 'submitting' | 'submitted' | 'uncertain' | 'completed' | 'failed'; turnId?: string; mode?: 'start' | 'steer'; at: string; updatedAt: string; error?: string };
export type CompletionNotification = {
  id: string; threadId: string; turnId: string; chatId: string; actorId: string;
  cwd: string; title: string; requestedAt: string;
  status: 'registered' | 'sent' | 'uncertain' | 'cancelled' | 'skipped';
  automatic?: boolean; sessionTitle?: string; result?: string;
  timing?: TurnTiming; skipReason?: 'short' | 'timing-unavailable';
  outcome?: 'completed' | 'failed' | 'interrupted'; completedAt?: string; messageId?: string;
  /** Pin the receiving application across configuration changes while a task is running. */
  botAppId?: string;
  chatType?: 'p2p' | 'group';
};
export type ArtifactDeliveryResult = {
  path: string; name: string; kind: 'image' | 'file';
  status: 'sent' | 'failed'; messageId?: string; error?: string;
};
export type ArtifactDelivery = {
  id: string; threadId: string; turnId: string; itemId: string; chatId: string; actorId: string;
  requestedAt: string; paths: string[];
  status: 'registered' | 'sending' | 'sent' | 'partial' | 'failed' | 'uncertain';
  results?: ArtifactDeliveryResult[]; summaryMessageId?: string;
};
export type RuntimeThreadInfo = { threadId: string; cwd: string; title: string; isUserThread?: boolean };
export type TurnTiming = { startedAtMs?: number; completedAtMs?: number; durationMs?: number };
export interface CodexRuntime {
  readonly supportsSteering?: boolean;
  run(input: CodexRunInput): Promise<{ threadId: string; text: string; turnId?: string; images?: string[] }>;
  /** A separate delegated task session; never resumes an ordinary chat. */
  consult?(input: RuntimeConsultInput): Promise<{ threadId: string; text: string }>;
  subscribe?(listener: (event: RuntimeEvent) => void): () => void;
  watch?(threadId: string): Promise<void>;
  watchLoaded?(): Promise<void>;
  unwatch?(threadId: string): Promise<void>;
  stop(threadId: string): Promise<void>;
  release(threadId: string): Promise<void>;
  models(): Promise<ModelInfo[]>;
  history(threadId: string): Promise<HistoryMessage[]>;
  status(): Promise<{ available: boolean; version?: string; authenticated?: boolean; error?: string }>;
  threadInfo?(threadId: string): Promise<RuntimeThreadInfo>;
  turnStatus?(threadId: string, turnId: string): Promise<'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown'>;
  turnTiming?(threadId: string, turnId: string): Promise<TurnTiming>;
  updateGroupHandoffPolicy?(threadId: string, instructions: string): Promise<void>;
  close(): Promise<void>;
  usage?(): Promise<CodexUsage>;
}
export type FeishuSendOptions = { signal?: AbortSignal; canSend?: () => boolean };

export interface FeishuTransport {
  isAvailable?(chatId: string): boolean;
  start(): Promise<void>;
  close(): Promise<void>;
  sendText(chatId: string, text: string): Promise<string>;
  sendCard(chatId: string, card: MessageCard, options?: FeishuSendOptions): Promise<string>;
  sendImage(chatId: string, imagePath: string): Promise<string>;
  sendFile(chatId: string, filePath: string): Promise<string>;
  updateCard(messageId: string, card: MessageCard, options?: FeishuSendOptions): Promise<void>;
  recallCard?(messageId: string): Promise<void>;
  markCompleted?(messageId: string): Promise<void>;
  startTyping(messageId: string): Promise<() => Promise<void>>;
}
export type FeishuOptions = {
  appId: string; appSecret: string; attachmentDir: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  log: (level: LogEntry['level'], text: string) => void;
  allowAttachments?: (actorId: string, chatId?: string, chatType?: 'p2p' | 'group') => boolean;
  allowGroup?: (chatId: string) => boolean;
  onGroupMessage?: (message: InboundMessage) => void | Promise<void>;
  onBotIdentity?: (identity: { openId: string; name: string }) => void;
};

export type GroupMessage = {
  id: string; chatId: string; botId: string; sender: string; role: 'user' | 'assistant';
  text: string; at: string; cwd: string; replyTo?: string;
  /** Native source thread; only this thread already knows its own result. */
  threadId?: string;
  /** Bridge-assigned observation order, independent of event timestamps. */
  sequence?: number;
};

export type UsageWindow = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
export type UsageLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
};
export type CodexUsage = {
  accountType: string;
  planType: string | null;
  limits: UsageLimit[];
  resetCredits: number | null;
  ordinaryUsageAllowed: boolean | null;
  fetchedAt: string;
};

export type RuntimeConsultInput = {
  cwd: string; threadId?: string; prompt: string; roleInstructions?: string; model?: string; effort?: string;
  /** Keep a dedicated consultation thread resumable across calls. */
  persistent?: boolean;
  engine?: 'codex' | 'hermes';
  signal: AbortSignal;
  onProgress?: (text: string) => void;
  onRequest?: (request: RuntimeRequest) => Promise<RuntimeAnswer>;
  /** Recheck the source authorization immediately before submitting the consultation. */
  onBeforeSubmit?: () => void | Promise<void>;
  /** Deliver an explicit artifact from this dedicated consultation to its original group. */
  onArtifact?: (request: { threadId: string; turnId: string; itemId: string; paths: string[] }) => Promise<void>;
};
