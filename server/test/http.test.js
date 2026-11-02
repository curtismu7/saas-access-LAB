// Class E (static files, 404, 405), class F (workspace ids) and the bounds (literal numbers: N accepted, N+1 refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { C, get, post, put, rawHttp, spec, withServer } from './helpers.js';
import { PROBE, PROBE2 } from './secrets.js';
import { validWorkspaceId } from '../src/workspaces.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const NOT_FOUND = { error: 'not_found' };
const SHELL = '<!doctype html><title>shell</title><p id="shell">app shell</p>';

async function withDist(fn) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-http-'));
  fs.writeFileSync(path.join(dist, 'index.html'), SHELL);
  fs.mkdirSync(path.join(dist, 'assets')); fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  try { await withServer(fn, { webDist: dist }); } finally { fs.rmSync(dist, { recursive: true, force: true }); }
}
const raw = (url, p, o = {}) => rawHttp(`${url}${p}`, { ...o, headers: { host: new URL(url).host, origin: url, ...(o.headers || {}) } });

test('E: a missing static file is a JSON 404, never 200 HTML; the shell answers only an extension-less, non-dotfile GET', async () => {
  await withDist(async (url) => {
    for (const p of ['/assets/missing.js', '/favicon.ico', '/robots.txt', '/foo.map', '/foo.svg', '/sitemap.xml', '/.env', '/.git/config', '/a/b/c.css', '/foo.html', '/assets/.hidden', '/x/.well-known/y', '/index.html.bak', '/app.js', '/assets', '/assets/', '/static', '/static/x', '/api-docs.json']) {
      const r = await raw(url, p);
      assert.equal(r.status, 404, p); assert.match(r.headers['content-type'], /^application\/json/, p); assert.deepEqual(JSON.parse(r.text), NOT_FOUND, p);
      assert.ok(!r.text.includes(p.slice(1)) && !/<html|<pre>|Cannot GET/i.test(r.text), p);
    }
    for (const p of ['/', '/foo', '/foo/bar', '/foo/', '/some-page', '/a%20b', '/assetsx', '/apix']) {
      const r = await raw(url, p);
      assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /^text\/html/, p); assert.ok(r.text.includes('id="shell"'), p);
    }
    assert.equal((await raw(url, '/assets/app.js')).text, 'console.log(1)', 'a file that exists is served');
    assert.ok((await raw(url, '/index.html')).text.includes('id="shell"'), 'index.html itself is served');
    const head = await raw(url, '/foo', { method: 'HEAD' }); assert.equal(head.status, 200);
    const dir = await raw(url, '/assets'); assert.equal(dir.status, 404, '/assets is not a page address (it was a 200 HTML shell before shared-masker 1.4.0 isPageAddress)'); assert.ok(!dir.headers.location && !/Redirecting/.test(dir.text), 'a directory is not redirected (that page would echo the path)');
    const bad = await raw(url, '/%E0%A4%A'); assert.equal(bad.status, 404, 'a path that does not decode is not a page'); assert.deepEqual(JSON.parse(bad.text), NOT_FOUND);
  });
});

test('E: with no web build, every path outside /api is a JSON 404', async () => {
  await withServer(async (url) => {
    for (const p of ['/', '/foo', '/assets/x.js', '/favicon.ico']) { const r = await raw(url, p); assert.equal(r.status, 404, p); assert.deepEqual(JSON.parse(r.text), NOT_FOUND, p); }
    const r = await raw(url, '/', { method: 'POST' }); assert.equal(r.status, 404, 'no shell, no route'); assert.deepEqual(JSON.parse(r.text), NOT_FOUND);
  }, { webDist: '/nonexistent/dist' });
});

test('E: a write outside /api is a JSON 404 (405 with Allow on "/"), never Express\'s "Cannot POST /<path>"', async () => {
  await withDist(async (url) => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await raw(url, '/anything/at/all', { method: m }); assert.equal(r.status, 404, m); assert.deepEqual(JSON.parse(r.text), NOT_FOUND, m); assert.equal(r.headers.allow, undefined);
      const tok = await raw(url, `/${PROBE2}`, { method: m }); assert.deepEqual(JSON.parse(tok.text), NOT_FOUND, m); assert.ok(!tok.text.includes(PROBE2));
      const root = await raw(url, '/', { method: m }); assert.equal(root.status, 405, m); assert.equal(root.headers.allow, 'GET, HEAD'); assert.deepEqual(JSON.parse(root.text), { error: 'method_not_allowed' });
    }
  });
});

// [path, the one method it takes]. Every other method is a 405 with that Allow; HEAD follows GET.
const ROUTES = [['/api/health', 'GET'], ['/api/story', 'GET'], ['/api/diagram', 'GET'], ['/api/info', 'GET'], ['/api/state', 'GET'], ['/api/preview', 'POST'], ['/api/requests', 'POST'],
  ['/api/requests/req-0001/decision', 'POST'], ['/api/requests/req-0001/cancel', 'POST'], ['/api/clock', 'POST'], ['/api/reaper/run', 'POST'], ['/api/drift/reconcile', 'POST'],
  ['/api/drift/remediate', 'POST'], ['/api/platforms/out-of-band', 'POST'], ['/api/platforms/sync', 'POST'], ['/api/policies/pol-code-write', 'PUT'],
  ['/api/policies/pol-code-write/retire', 'POST'], ['/api/integrations', 'PUT'], ['/api/reset', 'POST']];

test('E: a wrong method on any of the 19 known routes is a 405 JSON with Allow (never a 404 that hides the route)', async () => {
  assert.equal(ROUTES.length, 19);
  await withServer(async (url) => {
    for (const [p, ok] of ROUTES) {
      for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        if (m === ok) continue;
        const r = await raw(url, p, { method: m, ...(m === 'POST' || m === 'PUT' || m === 'PATCH' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
        assert.equal(r.status, 405, `${m} ${p}`); assert.equal(r.headers.allow, ok === 'GET' ? 'GET, HEAD' : ok, `${m} ${p}`); assert.deepEqual(JSON.parse(r.text), { error: 'method_not_allowed' }, `${m} ${p}`);
      }
      if (ok === 'GET') assert.notEqual((await raw(url, p, { method: 'HEAD' })).status, 405, `HEAD ${p}`);
    }
    // trailing slash and upper case are the same route
    assert.equal((await raw(url, '/api/Story/', { method: 'POST', body: '{}' })).status, 405);
    // unknown /api paths stay a 404
    for (const p of ['/api/nope', '/api/requests/req-0001', '/api/requests/req-0001/nope', '/api/policies', '/api/policies/pol-code-write/nope', '/api/state/x']) { const r = await raw(url, p, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); assert.ok([404, 405].includes(r.status), p); if (r.status === 404) assert.deepEqual(JSON.parse(r.text), NOT_FOUND, p); }
    assert.equal((await raw(url, '/api/requests', { method: 'GET' })).status, 405);
  });
});

test('E: the catch-all error handler answers fixed JSON for a broken body, a broken path and an oversized body', async () => {
  await withServer(async (url) => {
    const h = { 'content-type': 'application/json' };
    const bad = await raw(url, '/api/requests', { method: 'POST', headers: h, body: `{"mode":"${PROBE}` }); assert.equal(bad.status, 400); assert.deepEqual(JSON.parse(bad.text), { error: 'bad_request' }); assert.ok(!bad.text.includes(PROBE));
    const dec = await raw(url, '/api/requests/%E0%A4%A/cancel', { method: 'POST', headers: h, body: '{}' }); assert.equal(dec.status, 400); assert.deepEqual(JSON.parse(dec.text), { error: 'bad_request' });
    const big = await raw(url, '/api/requests', { method: 'POST', headers: h, body: JSON.stringify({ a: 'x'.repeat(40000) }) }); assert.equal(big.status, 413); assert.deepEqual(JSON.parse(big.text), { error: 'payload_too_large' });
    const arr = await raw(url, '/api/requests', { method: 'POST', headers: h, body: '[1]' }); assert.equal(arr.status, 400);
  });
});

// ---- F: workspace ids
const HEX40 = 'a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097';
const REFUSED = ['sk-abc', 'abcdefabcdefabcdefabcdef', 'eyjhbgcioijiuzi', `pw-${PROBE}`, `sk-${PROBE2.toLowerCase()}`, HEX40, HEX40.slice(0, 24), HEX40.slice(0, 32), `w-${HEX40}`.slice(0, 40), ['glpat', '-abcdefghijklmnop1234'].join(''), `pass-${PROBE}`, `token-${PROBE}`, `secret-x`, `password`, `a-ghp-x`, 'eyjhbgcioijiuzi1nij9', 'xoxb-1', 'x'.repeat(41), 'A', 'a_b', ''];
// 'akia1234567890123456' is lower case: an AWS access key id is upper case, and every id here is lower case, so the shared masker (case-sensitive) does not flag it; the old masker did.
// The 40-character row is ordinary words: a run of 40 letters ('a' x 19, '-', 'b' x 20) is read by isCredentialId as an opaque run and refused (new behaviour).
const ACCEPTED = ['abcdefabcdefabcdefabcde', 'eyhbgcioijiuzi', 'default', 'w-0123456789abcdef', 'ws-a', 'parity-warehouse-role', 'a', 'review-queue-for-the-finance-team-run-12', 'akia1234567890123456', 'w-fedcba9876543210', 'tab-1', 'passing-review', 'tokens-x'];

test('F: the server\'s id rule on a table (the page keeps a copy; scripts/workspace-rule.test.mjs compares the two)', () => {
  for (const id of REFUSED) assert.equal(validWorkspaceId(id), false, id);
  for (const id of ACCEPTED) assert.equal(validWorkspaceId(id), true, id);
});

test('F: a credential-looking workspace id is a 400 bad_workspace on every endpoint, never echoed; ordinary ids are echoed', async () => {
  await withServer(async (url) => {
    for (const id of REFUSED.filter((x) => x && /^[\x20-\x7e]+$/.test(x))) {
      for (const [m, p, b] of [['GET', '/api/state?mode=live'], ['POST', '/api/requests', live({ request: spec() })], ['POST', '/api/reset', {}], ['POST', '/api/preview', live({ request: spec() })], ['PUT', '/api/integrations', live({ integrations: {} })]]) {
        const r = await (m === 'GET' ? get(url, p, { 'x-workspace': id }) : m === 'PUT' ? put(url, p, b, { 'x-workspace': id }) : post(url, p, b, { 'x-workspace': id }));
        const t = await r.text();
        assert.equal(r.status, 400, `${id} ${m} ${p}`); assert.deepEqual(JSON.parse(t), { error: 'bad_workspace' }, id); assert.ok(!t.includes(id) && !t.includes(PROBE) && !t.includes(PROBE2.toLowerCase()), id);
      }
    }
    for (const id of ACCEPTED) {
      const r = await post(url, '/api/requests', live({ request: spec() }), { 'x-workspace': id }); assert.equal(r.status, 200, id);
      const b = await r.json(); assert.equal(b.workspace, id); assert.equal(b.hops[0].request.headers['x-workspace'], id);
    }
    assert.equal((await get(url, '/api/state?mode=live')).status, 200, 'no header = the default workspace');
  });
});

// ---- bounds: literal numbers, N accepted and N+1 refused whole
const rem = (url, findingId, ws) => post(url, '/api/drift/remediate', live({ findingId }), ws);
const snap = async (url, ws) => JSON.stringify((await (await get(url, '/api/state?mode=live', ws)).json()).state);

test('bounds: a text of 400 characters is taken, 401 is refused whole with a 413 that echoes nothing', async () => {
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'bounds-text' };
    const ok = await rem(url, 'z'.repeat(400), ws); assert.equal(ok.status, 404, '400 characters reach the engine (which does not know that finding)');
    const before = await snap(url, ws);
    const over = await rem(url, 'z'.repeat(401), ws); assert.equal(over.status, 413);
    const j = await over.json(); assert.equal(j.error, 'payload_too_large'); assert.ok(!JSON.stringify(j).includes('zzz')); assert.equal(Object.keys(j).sort().join(), 'detail,error');
    assert.equal(await snap(url, ws), before, 'a refused write changes nothing');
    // the same through a path id
    assert.equal((await post(url, `/api/requests/${'r'.repeat(400)}/cancel`, live({ by: C.castEngineer }), ws)).status, 404);
    assert.equal((await post(url, `/api/requests/${'r'.repeat(401)}/cancel`, live({ by: C.castEngineer }), ws)).status, 413);
    assert.equal((await post(url, `/api/policies/${'r'.repeat(401)}/retire`, live({}), ws)).status, 413);
    // and the preview
    assert.equal((await post(url, '/api/preview', live({ request: spec({ reason: 'q'.repeat(400) }) }), ws)).status, 200);
    const pv = await post(url, '/api/preview', live({ request: spec({ reason: 'q'.repeat(401) }) }), ws); assert.equal(pv.status, 413); assert.equal(Object.keys(await pv.json()).sort().join(), 'detail,error', 'the preview refusal echoes nothing either');
  });
});

test('bounds: a key of 80 characters is taken, 81 is refused; a list of 20, 21; an object of 40 keys, 41; nesting 6 deep, 7', async () => {
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'bounds-shape' };
    const put1 = (policy) => put(url, '/api/policies/pol-code-write', live({ policy }), ws);
    assert.equal((await put1({ ['k'.repeat(80)]: 1 })).status, 400, 'key of 80: an ordinary refusal of an unknown field'); assert.equal((await put1({ ['k'.repeat(81)]: 1 })).status, 413);
    const chain = (n) => Array.from({ length: n }, () => ({ role: 'manager', required: 1 }));
    const base = { maxLevel: 'read', maxDurationMin: 60, requireDistinctApprovers: true, requestTtlMin: 60, channel: 'slack', autoApprove: { enabled: false, maxLevel: 'read', maxDurationMin: 0 } };
    const l20 = await put1({ ...base, chain: chain(20) }); assert.equal(l20.status, 400); assert.equal((await l20.json()).error, 'bad_policy', '20 items reach the policy check, which wants 1 to 3');
    assert.equal((await put1({ ...base, chain: chain(21) })).status, 413);
    const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`i${i}`, 1]));
    assert.equal((await put(url, '/api/integrations', live({ integrations: keys(38) }), ws)).status, 400, '38 + mode + vertical + integrations... the object itself has 40 keys');
    assert.equal((await put(url, '/api/integrations', live({ integrations: keys(40) }), ws)).status, 400, 'an object of 40 keys reaches the engine, which refuses unknown integrations');
    assert.equal((await put(url, '/api/integrations', live({ integrations: keys(41) }), ws)).status, 413);
    const nest = (n) => { let o = {}; for (let i = 1; i < n; i += 1) o = { a: o }; return o; }; // n levels of objects
    const depth = (n) => post(url, '/api/clock', { mode: 'live', vertical: 'finance', clock: nest(n - 1) }, ws); // the body itself is level 1, clock level 2
    assert.notEqual((await depth(6)).status, 413, 'nesting 6 deep is taken'); assert.equal((await depth(7)).status, 413, 'nesting 7 deep is refused');
    // top level: 40 keys is the cap there too
    const top = (n) => post(url, '/api/reaper/run', { mode: 'live', vertical: 'finance', ...Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => [`t${i}`, 1])) }, ws);
    assert.equal((await top(40)).status, 400, '40 keys: unknown fields are refused by name-free text'); assert.equal((await top(41)).status, 413);
  });
});

test('reason and comment over HTTP: 300 and 200 characters are taken, one more is refused whole (400), nothing is cut', async () => {
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'bounds-field' };
    const reason = 'ab '.repeat(100); assert.equal(reason.length, 300);
    const ok = await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason }) }), ws); assert.equal(ok.status, 200);
    assert.equal((await ok.json()).state.requests[0].reason, reason.trim(), 'stored whole');
    for (const n of [301, 400]) { const r = await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: 'r'.repeat(n) }) }), ws); const j = await r.json(); assert.equal(r.status, 400, String(n)); assert.equal(j.error, 'reason_too_long'); assert.ok(!j.detail.includes('rrr')); assert.equal(j.state.requests.length, 1, 'nothing was created'); }
    assert.equal((await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: 'r'.repeat(401) }) }), ws)).status, 413);
    const comment = 'cd '.repeat(66) + 'cd'; assert.equal(comment.length, 200);
    const d = await post(url, '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', comment: `${comment}x` } }), ws); const dj = await d.json();
    assert.equal(d.status, 400); assert.equal(dj.error, 'comment_too_long'); assert.equal(dj.state.requests[0].status, 'pending');
    const d2 = await post(url, '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', comment } }), ws); const d2j = await d2.json();
    assert.equal(d2.status, 200); assert.equal(d2j.state.requests[0].approval.DenialReason, comment, 'stored whole');
  });
});
