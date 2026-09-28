import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportRouter } from '../src/transport-router.js';
import { messageKey } from '../src/routing.js';
import type { FeishuTransport } from '../src/types.js';

function client(recallCard?: (messageId: string) => Promise<void>, markCompleted?: (messageId: string) => Promise<void>): FeishuTransport {
  return {
    async start() {}, async close() {},
    async sendText() { return 'om_reply'; }, async sendCard() { return 'om_reply'; },
    async sendImage() { return 'om_reply'; }, async sendFile() { return 'om_reply'; },
    async updateCard() {}, async startTyping() { return async () => {}; },
    ...(recallCard ? { recallCard } : {}),
    ...(markCompleted ? { markCompleted } : {}),
  };
}

test('card recall routes each namespaced message to its original bot using the raw ID', async () => {
  const router = new TransportRouter();
  const calls: Array<[string, string]> = [];
  router.set('default', client(async id => { calls.push(['default', id]); }));
  router.set('dev', client(async id => { calls.push(['dev', id]); }));
  await router.recallCard('om_same');
  await router.recallCard(messageKey('dev', 'om_same'));
  assert.deepEqual(calls, [['default', 'om_same'], ['dev', 'om_same']]);
});

test('missing, disconnected, or unsupported recall targets never fall back to another bot', async () => {
  const router = new TransportRouter();
  const calls: string[] = [];
  router.set('default', client(async id => { calls.push(id); }));
  await assert.rejects(router.recallCard(messageKey('absent', 'om_card')), /尚未就绪/);
  router.set('dev', client(async id => { calls.push(`dev:${id}`); }), false);
  await assert.rejects(router.recallCard(messageKey('dev', 'om_card')), /尚未就绪/);
  router.set('dev', client());
  await assert.rejects(router.recallCard(messageKey('dev', 'om_card')), /不支持撤回卡片/);
  router.delete('dev');
  await assert.rejects(router.recallCard(messageKey('dev', 'om_card')), /尚未就绪/);
  assert.deepEqual(calls, []);
});

test('the original bot recall error is propagated without trying another connected bot', async () => {
  const router = new TransportRouter();
  const calls: string[] = [];
  const error = new Error('original bot recall failed');
  router.set('default', client(async id => { calls.push(`default:${id}`); }));
  router.set('dev', client(async id => { calls.push(`dev:${id}`); throw error; }));
  await assert.rejects(router.recallCard(messageKey('dev', 'om_card')), actual => actual === error);
  assert.deepEqual(calls, ['dev:om_card']);
});

test('completion reactions route to the original bot with the raw message ID', async () => {
  const router = new TransportRouter();
  const calls: Array<[string, string]> = [];
  router.set('default', client(undefined, async id => { calls.push(['default', id]); }));
  router.set('dev', client(undefined, async id => { calls.push(['dev', id]); }));
  await router.markCompleted('om_original');
  await router.markCompleted(messageKey('dev', 'om_original'));
  assert.deepEqual(calls, [['default', 'om_original'], ['dev', 'om_original']]);
});

test('missing, disconnected and unsupported completion targets never fall back to another bot', async () => {
  const router = new TransportRouter();
  const calls: string[] = [];
  router.set('default', client(undefined, async id => { calls.push(id); }));
  await assert.rejects(router.markCompleted(messageKey('absent', 'om_original')), /尚未就绪/);
  router.set('dev', client(undefined, async id => { calls.push(`dev:${id}`); }), false);
  await assert.rejects(router.markCompleted(messageKey('dev', 'om_original')), /尚未就绪/);
  router.set('dev', client());
  await assert.rejects(router.markCompleted(messageKey('dev', 'om_original')), /不支持完成表情/);
  router.delete('dev');
  await assert.rejects(router.markCompleted(messageKey('dev', 'om_original')), /尚未就绪/);
  assert.deepEqual(calls, []);
});

test('completion errors propagate from the original bot without retrying another bot', async () => {
  const router = new TransportRouter();
  const calls: string[] = [];
  const error = new Error('original bot completion failed');
  router.set('default', client(undefined, async id => { calls.push(`default:${id}`); }));
  router.set('dev', client(undefined, async id => { calls.push(`dev:${id}`); throw error; }));
  await assert.rejects(router.markCompleted(messageKey('dev', 'om_original')), actual => actual === error);
  assert.deepEqual(calls, ['dev:om_original']);
});
