import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { conversationKey } from '../src/routing.js';

const appA = 'cli_1234567890abcdef';
const appB = 'cli_abcdef0123456789';
const targetA = { chatId: 'oc_a', actorId: 'ou_a', botAppId: appA };
const targetB = { chatId: conversationKey('product', 'oc_b'), actorId: 'ou_b', botAppId: appB };

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-default-notification-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}

function savedConfig(store: Store) {
  return JSON.parse(fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8'));
}

function makeDefaultAvailable(store: Store) {
  store.saveConfig({ appId: appA, appSecret: 'fixture-a', allowedActors: ['ou_a'] });
  store.conversation(targetA.chatId, targetA.actorId, store.dir, 'p2p');
}

function makeProductAvailable(store: Store) {
  store.saveBot('product', { name: '产品经理', appId: appB, appSecret: 'fixture-b', allowedActors: ['ou_b'] });
  store.conversation(targetB.chatId, targetB.actorId, store.dir, 'p2p');
}

function removeSavedSelection(store: Store) {
  const config = savedConfig(store);
  delete config.desktopNotificationTarget;
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify(config));
}

for (const order of [
  ['credentials', 'authorization', 'conversation'], ['credentials', 'conversation', 'authorization'],
  ['authorization', 'credentials', 'conversation'], ['authorization', 'conversation', 'credentials'],
  ['conversation', 'credentials', 'authorization'], ['conversation', 'authorization', 'credentials'],
]) {
  test(`the first authorized private recipient is pinned with arrival order ${order.join(' → ')}`, t => {
    const store = fixture(t);
    const changes: Record<string, () => void> = {
      credentials: () => store.saveConfig({ appId: appA, appSecret: 'fixture-a' }),
      authorization: () => store.authorize('ou_a', true),
      conversation: () => { store.conversation('oc_a', 'ou_a', store.dir, 'p2p'); },
    };
    const emittedDefaults: unknown[] = [];
    store.subscribe(() => {
      if (!store.config.desktopNotificationTarget) return;
      emittedDefaults.push(savedConfig(store).desktopNotificationTarget);
    });
    for (const [index, operation] of order.entries()) {
      changes[operation]!();
      if (index < 2) assert.equal(store.config.desktopNotificationTarget, undefined);
    }
    assert.ok(emittedDefaults.length > 0);
    for (const target of emittedDefaults) assert.deepEqual(target, targetA, 'persist before publishing the new default');
    assert.deepEqual(store.config.desktopNotificationTarget, targetA);
    assert.deepEqual(savedConfig(store).desktopNotificationTarget, targetA);
    assert.deepEqual(new Store(store.dir).config.desktopNotificationTarget, targetA);
  });
}

test('the first eligible robot stays the default when other robots become available', t => {
  const store = fixture(t);
  makeProductAvailable(store);
  assert.deepEqual(store.config.desktopNotificationTarget, targetB, 'the legacy default bot ID has no routing priority');
  makeDefaultAvailable(store);
  assert.equal(store.notificationTargets().length, 2);
  assert.deepEqual(store.config.desktopNotificationTarget, targetB);
  assert.deepEqual(new Store(store.dir).config.desktopNotificationTarget, targetB);
});

test('an explicit clear remains cleared through setup, restart, and candidate changes', t => {
  const store = fixture(t);
  store.saveConfig({ desktopNotificationTarget: null });
  makeDefaultAvailable(store);
  makeProductAvailable(store);
  store.authorize('ou_b', false, 'product');
  assert.equal(store.notificationTargets().length, 1);
  assert.equal(store.config.desktopNotificationTarget, null);
  assert.equal(new Store(store.dir).config.desktopNotificationTarget, null);
});

test('revocation, app replacement, and removal retain the pinned identity instead of selecting another recipient', t => {
  for (const change of ['revoke', 'app-id', 'remove']) {
    const store = fixture(t);
    makeProductAvailable(store);
    makeDefaultAvailable(store);
    if (change === 'revoke') store.authorize('ou_b', false, 'product');
    else if (change === 'app-id') store.saveBot('product', { appId: 'cli_1111111111111111' });
    else store.removeBot('product');
    assert.deepEqual(store.config.desktopNotificationTarget, targetB, change);
    assert.deepEqual(new Store(store.dir).config.desktopNotificationTarget, targetB, change);
  }
});

test('existing data without a selection initializes only when the saved private recipient is unambiguous', t => {
  const unique = fixture(t);
  makeProductAvailable(unique);
  removeSavedSelection(unique);
  const restored = new Store(unique.dir);
  assert.deepEqual(restored.config.desktopNotificationTarget, targetB);
  assert.deepEqual(savedConfig(restored).desktopNotificationTarget, targetB);

  const ambiguous = fixture(t);
  ambiguous.saveConfig({ desktopNotificationTarget: null });
  makeDefaultAvailable(ambiguous);
  makeProductAvailable(ambiguous);
  removeSavedSelection(ambiguous);
  const configBefore = fs.readFileSync(path.join(ambiguous.dir, 'config.json'), 'utf8');
  const unchanged = new Store(ambiguous.dir);
  assert.equal(unchanged.notificationTargets().length, 2);
  assert.equal(unchanged.config.desktopNotificationTarget, undefined);
  assert.equal(fs.readFileSync(path.join(ambiguous.dir, 'config.json'), 'utf8'), configBefore);
});

test('candidate discovery and hypothetical config validation never initialize or persist a default', t => {
  const store = fixture(t);
  store.saveConfig({ appId: appA, appSecret: 'fixture-a' });
  store.conversation('oc_a', 'ou_a', store.dir, 'p2p');
  const configBefore = fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8');
  assert.deepEqual(store.notificationTargets(), []);
  const candidates = store.notificationTargets({ ...store.config, allowedActors: ['ou_a'] });
  assert.equal(candidates.length, 1);
  assert.equal(store.config.desktopNotificationTarget, undefined);
  assert.equal(fs.readFileSync(path.join(store.dir, 'config.json'), 'utf8'), configBefore);
});

test('group, local preview, incomplete credentials, and missing private actor never become defaults', t => {
  const store = fixture(t);
  store.saveConfig({ appId: appA, allowedActors: ['ou_a'], allowedGroups: ['oc_group'] });
  store.conversation('oc_group', 'ou_a', store.dir, 'group');
  store.conversation('local-preview', 'ou_a', store.dir, 'p2p');
  store.conversation('oc_a', '', store.dir, 'p2p');
  store.saveConfig({ appSecret: 'fixture-a' });
  assert.equal(store.config.desktopNotificationTarget, undefined);
  store.state.conversations.oc_a!.actorId = 'ou_a';
  store.save();
  assert.deepEqual(store.config.desktopNotificationTarget, targetA);
  assert.deepEqual(savedConfig(store).desktopNotificationTarget, targetA);
});
