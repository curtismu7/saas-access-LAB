import test from 'node:test';
import assert from 'node:assert/strict';
import { post, withServer } from './helpers.js';

const json = async (res) => res.json();
const W = (id) => ({ 'x-workspace': id });
const ENV_KEYS = ['CENTRAL_AGENT_A2A_URL', 'CENTRAL_AGENT_A2A_BEARER'];

function withGatewayEnv(fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CENTRAL_AGENT_A2A_URL = 'https://aigw.example.invalid/a2a';
  process.env.CENTRAL_AGENT_A2A_BEARER = 'sk-test';
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

// Mock ONLY the gateway host: the lab's own test client uses the same global fetch.
function mockGateway(handler) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, init) => {
    if (!String(u).includes('aigw.example.invalid')) return real(u, init);
    seen.push({ u: String(u), auth: init?.headers?.authorization });
    return handler();
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test('POST /api/privilege-check 503s clearly when Real mode is not configured', async () => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  for (const [k] of saved) delete process.env[k];
  try {
    await withServer(async (url) => {
      const res = await post(url, '/api/privilege-check', { text: 'hello' }, W('w-pc1'));
      assert.equal(res.status, 503);
      const body = await json(res);
      assert.equal(body.error, 'privilege_not_configured');
    });
  } finally {
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
  }
});

test('POST /api/privilege-check relays the gateway decision (allow) and never leaks the bearer', async () => {
  await withGatewayEnv(async () => {
    const mock = mockGateway(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { status: { state: 'completed' } } }), { status: 200 }));
    try {
      await withServer(async (url) => {
        const res = await post(url, '/api/privilege-check', { text: 'an ordinary request' }, W('w-pc2'));
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.mapped.decision, 'allow');
        assert.equal(body.mapped.reasonCode, 'ALLOW-AIGUARD-CLEAN');
        assert.equal(mock.seen.length, 1);
        assert.match(mock.seen[0].u, /aigw\.example\.invalid\/a2a\/jsonrpc/);
        assert.equal(mock.seen[0].auth, 'Bearer sk-test');
        assert.match(body.raw, /completed/);
      });
    } finally { mock.restore(); }
  });
});

test('POST /api/privilege-check maps a policy block to deny', async () => {
  await withGatewayEnv(async () => {
    const mock = mockGateway(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code: -32600, message: 'request blocked by security policy' } }), { status: 200 }));
    try {
      await withServer(async (url) => {
        const res = await post(url, '/api/privilege-check', { text: 'a credential-laden request' }, W('w-pc3'));
        const body = await json(res);
        assert.equal(body.mapped.decision, 'deny');
        assert.equal(body.mapped.reasonCode, 'DENY-AIGUARD-BLOCKED');
      });
    } finally { mock.restore(); }
  });
});

test('POST /api/privilege-check refuses missing and oversized text without calling the gateway', async () => {
  await withGatewayEnv(async () => {
    const mock = mockGateway(() => new Response('{}', { status: 200 }));
    try {
      await withServer(async (url) => {
        const missing = await post(url, '/api/privilege-check', {}, W('w-pc4'));
        assert.equal(missing.status, 400);
        const big = await post(url, '/api/privilege-check', { text: 'x'.repeat(4001) }, W('w-pc4'));
        assert.equal(big.status, 400);
        assert.equal(mock.seen.length, 0);
      });
    } finally { mock.restore(); }
  });
});
