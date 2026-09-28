import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { conversationKey, namespaceMessage } from '../src/routing.js';
import type { InboundMessage } from '../src/types.js';

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-actor-identity-'));
  const store = new Store(dir);
  store.saveConfig({ appId: 'cli_default', allowedActors: ['ou_source'], allowedGroups: ['oc_team', 'oc_other'] });
  store.saveBot('dev', { appId: 'cli_developer', name: '开发', allowedActors: ['ou_target', 'ou_second'], allowedGroups: ['oc_team', 'oc_other'] });
  let serial = 0;
  const message = (botId: string, fields: Partial<InboundMessage> = {}): InboundMessage => namespaceMessage(botId, {
    id: `om_${++serial}`, actorId: botId === 'default' ? 'ou_source' : 'ou_target',
    chatId: 'oc_team', chatType: 'group', text: '你好', ...fields,
  });
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('group-actor-identity-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, message };
}

test('separate app open IDs resolve only through observed tenant-scoped identity', t => {
  const { store, message, dir } = fixture(t);
  const identity = { actorTenantKey: 'tenant_a', actorUnionId: 'on_shared' };
  store.rememberActorIdentity(message('default', identity));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.rememberActorIdentity(message('dev', identity));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
  assert.equal(store.resolveGroupActor(conversationKey('dev', 'oc_team'), 'ou_target', 'default'), 'ou_source');
  assert.equal(new Store(dir).resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
  assert.equal(store.resolveGroupActor('oc_other', 'ou_source', 'dev'), undefined);
});

test('same tenant user IDs can relate applications with different developer union IDs', t => {
  const { store, message } = fixture(t);
  store.rememberActorIdentity(message('default', { actorTenantKey: 'tenant_a', actorUnionId: 'on_developer_a', actorUserId: 'person' }));
  store.rememberActorIdentity(message('dev', { actorTenantKey: 'tenant_a', actorUnionId: 'on_developer_b', actorUserId: 'person' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
});

test('names and single-entry allowlists never establish a cross-app identity', t => {
  const { store, message } = fixture(t);
  store.saveBot('dev', { allowedActors: ['ou_target'] });
  store.rememberActorIdentity(message('default', { senderName: '同一个名字' }));
  store.rememberActorIdentity(message('dev', { senderName: '同一个名字' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.rememberActorIdentity(message('default', { actorUnionId: 'on_shared' }));
  store.rememberActorIdentity(message('dev', { actorUnionId: 'on_shared' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
});

test('an identical real group message seen by both bots is explicit identity evidence', t => {
  const { store, message } = fixture(t);
  store.rememberActorIdentity(message('default', { id: 'om_both_mentioned' }));
  store.rememberActorIdentity(message('dev', { id: 'om_both_mentioned' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
  for (let i = 0; i < 12; i++) store.rememberActorIdentity(message('default'));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
  store.saveBot('dev', { allowedActors: ['ou_second'] });
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
});

test('tenant conflict, conflicting principal evidence and ambiguous targets fail closed', t => {
  const { store, message } = fixture(t);
  store.rememberActorIdentity(message('default', { id: 'om_same', actorTenantKey: 'tenant_a', actorUnionId: 'on_shared', actorUserId: 'person_a' }));
  store.rememberActorIdentity(message('dev', { id: 'om_same', actorTenantKey: 'tenant_b', actorUnionId: 'on_shared', actorUserId: 'person_a' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.rememberActorIdentity(message('dev', { actorTenantKey: 'tenant_a', actorUnionId: 'on_shared', actorUserId: 'person_b' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.rememberActorIdentity(message('dev', { actorTenantKey: 'tenant_a', actorUnionId: 'on_shared', actorUserId: 'person_a' }));
  store.rememberActorIdentity(message('dev', { actorId: 'ou_second', actorTenantKey: 'tenant_a', actorUnionId: 'on_shared', actorUserId: 'person_a' }));
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
});

test('unapproved actors, groups, management and synthetic messages cannot record identity', t => {
  const { store, message } = fixture(t);
  for (const fields of [
    { actorId: 'ou_stranger' }, { chatId: 'oc_forbidden' }, { localOnly: true },
    { chatType: 'p2p' as const }, { id: 'handoff:chain:1' }, { id: 'card:some-action' },
  ]) store.rememberActorIdentity(message('default', { actorTenantKey: 'tenant', actorUnionId: 'on_shared', ...fields }));
  assert.deepEqual(store.state.groupActorIdentities, {});
});

test('revoking either endpoint or its group invalidates identity mapping immediately', t => {
  const { store, message } = fixture(t);
  const identity = { actorTenantKey: 'tenant', actorUnionId: 'on_shared' };
  store.rememberActorIdentity(message('default', identity));
  store.rememberActorIdentity(message('dev', identity));
  store.saveBot('dev', { allowedGroups: [] });
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.saveBot('dev', { allowedGroups: ['oc_team'] });
  store.saveConfig({ allowedActors: [] });
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
});

test('app replacement and bot removal clear actor and bot metadata without secret copies', t => {
  const { store, message, dir } = fixture(t);
  store.saveBot('dev', { appSecret: 'secret_not_for_state' });
  store.rememberBotIdentity('dev', { openId: 'ou_bot', name: 'Codex-开发' });
  store.rememberActorIdentity(message('default', { id: 'om_shared' }));
  store.rememberActorIdentity(message('dev', { id: 'om_shared' }));
  assert.deepEqual(store.botIdentity('dev'), { openId: 'ou_bot', name: 'Codex-开发', appId: 'cli_developer' });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), /secret_not_for_state/);
  store.saveBot('dev', { appId: 'cli_replacement' });
  assert.equal(store.botIdentity('dev'), undefined);
  assert.equal(store.resolveGroupActor('oc_team', 'ou_source', 'dev'), undefined);
  store.rememberActorIdentity(message('dev', { id: 'om_shared' }));
  store.rememberBotIdentity('dev', { openId: 'ou_new_bot', name: '新机器人' });
  store.removeBot('dev');
  assert.equal(store.botIdentity('dev'), undefined);
  assert.equal(store.state.groupActorIdentities.oc_team!.some(item => item.botId === 'dev'), false);
});

test('group observation persists identity for both app events despite public journal deduplication', t => {
  const { store, message, dir } = fixture(t);
  let emissions = 0;
  store.subscribe(() => { emissions++; });
  const original = message('default', { id: 'om_both' });
  const target = message('dev', { id: 'om_both' });
  store.observeGroup(original);
  store.observeGroup(target);
  assert.equal(store.state.groupMessages.oc_team!.length, 1);
  assert.equal(emissions, 2);
  store.observeGroup(target);
  store.rememberActorIdentity(target);
  assert.equal(emissions, 2);
  assert.equal(new Store(dir).resolveGroupActor('oc_team', 'ou_source', 'dev'), 'ou_target');
  store.rememberBotIdentity('dev', { openId: 'ou_bot', name: '开发' });
  const before = emissions;
  store.rememberBotIdentity('dev', { openId: 'ou_bot', name: '开发' });
  assert.equal(emissions, before);
});

test('identity caches cap groups, actors and message evidence', t => {
  const { store, message } = fixture(t);
  store.rememberActorIdentity(message('default'));
  const original = store.state.groupActorIdentities.oc_team![0]!;
  store.state.groupActorIdentities.oc_team = Array.from({ length: 200 }, (_, i) => ({ ...original, actorId: `other_${i}` }));
  for (let i = 0; i < 101; i++) store.state.groupActorIdentities[`oc_old_${i}`] = [{ ...original, updatedAt: '2000-01-01' }];
  store.rememberActorIdentity(message('default'));
  assert.equal(store.state.groupActorIdentities.oc_team!.length, 200);
  assert.equal(Object.keys(store.state.groupActorIdentities).length, 100);
  for (let i = 0; i < 10; i++) store.rememberActorIdentity(message('default'));
  assert.equal(store.state.groupActorIdentities.oc_team!.at(-1)!.messageIds.length, 8);
});

test('remembering a group thread preserves its successful handoff policy migration', t => {
  const { store } = fixture(t);
  const conversation = store.conversation('oc_team', 'ou_source', undefined, 'group');
  conversation.threadId = 'thread_group';
  store.rememberThread(conversation, '原来的角色');
  store.state.threadBindings.thread_group!.groupHandoffPolicyVersion = 1;
  store.rememberThread(conversation);
  assert.equal(store.state.threadBindings.thread_group!.groupHandoffPolicyVersion, 1);
  assert.equal(store.state.threadBindings.thread_group!.roleInstructions, '原来的角色');
});
