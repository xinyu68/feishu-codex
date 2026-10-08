import type { AppState, Config } from './types';

export type NotificationEngine = 'codex' | 'hermes';
export const notificationEngines = ['codex', 'hermes'] as const;
export const notificationField = (engine: NotificationEngine) => engine === 'hermes' ? 'hermesNotificationTarget' : 'desktopNotificationTarget';
export const notificationEngineLabel = (engine: NotificationEngine) => engine === 'hermes' ? 'Hermes' : 'Codex';
export const notificationValue = (config: Config, draft: Partial<Config>, engine: NotificationEngine) => {
  const field = notificationField(engine);
  return draft[field] !== undefined ? draft[field] : config[field];
};
export const notificationTargetsFor = (state: AppState, engine: NotificationEngine) =>
  (state.notificationTargets || []).filter(target =>
    (target.engine ?? state.bots?.find(bot => bot.id === target.botId)?.engine ?? 'codex') === engine);
