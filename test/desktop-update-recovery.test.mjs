import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexUpdateRecovery } from '../desktop/update-recovery.mjs';

const exe = version => `C:\\Program Files\\WindowsApps\\OpenAI.Codex_${version}_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe`;
const old = { pid: 11, exe: exe('26.1101.1000.0'), startedAt: '2026-11-10T01:00:00.000Z' };
const current = { pid: 22, exe: exe('26.1103.7773.0'), startedAt: '2026-11-10T02:00:00.000Z' };
function fixture() {
  let now = Date.parse(current.startedAt);
  const tracker = new CodexUpdateRecovery({ now: () => now });
  const snapshot = { processes: [old], desktopRoots: [old], desktopPackagePath: old.exe, unknownDesktop: false };
  tracker.observe(snapshot, { mode: 'shared' }, old);
  const upgrade = (roots = []) => ({ ...snapshot, desktopPackagePath: current.exe, desktopRoots: roots, processes: roots });
  return { tracker, snapshot, upgrade, advance: ms => { now += ms; } };
}

test('an observed shared desktop upgrade restores a closed window and retries with bounded backoff', () => {
  const f = fixture(), after = f.upgrade();
  assert.equal(f.tracker.observe(after, { mode: 'closed' }, old).state, 'recovering');
  assert.deepEqual(f.tracker.action(after, { mode: 'closed' }), { kind: 'open' });
  f.tracker.failed(); assert.equal(f.tracker.action(after, { mode: 'closed' }), null);
  f.advance(5000); assert.equal(f.tracker.action(after, { mode: 'closed' }).kind, 'open');
  f.advance(300001); assert.equal(f.tracker.observe(after, { mode: 'closed' }, old).state, 'expired');
  assert.equal(f.tracker.action(after, { mode: 'closed' }), null);
  f.tracker.retry(); assert.equal(f.tracker.action(after, { mode: 'closed' }).kind, 'open');
});

test('ordinary close, downgrade, stale launch records and independently opened apps grant no update intent', () => {
  for (const scenario of ['close', 'downgrade', 'stale', 'independent', 'still-running']) {
    const f = fixture(); let after = f.upgrade();
    if (scenario === 'close') after.desktopPackagePath = old.exe;
    if (scenario === 'downgrade') after.desktopPackagePath = exe('26.1001.1000.0');
    if (scenario === 'stale') f.advance(300001);
    if (scenario === 'independent') f.tracker.previous = null;
    if (scenario === 'still-running') after.processes = [old];
    assert.equal(f.tracker.observe(after, { mode: 'closed' }, old), null, scenario);
    assert.equal(f.tracker.action(after, { mode: 'closed' }), null, scenario);
  }
});

test('only a recent updater relaunch of the registered package can be reconnected', () => {
  const f = fixture(), after = f.upgrade([current]);
  f.tracker.observe(after, { mode: 'independent' }, old);
  assert.deepEqual(f.tracker.action(after, { mode: 'independent' }), { kind: 'reconnect', desktop: current });
  for (const root of [{ ...current, exe: old.exe }, { ...current, startedAt: old.startedAt }, { ...current, startedAt: '' }]) {
    assert.equal(f.tracker.action(f.upgrade([root]), { mode: 'independent' }), null);
  }
  assert.equal(f.tracker.action({ ...after, unknownDesktop: true }, { mode: 'unknown' }), null);
  assert.equal(f.tracker.action(f.upgrade([current, old]), { mode: 'independent' }), null);
});

test('already connected replacement completes recovery and becomes the baseline for the next update', () => {
  const f = fixture(); f.tracker.observe(f.upgrade(), { mode: 'closed' }, old);
  const after = f.upgrade([current]);
  assert.equal(f.tracker.observe(after, { mode: 'shared' }, old), null);
  assert.equal(f.tracker.action(after, { mode: 'shared' }), null);
  f.tracker.observe(after, { mode: 'shared' }, current);
  const next = { ...f.upgrade(), desktopPackagePath: exe('26.1110.1000.0') };
  assert.equal(f.tracker.observe(next, { mode: 'closed' }, current).state, 'recovering');
});

test('waiting for a long task does not exhaust recovery time or broaden which independent desktop is accepted', () => {
  const f = fixture(), after = f.upgrade([current]);
  f.tracker.observe(after, { mode: 'independent' }, old);
  for (let i = 0; i < 20; i++) { f.advance(60_000); f.tracker.waitForTasks(); }
  assert.match(f.tracker.observe(after, { mode: 'independent' }, old).message, /等待/);
  f.tracker.resume(); assert.equal(f.tracker.action(after, { mode: 'independent' }).kind, 'reconnect');
  const unrelated = { ...current, pid: 30, startedAt: new Date(Date.parse(current.startedAt) + 900_000).toISOString() };
  assert.equal(f.tracker.action(f.upgrade([unrelated]), { mode: 'independent' }), null);
});
