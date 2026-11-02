// The edge of the app (shared-masker docs/EXPRESS-RECIPE.md): the 415 charset gate, the one route table, the workspace gate that runs before a slot exists,
// and the page fallback that is only for page addresses. Literal numbers throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, ROUTES } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { get, post, put, rawHttp, spec, withServer } from './helpers.js';
import { PROBE, PROBE2 } from './secrets.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const raw = (url, p, o = {}) => rawHttp(`${url}${p}`, { ...o, headers: { host: new URL(url).host, origin: url, ...(o.headers || {}) } });

// stdout and stderr are collected while fn runs: nothing the visitor typed may be logged
async function captured(fn) {
  const out = []; const so = process.stdout.write.bind(process.stdout); const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...a) => { out.push(String(c)); return so(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return se(c, ...a); };
  try { await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
  return out.join('');
}

test('415: a charset other than utf-8 is a fixed 415 that echoes and logs nothing typed', async () => {
  const logged = await captured(() => withServer(async (url) => {
    for (const cs of ['utf-16', 'iso-8859-1', 'latin1', PROBE, `"${PROBE}"`, 'utf-16le', 'ascii', 'utf-7']) {
      for (const [method, p] of [['POST', '/api/requests'], ['PUT', '/api/integrations'], ['POST', '/api/reset'], ['GET', '/api/state?mode=mock'], ['GET', '/api/health']]) {
        const r = await raw(url, p, { method, headers: { 'content-type': `application/json; charset=${cs}` }, body: method === 'GET' ? undefined : '{}' });
        assert.equal(r.status, 415, `${method} ${p} ${cs}`); assert.deepEqual(JSON.parse(r.text), { error: 'unsupported_charset' }, `${cs}`);
        assert.ok(!r.text.includes(PROBE) && !JSON.stringify(r.headers).includes(PROBE), cs);
      }
    }
    // utf-8 in any case, quoted or not, and no charset at all, are taken
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'application/json; charset=UTF-8', 'application/json; charset="utf-8"']) {
      const r = await raw(url, '/api/reset', { method: 'POST', headers: { 'content-type': ct }, body: '{}' });
      assert.equal(r.status, 200, ct);
    }
    // body-parser itself refuses "utf8" (without the hyphen) with a 415; the error handler turns it into the same fixed body
    const u8 = await raw(url, '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json;charset=utf8' }, body: '{}' });
    assert.equal(u8.status, 415); assert.deepEqual(JSON.parse(u8.text), { error: 'unsupported_charset' });
    // a charset on a path that does not exist is still the 415 (the gate is first), and a second charset parameter is refused
    assert.equal((await raw(url, '/nowhere', { headers: { 'content-type': 'text/plain; charset=latin1' } })).status, 415);
    assert.equal((await raw(url, '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8; charset=latin1' }, body: '{}' })).status, 415);
  }));
  assert.ok(!logged.includes(PROBE), 'nothing typed was written to stdout or stderr');
});

test('the route table and the registered routes are the same set (19 routes, no extra, none missing)', () => {
  const app = createApp({ health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const apiLayer = app._router.stack.find((l) => l.name === 'router' && l.regexp.test('/api/state'));
  assert.ok(apiLayer, 'the /api router is mounted');
  const registered = new Set();
  for (const l of apiLayer.handle.stack) if (l.route) for (const m of Object.keys(l.route.methods)) registered.add(`${m.toUpperCase()} /api${l.route.path}`);
  registered.add('GET /api/health'); // mounted as a router (health.js), not a route of the api router
  const table = new Set();
  for (const [p, methods] of Object.entries(ROUTES)) for (const m of methods) table.add(`${m} ${p}`);
  assert.equal(table.size, 19);
  assert.deepEqual([...registered].sort(), [...table].sort());
});

test('workspace gate: a credential-looking id is a 400 bad_workspace BEFORE any slot exists, on every route that uses a workspace', async () => {
  await withServer(async (url, { workspaces }) => {
    // 39 letters in two runs: refused by isCredentialId (an opaque run) and by nothing else in the id rule
    const ONLY_SHARED = `${'a'.repeat(19)}-${'b'.repeat(20)}`;
    for (const id of [ONLY_SHARED, 'qz9xk2lm8rt4vb7nc1hd5fj3gs6pw0yz', `pw-${PROBE}`, 'a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097']) {
      for (const [m, p, b] of [['GET', '/api/state?mode=live'], ['POST', '/api/requests', live({ request: spec() })], ['POST', '/api/requests/req-0001/decision', live({ decision: {} })], ['POST', '/api/requests/req-0001/cancel', live({})],
        ['POST', '/api/clock', live({ clock: { minutes: 1 } })], ['POST', '/api/reaper/run', live({})], ['POST', '/api/drift/reconcile', live({})], ['POST', '/api/drift/remediate', live({})], ['POST', '/api/platforms/out-of-band', live({ change: {} })],
        ['POST', '/api/platforms/sync', live({ change: {} })], ['PUT', '/api/policies/pol-code-write', live({ policy: {} })], ['POST', '/api/policies/pol-code-write/retire', live({})], ['PUT', '/api/integrations', live({ integrations: {} })],
        ['POST', '/api/preview', live({ request: spec() })], ['POST', '/api/reset', {}]]) {
        const r = await (m === 'GET' ? get(url, p, { 'x-workspace': id }) : m === 'PUT' ? put(url, p, b, { 'x-workspace': id }) : post(url, p, b, { 'x-workspace': id }));
        const t = await r.text();
        assert.equal(r.status, 400, `${id.slice(0, 12)} ${m} ${p}`); assert.deepEqual(JSON.parse(t), { error: 'bad_workspace' }, p); assert.ok(!t.includes(id) && !t.includes(PROBE), p);
      }
    }
    assert.equal(workspaces.size(), 0, 'no slot was taken by 60 refused calls');
    // routes that never use a workspace take no slot, with any id; a 404 and a 405 take none
    for (const p of ['/api/health', '/api/info', '/api/story', '/api/diagram', '/api/nope', '/nowhere']) await get(url, p, { 'x-workspace': 'w-aaaa1111bbbb2222' });
    await post(url, '/api/state', {}, { 'x-workspace': 'w-aaaa1111bbbb2222' });
    assert.equal(workspaces.size(), 0, 'info routes, a 404 and a 405 take no slot');
    // a read of a fresh workspace takes none either (peek); the first write takes exactly one
    await get(url, '/api/state?mode=live', { 'x-workspace': 'w-aaaa1111bbbb2222' });
    assert.equal(workspaces.size(), 0);
    assert.equal((await post(url, '/api/requests', live({ request: spec() }), { 'x-workspace': 'w-aaaa1111bbbb2222' })).status, 200);
    assert.equal(workspaces.size(), 1);
  });
});

test('page fallback: only a page address gets the shell; /assets and /assets/ are JSON 404 (they were 200 HTML)', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-edge-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>shell</title><p id="shell">x</p>');
  fs.mkdirSync(path.join(dist, 'assets')); fs.writeFileSync(path.join(dist, 'assets', 'a.js'), '1');
  try {
    await withServer(async (url) => {
      for (const p of ['/assets', '/assets/', '/Assets', '/assets//', '/static', '/static/', '/%', '/%zz', '/a//b', '/.hidden', '/a/.b', '/x.js', '/x/y.map', `/${PROBE2}.js`]) {
        const r = await raw(url, p); assert.equal(r.status, 404, p); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, p); assert.ok(!r.text.includes('shell'), p);
      }
      for (const p of ['/', '/tab', '/a/b', '/a/b/', '/assetsx', '/some%20page']) { const r = await raw(url, p); assert.equal(r.status, 200, p); assert.ok(r.text.includes('id="shell"'), p); }
      assert.equal((await raw(url, '/assets/a.js')).text, '1', 'a real asset is still served');
      assert.equal((await raw(url, '/assets/missing.js')).status, 404);
    }, { webDist: dist });
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('the response mask is the last layer: a route that forgot to clean its input still answers masked values AND keys, errors included', async () => {
  const express = (await import('express')).default;
  const { startHttpServer } = await import('../src/app.js');
  const secret = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  // a health router that echoes what it was given, as a careless route would
  const router = express.Router();
  router.get('/', (req, res) => res.json({ echoed: req.query.q, [`k ${secret}`]: [secret, { nested: `x ${secret}` }], hash: 'f'.repeat(64) }));
  router.get('/boom', (_req, _res, next) => next(new Error(`failed for ${secret}`)));
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health: { router, stop() {} } }) });
  try {
    const r = await (await fetch(`${url}api/health?q=${encodeURIComponent(`use ${secret} now`)}`)).text();
    assert.ok(!r.includes(secret) && !r.includes('a1B2c3D4'), r);
    assert.match(r, /"echoed":"use \[masked\] now"/); assert.ok(r.includes('f'.repeat(64)), 'an opaque name (hash) is left as written');
    const e = await fetch(`${url}api/health/boom`); const t = await e.text();
    assert.equal(e.status, 500); assert.deepEqual(JSON.parse(t), { error: 'internal_error' }); assert.ok(!t.includes(secret) && !t.includes('failed for'));
  } finally { await new Promise((res) => server.close(res)); }
});
