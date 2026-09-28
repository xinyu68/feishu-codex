import type { TurnTiming } from './types.js';

// App-server timestamps are epoch seconds; durationMs is already milliseconds.
export function readTurnTiming(turn?: Record<string, unknown>): TurnTiming {
  const timing: TurnTiming = {};
  if (typeof turn?.startedAt === 'number' && Number.isFinite(turn.startedAt) && turn.startedAt > 0) timing.startedAtMs = turn.startedAt * 1000;
  if (typeof turn?.completedAt === 'number' && Number.isFinite(turn.completedAt) && turn.completedAt > 0) timing.completedAtMs = turn.completedAt * 1000;
  if (typeof turn?.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) timing.durationMs = turn.durationMs;
  return timing;
}

export function turnDuration(timing?: TurnTiming): number | undefined {
  if (timing?.durationMs !== undefined && Number.isFinite(timing.durationMs) && timing.durationMs >= 0) return timing.durationMs;
  if (timing?.startedAtMs === undefined || timing.completedAtMs === undefined) return undefined;
  const duration = timing.completedAtMs - timing.startedAtMs;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
