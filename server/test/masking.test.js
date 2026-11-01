import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFree, findCredentials, looksLikeCredential, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { scrub } from '../src/service.js';
import { C, newEngine, spec, dec } from './helpers.js';
import { SECRETS, PLAIN, SWEEP, READABLE, PROBE, PROBE2 } from './secrets.js';

test('every credential shape is found and masked', () => {
  for (const [name, v] of Object.entries(SECRETS)) {
    assert.ok(findCredentials(`please use ${v} for this`).length > 0, name);
    const out = maskText(`please use ${v} for this`);
    assert.ok(!out.includes(v), `${name} is masked`);
    assert.match(out, /\[masked\]/);
  }
});

test('the sweep classes A to D: every payload is masked (22 payloads)', () => {
  assert.equal(SWEEP.length, 22);
  for (const [name, text, needle] of SWEEP) {
    for (const wrapped of [text, `before ${text} after`, `x\n${text}\ny`]) {
      const out = cleanFree(wrapped);
      assert.ok(!out.includes(needle), `${name}: "${needle}" survived in ${JSON.stringify(out)}`);
      assert.match(out, /\[masked\]/, name);
    }
    assert.ok(looksLikeCredential(text), name);
  }
});

test('A: control characters are DELETED before matching (not turned into spaces), tab/newline/CR are separators', () => {
  assert.equal(cleanFree('a\u0000b‮c  d'), 'abc d', 'NUL and a bidi mark are deleted, never a space');
  assert.equal(cleanFree('a\u0001b\u007fc\u0085d\u009fe'), 'abcde');
  assert.equal(cleanFree('line one\nline two\tend'), 'line one line two end', 'newline and tab stay word separators');
  // every C0 and C1 code point except tab, LF and CR, inside every position of a keyword
  const pw = ['pass', 'word'].join('');
  for (let c = 0; c < 0xa0; c += 1) {
    if (c === 9 || c === 10 || c === 13 || (c > 0x1f && c < 0x7f)) continue;
    for (let at = 1; at < pw.length; at += 1) {
      const text = `${pw.slice(0, at)}${String.fromCharCode(c)}${pw.slice(at)}=${PROBE}`;
      assert.ok(!cleanFree(text).includes(PROBE), `U+${c.toString(16)} at ${at}`);
    }
  }
  // tab, newline and CR inside a keyword are caught by the second look (separators deleted); a readable multi-line text keeps its lines' words apart
  for (const sep of ['\t', '\n', '\r', ' ', ' ']) assert.ok(!cleanFree(`${pw.slice(0, 4)}${sep}${pw.slice(4)}=${PROBE}`).includes(PROBE), JSON.stringify(sep));
  // ... and zero-width / bidi / soft hyphen
  for (const z of ['​', '‍', '⁠', '﻿', '­', '‮']) assert.ok(!cleanFree(`${[...pw].join(z)}=${PROBE}`).includes(PROBE), JSON.stringify(z));
});

test('B: keyword + plain space masks a value of 6+ characters with a digit; ordinary sentences stay readable (the documented tradeoff)', () => {
  for (const text of READABLE) assert.equal(cleanFree(text), text, text);
  for (const text of PLAIN) assert.equal(cleanFree(text), text, text);
  const pw = ['pass', 'word'].join('');
  // boundary of the value rule, as literals: 6 characters with a digit is masked, 5 is not, 6 without a digit is not
  assert.equal(cleanFree(`${pw} abcde1`), `${pw} [masked]`);
  assert.equal(cleanFree(`${pw} abcd1`), `${pw} abcd1`);
  assert.equal(cleanFree(`${pw} abcdef`), `${pw} abcdef`);
  // the price: a plain-word secret is missed, and a harmless word with a digit after a keyword is masked
  assert.equal(cleanFree(`${pw} correcthorse`), `${pw} correcthorse`);
  assert.equal(cleanFree('token abc123'), 'token [masked]');
  // "password is x" masks any value; "the secret is x" needs a digit
  assert.equal(cleanFree(`my ${pw} is correcthorse`), `my ${pw} is [masked]`);
  assert.equal(cleanFree('the secret is correcthorse'), 'the secret is correcthorse');
  assert.equal(cleanFree('the secret is correct1horse'), 'the secret is [masked]');
});

test('C: URL userinfo with or without a scheme, with or without a password', () => {
  for (const t of [`bob:${PROBE}@host.example`, `//bob:${PROBE}@host.example`, `https://bob:${PROBE}@host.example`, `ssh://deploy:${PROBE}@git.example:22/x`, `postgres://u:${PROBE}@db.example/app`]) {
    const out = cleanFree(`see ${t} now`);
    assert.ok(!out.includes(PROBE), t); assert.match(out, /\[masked\]/);
  }
  assert.ok(!cleanFree(`https://${PROBE}@host.example/x`).includes(PROBE), 'a token alone in the userinfo');
  assert.equal(cleanFree('mail me at mailto:lee.park@x.example'), 'mail me at mailto:lee.park@x.example', 'a mailto address is left alone');
  assert.equal(cleanFree('write to lee.park@payments.example please'), 'write to lee.park@payments.example please');
});

test('D: JSON-quoted and other assignment shapes', () => {
  const pw = ['pass', 'word'].join('');
  for (const t of [`{"${pw}":"${PROBE}"}`, `{'${pw}': '${PROBE}'}`, `"${pw}" : "${PROBE}"`, `${pw}=>${PROBE}`, `my_${pw}: ${PROBE}`, `${pw}: ${PROBE}`, `x-token: ${PROBE}`]) assert.ok(!cleanFree(t).includes(PROBE), t);
  assert.ok(!cleanFree(`{"a":1,"${pw}":"${PROBE} with spaces","b":2}`).includes('with spaces'), 'a quoted value is masked whole');
  assert.match(cleanFree(`{"a":1,"${pw}":"${PROBE}","b":2}`), /"b":2/, 'the rest of the JSON is kept');
});

test('percent-encoding up to three rounds is undone before matching', () => {
  const enc = (s) => encodeURIComponent(s);
  const pw = ['pass', 'word'].join('');
  const plain = `${pw}=${PROBE}`;
  assert.ok(!cleanFree(enc(plain)).includes(PROBE), '1 round');
  assert.ok(!cleanFree(enc(enc(plain))).includes(PROBE), '2 rounds');
  assert.ok(!cleanFree(enc(enc(enc(plain)))).includes(PROBE), '3 rounds');
  assert.ok(!cleanFree(`${pw}+${PROBE}`.replace('+', '%20')).includes(PROBE), 'an encoded space');
  assert.ok(!cleanFree(`${pw}+is+${PROBE}`).includes(PROBE), 'plus signs as spaces');
  assert.ok(!cleanFree(`${pw.slice(0, 3)}%01${pw.slice(3)}=${PROBE}`).includes(PROBE), 'an encoded control inside a keyword');
  assert.equal(cleanFree('100%25 sure about 50% of it'), '100%25 sure about 50% of it', 'text with no credential in it is shown as typed, not decoded');
});

test('cleanFree: masks, never cuts, never throws', () => {
  const v = SECRETS.github;
  assert.ok(!cleanFree(`token ${v}`).includes(v));
  assert.equal(cleanFree(undefined), ''); assert.equal(cleanFree(null), ''); assert.equal(cleanFree({}), '[object Object]');
  assert.equal(cleanFree('I need read access to review the change for the release'), 'I need read access to review the change for the release');
  const long = 'word '.repeat(2000).trim(); // 9,999 characters
  assert.equal(cleanFree(long).length, 9999, 'nothing is cut: a caller that wants a limit refuses whole');
  assert.equal(cleanFree('x'.repeat(1_000_001)), '[masked: text too long to check]', 'over 1,000,000 characters is refused whole by the masker');
  assert.equal(cleanFree('y'.repeat(1_000_000)), '[masked]', '1,000,000 characters is still checked');
});

test('a secret after 19,990 filler characters is masked (the value is found wherever it sits)', () => {
  const filler = 'a '.repeat(9995);
  for (const [name, text, needle] of SWEEP) assert.ok(!cleanFree(`${filler}${text}`).includes(needle), name);
  assert.ok(!cleanFree(`${'a'.repeat(19990)} ${SECRETS.github}`).includes('ghp_'));
});

test('detectors are linear: 400,000 characters of the nastiest shapes are scanned in a few seconds', () => {
  const t0 = Date.now();
  const pw = ['pass', 'word'].join('');
  const bad = ['a'.repeat(400000), `${pw}${' '.repeat(400000)}`, `-----BEGIN PRIVATE KEY-----${'x'.repeat(400000)}`, `sk-${'-'.repeat(400000)}`, `Bearer ${'a'.repeat(400000)}`, `eyJ${'a.'.repeat(200000)}`, 'a='.repeat(200000),
    `${pw} `.repeat(60000), `${pw}:${'"'.repeat(400000)}`, `${pw}="${'x'.repeat(400000)}`, `//${'a:'.repeat(200000)}`, `${'\u0001'.repeat(400000)}`, `${pw}${'\u0001'.repeat(200000)}=x`, `${'%25'.repeat(130000)}`, `${'+'.repeat(400000)}`, `${'a@'.repeat(200000)}`];
  for (const t of bad) maskText(t);
  assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
});

test('maskDeep masks nested strings AND object keys, keeps ids and hashes, does not mutate, keeps colliding keys apart, and survives a deep structure', () => {
  const v = SECRETS.github;
  const input = { a: [{ b: `x ${v}` }], [`k ${v}`]: 1, hash: 'f'.repeat(64), traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, id: 'req-0001', n: 5, nil: null };
  const out = maskDeep(input);
  assert.ok(!JSON.stringify(out).includes(v));
  assert.equal(out.hash, input.hash); assert.equal(out.traceparent, input.traceparent); assert.equal(out.id, 'req-0001'); assert.equal(out.n, 5);
  assert.ok(input.a[0].b.includes(v), 'the input is not mutated');
  assert.ok(Object.keys(input).some((k) => k.includes(v)), 'the input keys are not mutated either');
  // two keys that mask to the same text are both kept
  const two = maskDeep({ [`k ${SECRETS.github}`]: 1, [`k ${SECRETS.gitlab}`]: 2 });
  assert.deepEqual(Object.values(two).sort(), [1, 2]); assert.equal(Object.keys(two).length, 2);
  // __proto__ is an ordinary own property of the copy
  const proto = maskDeep(JSON.parse('{"__proto__":{"x":1},"y":2}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype); assert.deepEqual(Object.keys(proto), ['__proto__', 'y']);
  let deep = { v: `y ${v}` }; for (let i = 0; i < 50000; i++) deep = { d: deep };
  assert.doesNotThrow(() => maskDeep(deep));
  // the response layer also catches the sweep classes, by itself (no input cleaning)
  for (const [name, text, needle] of SWEEP) assert.ok(!JSON.stringify(maskDeep({ x: text, [text]: [text] })).includes(needle), name);
  assert.deepEqual(maskDeep({ a: PLAIN, b: READABLE }), { a: PLAIN, b: READABLE });
});

test('a credential typed as the reason or comment is masked everywhere the engine keeps or shows it', () => {
  const e = newEngine(); e.trace = { traceId: 'a'.repeat(32), span: () => 'b'.repeat(16) };
  for (const [name, v] of [...Object.entries(SECRETS), ...SWEEP.map(([n, t, needle]) => [n, t, needle])].map(([n, t]) => [n, t])) {
    const r = e.createRequest(spec({ policyId: 'pol-incident', reason: `because ${v} works`, requestedBy: C.castEngineer }));
    e.decide(dec(r.id, C.castSecLead, { comment: `ok ${v}` }));
    const all = JSON.stringify([e.snapshot(), e.hops, e.s]);
    const needle = name === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : name === 'bearer' ? 'tokenvalue' : name === 'assignment' ? 'hunter2hunter2' : v.includes(PROBE2) ? PROBE2 : v.includes(PROBE) ? PROBE : v;
    assert.ok(!all.includes(needle), `${name} is nowhere in the state, the hops or the receipts`);
  }
  assert.match(e.snapshot().requests.at(-1).reason, /\[masked\]/);
});

// The needles: the part of each value that must not survive. For a keyword form it is the value after the keyword.
const CORE = { plainIs: 'hunter2xyz', pwColon: 'Hunter2Secret', passEq: 'Tr0ub4dor', passphrase: 'correct horse battery', userinfo: 'hunter2@', tokenWord: ['abcdef123456', '7890zz'].join(''), google: ['a0AfH6SMBxQ1w2e3', 'r4t5y6u7i8o9p0'].join(''), accountKey: ['abcdEFGH', '1234'].join(''), sessionId: '00D5g000008dkQz', key31: ['Zq9Xk2Lm8Rt4Vb7N', 'c1Hd5Fj3Gs6Pw0Y'].join(''), shortGh: 'shortone1234' };

test('plain-language and short credentials are masked: "my password is ...", pw:, pass=, a passphrase, URL userinfo, "token <word>", Google tokens, AccountKey, session ids, a 31 character key, a short prefixed token', () => {
  for (const [name, needle] of Object.entries(CORE)) {
    const out = cleanFree(`before ${SECRETS[name]} after`);
    assert.ok(!out.includes(needle), `${name}: "${needle}" survived in "${out}"`);
    assert.match(out, /\[masked\]/, name);
    assert.ok(out.startsWith('before'), name);
  }
});

test('ordinary prose, ids, dates, resource and policy names are NOT masked (no false positives)', () => {
  for (const text of PLAIN) assert.equal(cleanFree(text), text);
  for (const id of ['req-0001', 'g-0001', 'gh-repo-core', 'snow-role-writer', 'maya.chen', 'ledger-reconciler', 'pol-code-write', 'dbx-schema-pii', '2026-11-02T10:00:00.000Z']) assert.equal(cleanFree(id), id, id);
});

test('a PGP private key block and fullwidth look-alikes of a token are masked too', () => {
  const pgp = ['-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF9abc123xyz\n-----END PGP ', 'PRIVATE KEY BLOCK-----'].join('');
  assert.ok(!cleanFree(`k ${pgp}`).includes('lQOYBF9abc123xyz'));
  assert.ok(!cleanFree(`k ${['-----BEGIN ', 'PRIVATE KEY-----\nabcdef12345'].join('')}`).includes('abcdef12345'), 'an unterminated key block is masked to the end');
  const full = SECRETS.github.replace(/[a-z_]/g, (c) => (c === '_' ? '＿' : String.fromCharCode(c.charCodeAt(0) + 0xfee0)));
  assert.match(cleanFree(`k ${full}`), /\[masked\]/);
  assert.ok(!cleanFree(`k ${full}`).includes('Zq9'));
});

test('what the masker still misses is stated, not hidden: bare words, look-alike letters, a keyword split by a space', () => {
  const pw = ['pass', 'word'].join('');
  assert.equal(cleanFree(PROBE), PROBE, 'a bare word with no keyword and no recognisable shape');
  assert.ok(cleanFree(`${pw.replace('a', 'а')}=${PROBE}`).includes(PROBE), 'a Cyrillic а inside the keyword is not folded');
  assert.ok(cleanFree(`${pw.replace('o', 'ο')}=${PROBE}`).includes(PROBE), 'a Greek ο inside the keyword is not folded');
  assert.ok(cleanFree(`pass word=${PROBE}`).includes(PROBE), 'a keyword split by an ordinary space');
});

test('workspace ids: the masker and the id rule agree that a credential-looking id is not an id', async () => {
  const { validWorkspaceId } = await import('../src/workspaces.js');
  for (const id of [`pw-${PROBE}`, `sk-${PROBE2}`, 'a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097', 'token-abc', ['ghp', '-abcdef12'].join(''), 'eyj-abc', 'x'.repeat(41), '', 'A', 'a_b', 'a b']) assert.equal(validWorkspaceId(id), false, id);
  for (const id of ['default', 'w-0123456789abcdef', 'ws-a', 'parity-warehouse-role', 'a', `${'x'.repeat(19)}-${'y'.repeat(20)}`]) assert.equal(validWorkspaceId(id), true, id);
});

test('reason and comment lengths: 300 and 200 characters are taken, one more is refused whole (never cut)', () => {
  const e = newEngine();
  const ok300 = e.createRequest(spec({ policyId: 'pol-incident', reason: `${'ab '.repeat(100)}` })); // 300 characters
  assert.equal(`${'ab '.repeat(100)}`.length, 300);
  assert.equal(ok300.reason, 'ab '.repeat(100).trim(), 'taken whole (only the trailing space trimmed)');
  assert.throws(() => e.createRequest(spec({ policyId: 'pol-incident', reason: `${'ab '.repeat(100)}x` })), (err) => err.code === 'reason_too_long' && err.status === 400 && !/ab/.test(err.message));
  assert.throws(() => e.createRequest(spec({ policyId: 'pol-incident', reason: 'r'.repeat(301) })), { code: 'reason_too_long' });
  assert.ok(e.createRequest(spec({ policyId: 'pol-incident', reason: 'r'.repeat(300) })).reason.length > 0, '300 characters of one letter are taken (and masked as a long run)');
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  const c200 = 'cd '.repeat(66) + 'cd'; assert.equal(c200.length, 200);
  e.decide(dec(r.id, C.castSecLead, { decision: 'deny', comment: c200 }));
  assert.equal(e.snapshot().requests.find((x) => x.id === r.id).approval.DenialReason, c200);
  const r2 = e.createRequest(spec({ policyId: 'pol-incident' }));
  assert.throws(() => e.decide(dec(r2.id, C.castSecLead, { decision: 'deny', comment: `${c200}x` })), (err) => err.code === 'comment_too_long' && !/cd/.test(err.message));
  assert.equal(e.snapshot().requests.find((x) => x.id === r2.id).status, 'pending', 'a refused comment changes nothing');
});

test('the hop echo (scrub) masks on its own, with the INPUT masker: every string and every key, nested, even shapes only the input masker knows (long runs)', () => {
  const long = SECRETS.key31; // 31 characters, letters and digits: only the input side's long-run detector knows it
  const out = scrub({ a: long, [long]: [long, { [SWEEP[0][1]]: SWEEP[9][1] }], n: 5, b: true, nil: null, u: undefined, f: () => 1 });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(long) && !text.includes(PROBE), text);
  assert.equal(out.n, 5); assert.equal(out.b, true); assert.equal(out.nil, null); assert.equal(out.u, undefined); assert.equal(out.f, undefined);
  assert.equal(Object.keys(out).length, 7, 'a, the masked key, n, b, nil, u and f: every key is kept');
  const two = scrub({ [`x ${SECRETS.github}`]: 1, [`x ${SECRETS.gitlab}`]: 2 }); assert.equal(Object.keys(two).length, 2);
  assert.equal(scrub('plain words only'), 'plain words only');
  let deep = 'leaf'; for (let i = 0; i < 20; i += 1) deep = { d: deep };
  assert.ok(JSON.stringify(scrub(deep)).includes('[nested too deep to show]'), 'nesting past 8 levels is marked, not dropped silently');
  assert.deepEqual(Object.keys(scrub(JSON.parse('{"__proto__":{"x":1}}'))), ['__proto__']);
});

test('header lines, PINs, bearer values and the decoded round are masked as stated', () => {
  assert.equal(cleanFree('cookie: a=b; c=d next'), 'cookie: [masked]', 'a header-style value runs to the end of its line');
  assert.equal(cleanFree('cookie: a=b\nnext line'), 'cookie: [masked]', 'over-masks on purpose: the separator second look (newline deleted) makes the rest of the text part of that line');
  assert.equal(cleanFree('Set-Cookie: sid=1; Path=/'), 'Set-Cookie: [masked]');
  assert.equal(cleanFree('my pin is 4821'), 'my pin is [masked]'); assert.equal(cleanFree('pin code: 123456'), 'pin code: [masked]');
  assert.equal(cleanFree('pin 4821'), 'pin 4821', 'a PIN needs ":", "=" or "is"'); assert.equal(cleanFree('the pin is loose'), 'the pin is loose');
  assert.equal(cleanFree(`Bearer ${'a'.repeat(20)}`), 'Bearer [masked]', 'a bearer value of 20 characters, no digit'); assert.equal(cleanFree(`Bearer ${'a'.repeat(19)}`), `Bearer ${'a'.repeat(19)}`);
  assert.equal(cleanFree('Bearer abcde1'), 'Bearer [masked]', '6 characters with a digit'); assert.equal(cleanFree('Bearer abcdef'), 'Bearer abcdef');
  assert.equal(cleanFree('see   a   b'), 'see a b', 'whitespace is collapsed');
  // two overlapping hits become one mask
  const pw = ['pass', 'word'].join(''); assert.equal(cleanFree(`${pw}=bob:hunter2xyz@host.example`), `${pw}=[masked]`);
  // the decoded round that holds the credential is the one shown; a later round that holds nothing does not replace it
  assert.equal(cleanFree(encodeURIComponent(`${pw}=hunter2xyz`)), `${pw}=[masked]`);
});
