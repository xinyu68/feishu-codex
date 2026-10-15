import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionAlerts, type ConnectionIncident } from '../src/connection-alerts.js';

function fixture() {
  let record: ConnectionIncident | undefined, now = 1000, enabled = true, available = true;
  const sent: boolean[] = [];
  const alerts = new ConnectionAlerts({ get: () => record, save: value => { record = value; }, now: () => now,
    enabled: () => enabled, graceMs: 100,
    send: async recovered => { if (!available) return 'unavailable'; sent.push(recovered); return 'sent'; } });
  return { alerts, sent, get record() { return record; }, advance(ms: number) { now += ms; },
    enabled(value: boolean) { enabled = value; }, available(value: boolean) { available = value; } };
}
test('short disconnects stay quiet and one multi-thread outage produces one warning and recovery', async () => {
  const f = fixture(); try {
    f.alerts.observe('short', true); f.advance(10); f.alerts.observe('short', false); await f.alerts.flush(); assert.deepEqual(f.sent, []);
    f.alerts.observe('a', true); f.alerts.observe('b', true); f.advance(101);
    await Promise.all([f.alerts.flush(), f.alerts.flush()]); assert.deepEqual(f.sent, [false]);
    f.alerts.observe('a', false); await f.alerts.flush(); assert.deepEqual(f.sent, [false]);
    f.alerts.observe('b', false); await f.alerts.flush(); assert.deepEqual(f.sent, [false, true]); assert.equal(f.record, undefined);
  } finally { f.alerts.close(); }
});
test('an offline outage is retained and reported once after recovery', async () => {
  const f = fixture(); try {
    f.available(false); f.alerts.observe('a', true); f.advance(1000); await f.alerts.flush();
    f.alerts.observe('a', false); await f.alerts.flush(); assert.ok(f.record); assert.deepEqual(f.sent, []);
    f.available(true); await f.alerts.flush(); await f.alerts.flush(); assert.deepEqual(f.sent, [true]);
  } finally { f.alerts.close(); }
});
test('disabled alerts discard queued reminders', async () => {
  const f = fixture(); try { f.alerts.observe('a', true); f.advance(1000); f.enabled(false); await f.alerts.flush(); assert.equal(f.record, undefined); assert.deepEqual(f.sent, []); }
  finally { f.alerts.close(); }
});

test('recovery during an in-flight warning still produces a separate recovery notice', async () => {
  let record: ConnectionIncident | undefined, now = 1000, release!: () => void;
  const sent: boolean[] = [];
  const alerts = new ConnectionAlerts({ get: () => record, save: value => { record = value; }, enabled: () => true,
    now: () => now, graceMs: 100,
    send: async recovered => { sent.push(recovered); if (!recovered) await new Promise<void>(resolve => { release = resolve; }); return 'sent'; } });
  try {
    alerts.observe('codex', true); now += 200;
    const warning = alerts.flush();
    alerts.observe('codex', false); release(); await warning;
    await alerts.flush(); assert.deepEqual(sent, [false, true]); assert.equal(record, undefined);
  } finally { alerts.close(); }
});
