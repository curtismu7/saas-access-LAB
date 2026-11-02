// The leaks a review of the sibling labs named, each one with its own test here: U+1680 between keyword and value; "login: bob / x" and "password - x" (also as
// a path id and an object key); four rounds of percent-encoding; keys, values and path ids echoed in the request/hops bodies; /assets and /assets/ answering 200
// HTML; and the false positive key:key-refunds. What the shared masker 1.4.0 cannot do (a one-character secret after a keyword) is stated by a test that pins it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanFree, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { C, post, put, rawHttp, spec, withServer } from './helpers.js';
import { PROBE } from './secrets.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const PW = ['pass', 'word'].join('');
const enc = encodeURIComponent;
const four = (s) => enc(enc(enc(enc(s))));

test('U+1680 (OGHAM SPACE MARK) between a keyword and its value is a separator: masked as text, as a value and as a key', () => {
  for (const t of [`${PW} ${PROBE}`, `${PW}: ${PROBE}`, `my ${PW} is ${PROBE}`, `${PW}  = ${PROBE}`, `pw ${PROBE}`, `token ${PROBE}`]) {
    assert.ok(!maskText(t).includes(PROBE), JSON.stringify(t));
    assert.ok(!cleanFree(t).includes(PROBE), JSON.stringify(t));
    assert.ok(!JSON.stringify(maskDeep({ x: t })).includes(PROBE) && !JSON.stringify(maskDeep({ [t]: 1 })).includes(PROBE), JSON.stringify(t));
  }
});

test('U+1680 over HTTP: a reason, a decision comment, an object key and a path id never come back', async () => {
  await withServer(async (url) => {
    const t = `${PW} ${PROBE}`; const ws = { 'x-workspace': 'w-named-ogham' };
    const a = await (await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: t }) }), ws)).text();
    const b = await (await post(url, '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', comment: t } }), ws)).text();
    const k = await (await post(url, '/api/requests', live({ request: { ...spec(), [t]: 1 } }), ws)).text();
    const p = await (await post(url, `/api/requests/${enc(t)}/cancel`, live({ by: C.castEngineer }), ws)).text();
    for (const x of [a, b, k, p]) assert.ok(!x.includes(PROBE) && !x.includes('1680'), x.slice(0, 200));
    assert.match(a, /"reason":"\[masked\]"/);
  });
});

test('"login: bob / x" and "password - x": the masker cannot judge a one-character secret (stated limit), so a path id and an object key are never echoed as typed', async () => {
  const LOGIN = 'login: bob / x'; const DASH = `${PW} - x`;
  // the limit, pinned: as free text these two come back as typed (shared-masker 1.4.0 masks a value of 3+ characters)
  assert.equal(cleanFree(LOGIN), LOGIN); assert.equal(cleanFree(DASH), DASH);
  assert.equal(cleanFree(`${PW} - ${PROBE}`), '[masked]', 'a longer value after the same shape is masked');
  assert.equal(cleanFree('login: bob / '.concat(PROBE)), '[masked]');
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'w-named-lgn' };
    for (const t of [LOGIN, DASH]) {
      // a path id: not a shape the lab uses, so it is the mark, the answer is the fixed 404, and the typed text is nowhere
      for (const [m, p, b] of [['POST', `/api/requests/${enc(t)}/cancel`, live({ by: C.castEngineer })], ['POST', `/api/requests/${enc(t)}/decision`, live({ decision: { approver: C.castSecLead, decision: 'approve', via: 'console' } })], ['PUT', `/api/policies/${enc(t)}`, live({ policy: {} })], ['POST', `/api/policies/${enc(t)}/retire`, live({})]]) {
        const r = await (m === 'PUT' ? put : post)(url, p, b, ws); const text = await r.text(); const j = JSON.parse(text);
        assert.ok([400, 404].includes(r.status), p.slice(0, 30)); assert.equal(j.ok, false); assert.ok(/^[a-z_]+$/.test(j.error), 'a fixed code');
        assert.ok(!text.includes('bob') && !text.includes(' - x') && !text.includes('/ x'), `${p.slice(0, 30)}: ${text.slice(0, 160)}`);
        assert.ok([j.hops[0].request.body.requestId, j.hops[0].request.body.id].includes('[masked]'), 'the echo shows the mark');
      }
      // an object key, at the top of a body, in a request, in a decision, in a policy, in the integrations
      for (const [m, p, b, pick] of [['POST', '/api/requests', live({ request: { ...spec(), [t]: 1 } }), (j) => j.hops[0].request.body], ['POST', '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'approve', [t]: 1 } }), (j) => j.hops[0].request.body],
        ['PUT', '/api/policies/pol-code-write', live({ policy: { [t]: 1 } }), (j) => j.hops[0].request.body.policy], ['PUT', '/api/integrations', live({ integrations: { [t]: { Hitl: true } } }), (j) => j.hops[0].request.body],
        ['POST', '/api/clock', live({ clock: { [t]: 1 } }), (j) => j.hops[0].request.body], ['POST', '/api/platforms/out-of-band', live({ change: { [t]: 1 } }), (j) => j.hops[0].request.body]]) {
        const r = await (m === 'PUT' ? put : post)(url, p, b, ws); const text = await r.text();
        assert.ok(!text.includes('bob') && !text.includes(' - x') && !text.includes('/ x'), `${p}: ${text.slice(0, 160)}`);
        assert.ok(Object.keys(pick(JSON.parse(text))).includes('[masked]'), `${p}: the key is the mark in the echo`);
      }
      // a workspace id with this shape is refused
      const r = await rawHttp(`${url}/api/state?mode=live`, { headers: { host: new URL(url).host, 'x-workspace': t } }); assert.equal(r.status, 400); assert.deepEqual(JSON.parse(r.text), { error: 'bad_workspace' });
    }
  });
});

test('four rounds of percent-encoding are undone: as text, as a value and key of the response, and as a reason over HTTP', async () => {
  for (const plain of [`${PW}=${PROBE}`, `${PW}: ${PROBE}`, `my ${PW} is ${PROBE}`, `Authorization: Bearer ${PROBE}abc`]) {
    for (const t of [enc(plain), enc(enc(plain)), enc(enc(enc(plain))), four(plain)]) {
      assert.ok(!cleanFree(t).includes(PROBE), t.slice(0, 40));
      assert.ok(!JSON.stringify(maskDeep({ [t]: t })).includes(PROBE), t.slice(0, 40));
    }
  }
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'w-named-4x' };
    const t = four(`${PW}=${PROBE}`);
    const a = await (await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: t }) }), ws)).text();
    const k = await (await post(url, '/api/requests', live({ request: { ...spec(), [t]: 1 } }), ws)).text();
    const p = await (await post(url, `/api/requests/${t}/cancel`, live({ by: C.castEngineer }), ws)).text();
    const s = await (await rawHttp(`${url}/api/state?mode=live`, { headers: { host: new URL(url).host, 'x-workspace': 'w-named-4x' } })).text;
    for (const x of [a, k, p, s]) assert.ok(!x.includes(PROBE), x.slice(0, 200));
  });
});

test('keys, values and path ids typed into a call are shown in hops[0].request.body as the mark, and nowhere else in the answer', async () => {
  await withServer(async (url) => {
    const v = ['hunter2', 'xyz'].join(''); const typed = `${PW}=${v}`;
    const ws = { 'x-workspace': 'w-named-echo' };
    const r = await post(url, `/api/requests/${enc(typed)}/decision`, live({ decision: { approver: typed, decision: typed, via: typed, comment: typed, [typed]: typed } }), ws);
    const text = await r.text(); const j = JSON.parse(text);
    assert.ok(!text.includes(v));
    const body = j.hops[0].request.body;
    assert.deepEqual(Object.keys(body).sort(), ['[masked]', 'approver', 'comment', 'decision', 'requestId', 'via'], 'known fields stay readable, the typed key is the mark');
    for (const f of ['approver', 'comment', 'decision', 'via', '[masked]', 'requestId']) assert.equal(body[f], '[masked]', f);
    // a clean call shows its real shape
    const ok = await (await post(url, '/api/requests/req-0001/cancel', live({ by: C.castEngineer }), ws)).json();
    assert.deepEqual(ok.hops[0].request.body, { requestId: 'req-0001', by: C.castEngineer });
  });
});

test('/assets and /assets/ are a JSON 404, not a 200 HTML page', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-named-')); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title><p id="shell">s</p>');
  try {
    await withServer(async (url) => {
      for (const p of ['/assets', '/assets/']) { const r = await rawHttp(`${url}${p}`, { headers: { host: new URL(url).host } }); assert.equal(r.status, 404, p); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }); assert.match(r.headers['content-type'], /^application\/json/); }
    }, { webDist: dist });
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('false positive: key:key-refunds stays readable in a request reason and in the echo of requestedBy (it is a plain name, not a secret)', async () => {
  const name = 'key:key-refunds';
  assert.equal(cleanFree(name), name); assert.equal(maskText(`rotate ${name} before Friday`), `rotate ${name} before Friday`);
  assert.deepEqual(maskDeep({ requestedBy: name }), { requestedBy: name });
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'w-named-key' };
    const bad = await (await post(url, '/api/requests', live({ request: spec({ requestedBy: name }) }), ws)).json();
    assert.equal(bad.ok, false); assert.equal(bad.hops[0].request.body.requestedBy, name, 'the echo of a requestedBy the roster does not know');
    const ok = await (await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: `rotate ${name} before Friday` }) }), ws)).json();
    assert.equal(ok.ok, true); assert.equal(ok.state.requests[0].reason, `rotate ${name} before Friday`);
  });
});
