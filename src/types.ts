export type ConnectionStatus = 'stopped' | 'connecting' | 'connected' | 'error';
export type BridgeConfig = {
  appId: string; appSecret: string; enabled: boolean; allowedActors: string[];
  defaultWorkspace: string; model: string; effort: string; progress: boolean; autoNotifyDesktop: boolean;
  desktopNotificationMode: 'all' | 'long'; desktopNotificationMinMinutes: number;
};
export type Project = { path: string; name: string; threadCount: number; lastActiveAt: string };
export type ThreadSummary = { id: string; title: string; cwd: string; updatedAt: string; preview: string };
export type ModelInfo = { id: string; name: string; efforts: string[]; defaultEffort: string };
export type HistoryMessage = { role: 'user' | 'assistant'; text: string; at?: string; id?: string; turnId?: string; phase?: string };
export type Conversation = {
  chatId: string; actorId: string; title: string; cwd: string; threadId?: string;
  revision?: number;
  model?: string; effort?: string; updatedAt: string; preview: string;
};
export type LogEntry = { id: string; at: string; level: 'info' | 'warn' | 'error'; text: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string; streaming?: boolean; phase?: string; turnId?: string };
export type InboundMessage = {
  id: string; chatId: string; actorId: string; text: string; at?: string;
  images?: string[]; files?: string[]; actionMessageId?: string;
  /** Internal management preview flag; never accepted from Feishu event payloads. */
  localOnly?: boolean;
  expectedRevision?: number;
  expectedThreadId?: string;
};
export type CardButton = { label: string; command: string; primary?: boolean };
export type MessageCard = { title: string; text: string; tone?: 'blue' | 'green' | 'orange' | 'red'; buttons?: CardButton[] };
export type CodexQuestion = { id: string; question: string; options?: { label: string; description?: string }[] };
export type RuntimeRequest = {
  id: string; kind: 'approval' | 'question'; title: string; text: string;
  questions?: CodexQuestion[];
};
export type RuntimeAnswer = { decision?: 'accept' | 'decline'; answers?: Record<string, { answers: string[] }> };
export type CodexRunInput = {
  cwd: string; threadId?: string; prompt: string; images?: string[]; model?: string; effort?: string;
  onThread?: (id: string) => void;
  onProgress?: (text: string) => void;
  onRequest?: (request: RuntimeRequest) => Promise<RuntimeAnswer>;
  onSubmitted?: (event: { threadId: string; turnId?: string; mode: 'start' | 'steer'; status: 'submitting' | 'submitted' | 'uncertain' | 'rejected' }) => void;
  onBeforeSubmit?: () => void | Promise<void>;
};
export type RuntimeEvent = { method: string; threadId?: string; turnId?: string; params?: Record<string, unknown> };
export type BridgeEvent = { type: 'state' | 'history' | 'runtime'; chatId?: string; threadId?: string; event?: RuntimeEvent; delta?: { threadId: string; turnId: string; itemId: string; text: string; phase?: string } };
export type Operation = { id: string; chatId: string; actorId: string; cwd: string; threadId?: string; revision: number; source: 'feishu' | 'management'; status: 'received' | 'submitting' | 'submitted' | 'uncertain' | 'completed' | 'failed'; turnId?: string; mode?: 'start' | 'steer'; at: string; updatedAt: string; error?: string };
export type CompletionNotification = {
  id: string; threadId: string; turnId: string; chatId: string; actorId: string;
  cwd: string; title: string; requestedAt: string;
  status: 'registered' | 'sent' | 'uncertain' | 'cancelled' | 'skipped';
  automatic?: boolean; sessionTitle?: string; result?: string;
  timing?: TurnTiming; skipReason?: 'short' | 'timing-unavailable';
  outcome?: 'completed' | 'failed' | 'interrupted'; completedAt?: string; messageId?: string;
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
  close(): Promise<void>;
  usage?(): Promise<CodexUsage>;
}
export interface FeishuTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  sendText(chatId: string, text: string): Promise<string>;
  sendCard(chatId: string, card: MessageCard): Promise<string>;
  sendImage(chatId: string, imagePath: string): Promise<string>;
  sendFile(chatId: string, filePath: string): Promise<string>;
  updateCard(messageId: string, card: MessageCard): Promise<void>;
  startTyping(messageId: string): Promise<() => Promise<void>>;
}
export type FeishuOptions = {
  appId: string; appSecret: string; attachmentDir: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  log: (level: LogEntry['level'], text: string) => void;
  allowAttachments?: (actorId: string) => boolean;
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
