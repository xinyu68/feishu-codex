import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeRouter } from '../src/runtime-router.js';
import type { CodexRuntime, RuntimeConsultInput } from '../src/types.js';

test('consultation routing selects the requested engine without ordinary run or history calls', async () => {
  const calls: Array<{ engine: string; input: RuntimeConsultInput }> = [];
  const runtime = (engine: string) => ({
    async consult(input: RuntimeConsultInput) { calls.push({ engine, input }); return { threadId: `${engine}-temporary`, text: engine }; },
    async run() { assert.fail('ordinary run must not be used'); },
    async history() { assert.fail('normal history must not be read'); },
  }) as unknown as CodexRuntime;
  const router = new RuntimeRouter(runtime('codex'), runtime('hermes'));
  const input = { cwd: process.cwd(), prompt: 'summary only', signal: new AbortController().signal };
  assert.equal((await router.consult(input)).text, 'codex');
  assert.equal((await router.consult({ ...input, engine: 'hermes' })).text, 'hermes');
  assert.deepEqual(calls.map(call => call.engine), ['codex', 'hermes']);
  assert.equal(calls[0].input, input);
  await assert.rejects(new RuntimeRouter({} as CodexRuntime).consult(input), /不支持独立咨询/);
});
