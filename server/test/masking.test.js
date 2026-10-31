import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTORS, MAX_FREE, cleanFree, findCredentials, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { C, newEngine, spec, dec } from './helpers.js';

// Credential-shaped test values are assembled at run time, so no such string sits in the repository.
export const SECRETS = {
  github: ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  githubPat: ['github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJ'].join(''),
  gitlab: ['glpat', '-', 'AbCdEfGhIjKlMnOpQrSt'].join(''),
  slack: ['xox', 'b-', '123456789012-abcdefghijklmnopqrstuvwx'].join(''),
  aws: ['AKI', 'AIOSFODNN7EXAMPLE'].join(''),
  openai: ['sk', '-proj-', 'Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1'].join(''),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhYmNkZWYifQ', 'abcdefghij1234567890XYZ'].join('.'),
  pem: ['-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdefghijklmnop\n-----END ', 'PRIVATE KEY-----'].join(''),
  bearer: ['Bear', 'er ', 'abcdEFGH1234567890.tokenvalue'].join(''),
  assignment: ['pass', 'word=', 'hunter2hunter2'].join(''),
  blob: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  hex: 'deadbeef'.repeat(6),
};

test('every credential shape is found and masked', () => {
  for (const [name, v] of Object.entries(SECRETS)) {
    assert.ok(findCredentials(`please use ${v} for this`).length > 0, name);
    const out = maskText(`please use ${v} for this`);
    assert.ok(!out.includes(v), `${name} is masked`);
    assert.match(out, /\[masked:/);
  }
  assert.ok(DETECTORS.length >= 10);
});

test('cleanFree: masks, strips control and bidi characters, collapses space, caps, and never throws', () => {
  const v = SECRETS.github;
  assert.ok(!cleanFree(`token ${v}`).includes(v));
  assert.equal(cleanFree('a\u0000b‮c  d'), 'a b c d');
  assert.equal(cleanFree('x'.repeat(5000)).length <= MAX_FREE, true);
  assert.equal(cleanFree(undefined), ''); assert.equal(cleanFree(null), ''); assert.equal(cleanFree({}), '[object Object]');
  assert.equal(cleanFree('I need read access to review the change for the release'), 'I need read access to review the change for the release', 'ordinary text is left alone');
});

test('a secret split across the 400 character cap is still masked (masking happens before the cut)', () => {
  const v = SECRETS.github;
  const text = `${'a '.repeat(190)}${v}`;
  assert.ok(!cleanFree(text, 400).includes(v.slice(0, 20)) || cleanFree(text, 400).length <= 400);
  const out = cleanFree(`${'a '.repeat(195)}${v}`, 400);
  assert.ok(!out.includes(v));
  assert.ok(!out.includes(v.slice(0, 12)), 'not even a prefix of the token survives');
});

test('detectors are linear: a hostile input of 20000 characters is scanned quickly', () => {
  const t0 = Date.now();
  for (const bad of ['a'.repeat(20000), 'password' + ' '.repeat(20000), '-----BEGIN PRIVATE KEY-----' + 'x'.repeat(20000), 'sk-' + '-'.repeat(20000), 'Bearer ' + 'a'.repeat(20000), 'eyJ' + 'a.'.repeat(10000), ('a=').repeat(10000)]) maskText(bad);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test('maskDeep masks nested values, keeps ids, hashes and trace ids, does not mutate, and survives a deep structure', () => {
  const v = SECRETS.github;
  const input = { a: [{ b: `x ${v}` }], hash: 'f'.repeat(64), traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, id: 'req-0001', n: 5, nil: null };
  const out = maskDeep(input);
  assert.ok(!JSON.stringify(out).includes(v));
  assert.equal(out.hash, input.hash); assert.equal(out.traceparent, input.traceparent); assert.equal(out.id, 'req-0001'); assert.equal(out.n, 5);
  assert.ok(input.a[0].b.includes(v), 'the input is not mutated');
  let deep = { v: `y ${v}` }; for (let i = 0; i < 50000; i++) deep = { d: deep };
  assert.doesNotThrow(() => maskDeep(deep));
});

test('a credential typed as the reason of a request is masked everywhere the engine keeps or shows it', () => {
  const e = newEngine(); e.trace = { traceId: 'a'.repeat(32), span: () => 'b'.repeat(16) };
  for (const [name, v] of Object.entries(SECRETS)) {
    const r = e.createRequest(spec({ policyId: 'pol-incident', reason: `because ${v} works`, requestedBy: C.castEngineer }));
    e.decide(dec(r.id, C.castSecLead, { comment: `ok ${v}` }));
    const all = JSON.stringify([e.snapshot(), e.hops, e.s]);
    const needle = name === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : name === 'bearer' ? 'tokenvalue' : name === 'assignment' ? 'hunter2hunter2' : v;
    assert.ok(!all.includes(needle), `${name} is nowhere in the state, the hops or the receipts`);
  }
  assert.match(e.snapshot().requests.at(-1).reason, /\[masked:/);
});
