import assert from 'node:assert/strict';
import test from 'node:test';
import { isThreadInitializationRace } from '../src/codex-errors.js';

test('recognizes the empty-rollout window while a new thread is initializing', () => {
  assert.equal(isThreadInitializationRace('no rollout found for thread id 01a0d898'), true);
  assert.equal(isThreadInitializationRace(
    'failed to read thread: thread-store internal error: failed to read session metadata C:\\Users\\Developer\\.codex\\sessions\\rollout.jsonl: rollout at C:\\Users\\Developer\\.codex\\sessions\\rollout.jsonl is empty'
  ), true);
});

test('does not hide unrelated thread read failures', () => {
  assert.equal(isThreadInitializationRace('failed to read session metadata: permission denied'), false);
  assert.equal(isThreadInitializationRace('thread is locked by another process'), false);
});
