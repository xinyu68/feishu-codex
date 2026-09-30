import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverHermesDashboard, normalizeHermesDashboardUrl } from '../src/hermes-discovery.js';

test('Hermes discovery accepts only loopback HTTP origins', () => {
  assert.equal(normalizeHermesDashboardUrl('http://127.0.0.1:62566/'), 'http://127.0.0.1:62566');
  assert.equal(normalizeHermesDashboardUrl('http://[::1]:62566'), 'http://[::1]:62566');
  for (const value of ['https://example.com', 'http://127.0.0.1.example.com', 'http://u:p@127.0.0.1:62566',
    'http://127.0.0.1:62566/x', 'http://127.0.0.1:62566/?token=secret']) {
    assert.throws(() => normalizeHermesDashboardUrl(value));
  }
});

test('Hermes discovery reads the current desktop token without starting a gateway', async () => {
  const requests: string[] = [];
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    assert.equal(init?.redirect, 'error');
    return String(input).endsWith('/api/status')
      ? Response.json({ version: '0.17.0', hermes_home: 'C:/hermes', auth_required: false })
      : new Response('<script>window.__HERMES_SESSION_TOKEN__="local-test-token";</script>');
  };
  const result = await discoverHermesDashboard({
    candidates: async () => [{ baseUrl: 'http://127.0.0.1:62566', pid: 123 }], fetch: mockFetch as typeof fetch,
  });
  assert.deepEqual(result, { baseUrl: 'http://127.0.0.1:62566', pid: 123, token: 'local-test-token', version: '0.17.0', hermesHome: 'C:/hermes' });
  assert.deepEqual(requests, ['http://127.0.0.1:62566/api/status', 'http://127.0.0.1:62566/']);
});

test('Hermes discovery skips exited candidates and refreshes rotated bootstrap tokens', async () => {
  let token = 'first';
  const mockFetch = async (input: string | URL | Request) => {
    if (String(input).includes(':1111')) throw new Error('closed');
    return String(input).endsWith('/api/status')
      ? Response.json({ version: '0.17.0', hermes_home: 'C:/hermes' })
      : new Response(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};</script>`);
  };
  const options = {
    candidates: async () => [{ baseUrl: 'http://127.0.0.1:1111' }, { baseUrl: 'http://127.0.0.1:2222' }],
    fetch: mockFetch as typeof fetch,
  };
  assert.equal((await discoverHermesDashboard(options)).token, 'first');
  token = 'second';
  assert.equal((await discoverHermesDashboard(options)).token, 'second');
});

test('Hermes discovery rejects missing credentials and authenticated remote dashboards', async () => {
  for (const status of [{ version: '0.17.0', hermes_home: 'C:/hermes', auth_required: true },
    { version: '0.17.0', hermes_home: 'C:/hermes' }, {}]) {
    const mockFetch = async (input: string | URL | Request) => String(input).endsWith('/api/status')
      ? Response.json(status) : new Response('<html>no token</html>');
    await assert.rejects(discoverHermesDashboard({ baseUrl: 'http://127.0.0.1:62566', fetch: mockFetch as typeof fetch }));
  }
});
