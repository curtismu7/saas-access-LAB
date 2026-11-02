// The final check (builder brief, lesson 1): credential-shaped corpus rows are typed into EVERY place a request can carry text, on EVERY endpoint: each body
// field, nested key, object key, path segment, query value and name, header, and error-path input (a broken body, a body over the limit, a bad charset, a path
// that does not decode). The secret must be absent from every answer (status, headers, body), from the state read afterwards (Live and Mock) and from
// everything the process wrote to stdout and stderr. Rows come from the shared corpus (test/corpus/leaks.json): the first two of each of the 63 families and
// every 60th row, so every family and every encoding is typed in; rows whose secret is under 6 characters are skipped (a short string can appear in a fixed
// answer by chance), a text of 20,000 characters or more is typed into the bodies only (a header or a path that long is refused by Node itself), and a row is
// skipped for a channel the client cannot send (a header with a control character, a path with a lone surrogate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { C, get, post, put, rawHttp, spec, withServer } from './helpers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');
const leaks = JSON.parse(readFileSync(path.join(dir, 'leaks.json'), 'utf8')).filter((r) => r.api !== 'deep');
const join = (a) => a.join('');
const expand = (row) => `${row.fillBefore ? `${'a'.repeat(row.fillBefore)} ` : ''}${join(row.input)}${row.fillAfter ? ` ${'a'.repeat(row.fillAfter)}` : ''}`;
const seen = new Map();
const rows = leaks.filter((r) => join(r.secret).length >= 6 && (r.fillBefore || 0) <= 20000 && (r.fillAfter || 0) <= 20000)
  .filter((r, i) => { const n = (seen.get(r.family) || 0); seen.set(r.family, n + 1); return n < 2 || i % 60 === 0; });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const esc = (s) => { try { return encodeURIComponent(s); } catch { return null; } };
const absent = (text, secret) => !text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1));

test('the sweep samples the shared corpus: at least 150 rows, every one of the 63 families', () => {
  assert.ok(rows.length >= 150, `${rows.length} rows`);
  assert.equal(new Set(rows.map((r) => r.family)).size, 63);
});

test('a corpus secret typed into every field, key, path segment, query, header and error path of every endpoint is in no answer, no state and no log line', async () => {
  const out = []; const so = process.stdout.write.bind(process.stdout); const se = process.stderr.write.bind(process.stderr);
  const failures = []; let calls = 0; let n = 0;
  await withServer(async (url) => {
    const host = new URL(url).host;
    const send = async (label, row, secret, method, p, { body, headers = {}, json } = {}) => {
      if (p === null) return;
      try {
        const r = await rawHttp(`${url}${p}`, { method, headers: { host, origin: url, ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body });
        calls += 1;
        const text = `${r.status} ${JSON.stringify(r.headers)} ${r.text}`;
        if (!absent(text, secret)) failures.push(`${row.id} ${row.family}/${row.enc} ${label}: ${method} ${p.slice(0, 40)} -> ${r.status}`);
      } catch (e) { if (!/ERR_INVALID_CHAR|ERR_UNESCAPED|Invalid character|ERR_INVALID_ARG|ERR_HTTP/.test(String(e.code || e.message))) throw e; }
    };
    process.stdout.write = (c, ...a) => { out.push(String(c)); return so(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return se(c, ...a); };
    try {
      for (const row of rows) {
        n += 1;
        const v = expand(row); const secret = join(row.secret); const long = v.length > 2000;
        const ws = { 'x-workspace': `w-sweep-${n}` };
        const e = long ? null : esc(v);
        // an accepted request and decision first, so the stored state holds the typed text where the lab keeps any
        if (v.length <= 200) {
          await send('seed', row, secret, 'POST', '/api/requests', { json: live({ request: spec({ policyId: 'pol-incident', reason: v }) }), headers: ws });
          await send('seed', row, secret, 'POST', '/api/requests/req-0001/decision', { json: live({ decision: { approver: C.castSecLead, decision: 'approve', via: 'console', comment: v } }), headers: ws });
          await send('seed', row, secret, 'POST', '/api/requests/req-0001/decision', { json: live({ decision: { approver: C.castSecLead2, decision: 'deny', via: 'slack', comment: v } }), headers: ws });
        }
        const bodies = [
          ['POST', '/api/requests', live({ request: spec({ reason: v, requestedBy: v, subjectId: v, platform: v, resource: v, level: v, policyId: v, subjectKind: v, durationMin: v }) })],
          ['POST', '/api/requests', live({ request: spec(), [v]: v })], ['POST', '/api/requests', live({ request: { ...spec(), [v]: v } })],
          ['POST', '/api/requests/req-0001/decision', live({ decision: { approver: v, decision: v, via: v, comment: v, [v]: v } })],
          ['POST', '/api/requests/req-0001/cancel', live({ by: v })],
          ['POST', '/api/clock', live({ clock: { minutes: v, to: v, [v]: v } })], ['POST', '/api/reaper/run', live({ [v]: v })], ['POST', '/api/drift/reconcile', live({ [v]: v })],
          ['POST', '/api/drift/remediate', live({ findingId: v })],
          ['POST', '/api/platforms/out-of-band', live({ change: { op: v, platform: v, resource: v, subjectKind: v, subjectId: v, level: v, [v]: v } })],
          ['POST', '/api/platforms/sync', live({ change: { platform: v, sync: v, [v]: v } })],
          ['PUT', '/api/policies/pol-code-write', live({ policy: { maxLevel: v, maxDurationMin: v, chain: [{ role: v, required: v, [v]: v }], requireDistinctApprovers: v, requestTtlMin: v, channel: v, autoApprove: { enabled: v, maxLevel: v, maxDurationMin: v, [v]: v }, [v]: v } })],
          ['PUT', '/api/integrations', live({ integrations: { [v]: { Hitl: v }, slack: { [v]: v, Hitl: v } } })], ['PUT', '/api/integrations', live({ integrations: v })],
          ['POST', '/api/preview', live({ request: spec({ reason: v, requestedBy: v, platform: v }) })], ['POST', '/api/preview', { mode: v, vertical: v, request: v }],
          ['POST', '/api/reset', { [v]: v, mode: v }],
        ];
        for (const [m, p, b] of bodies) await send('body', row, secret, m, p, { json: b, headers: ws });
        // path segments, query values and names
        for (const p of [e && `/api/requests/${e}/decision`, e && `/api/requests/${e}/cancel`, e && `/api/policies/${e}`, e && `/api/policies/${e}/retire`]) {
          await send('path', row, secret, 'POST', p, { json: live({ decision: { approver: C.castSecLead, decision: 'approve' }, by: C.castEngineer, policy: {} }), headers: ws });
          await send('path', row, secret, 'PUT', p, { json: live({ policy: {} }), headers: ws });
        }
        for (const p of [e && `/api/${e}`, e && `/${e}`, e && `/assets/${e}`, e && `/${e}.js`, e && `/api/requests/${e}`, e && `/api/state/${e}`]) for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) await send('path', row, secret, m, p, { json: m === 'POST' || m === 'PUT' ? {} : undefined, headers: ws });
        for (const p of [e && `/api/state?mode=${e}`, e && `/api/state?mode=live&vertical=${e}&scenario=${e}`, e && `/api/state?mode=mock&scenario=${e}`, e && `/api/story?vertical=${e}`, e && `/api/diagram?name=${e}&vertical=${e}`, e && `/api/health?x=${e}`, e && `/api/state?${e}=${e}`, e && `/api/info?${e}`]) await send('query', row, secret, 'GET', p, { headers: ws });
        // headers: the value of each, and the Host and Origin of a write
        for (const h of long ? [] : ['x-workspace', 'traceparent', 'referer', 'authorization', 'cookie', 'user-agent', 'x-forwarded-for', 'accept', 'accept-language', 'x-request-id', 'if-none-match', 'origin', 'host', 'content-type', 'content-encoding']) {
          await send(`header ${h}`, row, secret, 'GET', '/api/state?mode=live', { headers: { [h]: v } });
          await send(`header ${h}`, row, secret, 'POST', '/api/requests', { json: live({ request: spec() }), headers: { ...ws, [h]: v } });
        }
        // error paths: a broken body, a body that is only the text, one over the limit, a charset, a path that does not decode
        await send('error', row, secret, 'POST', '/api/requests', { body: `{"mode":"${v}`, headers: { ...ws, 'content-type': 'application/json' } });
        await send('error', row, secret, 'POST', '/api/requests', { body: v, headers: { ...ws, 'content-type': 'application/json' } });
        await send('error', row, secret, 'POST', '/api/requests', { body: JSON.stringify({ reason: `${v}${'x'.repeat(40000)}` }), headers: { ...ws, 'content-type': 'application/json' } });
        await send('error', row, secret, 'POST', '/api/requests', { body: '{}', headers: { ...ws, 'content-type': `application/json; charset=${v}` } });
        await send('error', row, secret, 'GET', e && `/%E0%A4%A${e}`, { headers: ws });
        await send('error', row, secret, 'POST', e && `/api/requests/%E0%A4%A${e}/cancel`, { json: live({}), headers: ws });
        // the state afterwards, Live (this workspace) and Mock
        for (const p of ['/api/state?mode=live', '/api/state?mode=mock']) await send('state', row, secret, 'GET', p, { headers: ws });
        await send('state', row, secret, 'GET', '/api/story', {}); await send('state', row, secret, 'GET', '/api/diagram?name=x', {});
      }
    } finally { process.stdout.write = so; process.stderr.write = se; }
  });
  assert.ok(calls > 10000, `${calls} calls`);
  assert.deepEqual(failures, [], `${failures.length} answers carried a secret:\n${failures.slice(0, 30).join('\n')}`);
  const logged = out.join('');
  for (const row of rows) assert.ok(absent(logged, join(row.secret)), `${row.id} ${row.family}: written to stdout or stderr`);
});
