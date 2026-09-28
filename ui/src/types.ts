export type Project = { path: string; name: string; threadCount: number; lastActiveAt: string };
export type Session = { id: string; title: string; cwd: string; updatedAt: string; preview: string };
export type Message = { id: string; role: 'user' | 'assistant' | 'system'; text: string; at?: string; streaming?: boolean; phase?: string; turnId?: string };
export type Conversation = {
  chatId: string; actorId: string; title: string; cwd: string; threadId?: string;
  botId?: string; botName?: string; rawChatId?: string; chatType?: 'p2p' | 'group'; chatTitle?: string;
  revision?: number; updatedAt: string; preview: string; busy: boolean; queued?: number;
  progress?: string; model?: string; effort?: string;
  activeTurnId?: string; startedAt?: string; lastActivityAt?: string;
};
export type Config = {
  appId: string; hasSecret: boolean; enabled: boolean; allowedActors: string[];
  defaultWorkspace: string; model: string; effort: string; progress: boolean; autoNotifyDesktop: boolean;
  desktopNotificationMode: 'all' | 'long'; desktopNotificationMinMinutes: number;
};
export type PendingRequest = {
  id: string; chatId: string; kind: 'approval' | 'question'; title: string; text: string;
  questions?: { id: string; question: string; options?: { label: string; description?: string }[] }[];
};
export type AppState = {
  csrfToken: string;
  service: { name: string; version: string; uptimeSeconds: number; startedAt: string };
  config: Config;
  connection: { status: 'stopped' | 'connecting' | 'connected' | 'error'; detail?: string };
  connectionSummary?: { status: 'stopped' | 'connecting' | 'connected' | 'error'; detail?: string; connected: number; total: number };
  codex: { available: boolean; authenticated?: boolean; version?: string; mode?: string; error?: string };
  runtime?: DesktopStatus;
  conversations: Conversation[];
  bots?: BotProfile[];
  pendingActors: { actorId: string; chatId: string; lastSeenAt: string; botId?: string; botName?: string }[];
  pendingGroups?: { botId: string; chatId: string; title?: string; actorId?: string; lastSeenAt?: string }[];
  pendingRequests: PendingRequest[];
  logs: { id: string; at: string; level: 'info' | 'warn' | 'error'; text: string }[];
};
export type BotProfile = {
  id: string; name: string; appId: string; hasSecret: boolean; enabled: boolean;
  allowedActors: string[]; allowedGroups: string[]; roleInstructions: string; model: string; effort: string;
  connection: AppState['connection'];
};
export type DesktopStatus = {
  shellVersion?: string;
  state?: string; canWrite?: boolean; reason?: string; actionError?: string;
  phase?: string; message?: string; error?: string;
  runtime?: { state?: string; status?: string; detail?: string };
  bridge?: { state?: string; status?: string; detail?: string };
  desktop?: { mode?: string; running?: boolean };
  launch?: { state: 'idle' | 'opening' | 'confirming' | 'switching' | 'error'; message?: string };
  [key: string]: unknown;
};
export type DesktopPreferences = { openCodexOnLaunch: boolean; openAtLogin: boolean; closeWindowAction: 'tray' | 'quit' };
export type DesktopAction = 'openCodex' | 'retry' | 'openLogs' | 'quit' | 'switchToShared';
export type DesktopResult = { ok?: boolean; error?: string; message?: string; [key: string]: unknown } | void;
declare global {
  interface Window {
    feishuCodex?: {
      getStatus(): Promise<DesktopStatus>;
      openCodex(): Promise<DesktopResult>;
      retry(): Promise<DesktopResult>;
      openLogs(): Promise<DesktopResult>;
      quit(): Promise<DesktopResult>;
      getPreferences(): Promise<DesktopPreferences>;
      setPreferences(preferences: DesktopPreferences): Promise<DesktopPreferences>;
      chooseWorkspace(): Promise<string | null>;
      switchToShared(): Promise<DesktopResult>;
      setupFresh(): Promise<DesktopResult>;
      restoreExisting(): Promise<DesktopResult>;
      migrate(): Promise<DesktopResult>;
      onStatus?(callback: (status: DesktopStatus) => void): () => void;
    };
  }
}
