import test from 'node:test';
import assert from 'node:assert/strict';
import { quitWithConfirmation } from '../desktop/quit-confirmation.mjs';
import { finishConfirmedServices } from '../desktop/shutdown.mjs';

test('idle exit needs no dialog and confirmation never triggers another task check', async () => {
  let checks = 0, closed = 0;
  const result = await quitWithConfirmation({ assess: async () => { checks++; return { needsConfirmation: false }; },
    confirm: async () => { throw Error('No dialog expected'); }, shutdown: async () => { closed++; return { ok: true }; } });
  assert.equal(result.ok, true); assert.equal(checks, 1); assert.equal(closed, 1);
});

test('active tasks and unknown state both allow exit after explicit confirmation', async () => {
  for (const unknown of [false, true]) {
    let closed = 0, checks = 0;
    const result = await quitWithConfirmation({ assess: async () => { checks++; if (unknown) throw Error('offline'); return { needsConfirmation: true, detail: '正在运行' }; },
      confirm: async info => { assert.equal(info.needsConfirmation, true); assert.ok(info.detail); return true; },
      shutdown: async () => { closed++; return { ok: true }; } });
    assert.equal(result.ok, true); assert.equal(closed, 1); assert.equal(checks, 1);
  }
});

test('cancelling a busy or unknown exit never closes services', async () => {
  for (const unknown of [false, true]) {
    const result = await quitWithConfirmation({ assess: async () => { if (unknown) throw Error('offline'); return { needsConfirmation: true }; },
      confirm: async () => false, shutdown: async () => { throw Error('Must not close'); } });
    assert.deepEqual(result, { ok: false, cancelled: true });
  }
});

test('hung graceful cleanup is bounded and captured services are released in parallel', async () => {
  const started = [], finished = [];
  const pending = [];
  const closing = finishConfirmedServices({ graceful: () => new Promise(() => {}), graceMs: 10,
    release: ['bridge', 'runtime', 'relay'].map(name => async () => { started.push(name); await new Promise(resolve => pending.push(resolve)); finished.push(name); }) });
  while (started.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(started, ['bridge', 'runtime', 'relay']); assert.deepEqual(finished, []);
  for (const resolve of pending) resolve(); await closing; assert.equal(finished.length, 3);
});

test('graceful cleanup failure cannot veto confirmed exit but identity failures still surface', async () => {
  let released = 0;
  await finishConfirmedServices({ graceful: async () => { throw Error('Task state unknown'); }, release: [async () => { released++; }] });
  assert.equal(released, 1);
  await assert.rejects(finishConfirmedServices({ graceful: async () => {},
    release: [async () => { throw Error('进程身份已变化'); }, async () => { released++; }] }), /进程身份/);
  assert.equal(released, 2);
});
