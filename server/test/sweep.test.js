// The masking sweep (classes A to D): every payload is typed into every free-text field, key name, path segment, query, header and error-path input of every
// endpoint of a REAL server, and must be absent from every answer, from the state afterwards, and from stdout and stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, put, spec, withServer, rawHttp } from './helpers.js';
import { SWEEP, PROBE, PROBE2 } from './secrets.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const enc = encodeURIComponent;
const bad = (text) => text.includes(PROBE) || text.includes(PROBE2);
const hdrs = (r) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
// A header value cannot carry a control character: those payloads go through every other place, the printable ones also through the headers.
const printable = (v) => /^[\x20-\x7e]+$/.test(v);

// Every place the payload can go. Each entry: [method, path, body|undefined, extra headers]. The same payload is also used as a KEY in the bodies.
function places(v) {
  const q = enc(v);
  const R = (o = {}) => spec({ policyId: 'pol-incident', ...o });
  const pol = { maxLevel: v, maxDurationMin: v, chain: [{ role: v, required: v, [v]: v }], requireDistinctApprovers: v, requestTtlMin: v, channel: v, autoApprove: { enabled: v, maxLevel: v, maxDurationMin: v, [v]: v }, [v]: v };
  const out = [];
  for (const f of ['requestedBy', 'subjectKind', 'subjectId', 'platform', 'resource', 'level', 'durationMin', 'policyId', 'reason']) out.push(['POST', '/api/requests', live({ request: R({ [f]: v }) })]);
  out.push(['POST', '/api/requests', live({ request: R({ reason: v, requestedBy: v, subjectId: v, platform: v, resource: v, level: v, policyId: v, subjectKind: v, durationMin: v }) })]);
  out.push(['POST', '/api/requests', live({ request: { ...R(), [v]: v } })], ['POST', '/api/requests', live({ request: R(), [v]: v })], ['POST', '/api/requests', live({ request: { [v]: { [v]: [v, { [v]: v }] } } })]);
  out.push(['POST', '/api/requests', live({ request: R({ reason: v }) })]); // an ACCEPTED request: the reason is stored (masked)
  for (const f of ['approver', 'decision', 'via', 'comment', 'requestId']) out.push(['POST', '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'approve', via: 'console', [f]: v } })]);
  out.push(['POST', `/api/requests/${q}/decision`, live({ decision: { approver: v, decision: v, via: v, comment: v, [v]: v } })], ['POST', `/api/requests/${q}/decision`, live({ decision: { approver: C.castSecLead, decision: 'deny', comment: v } })]);
  out.push(['POST', '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', via: 'console', comment: v } })]); // an ACCEPTED denial
  out.push(['POST', `/api/requests/${q}/cancel`, live({ by: v })], ['POST', `/api/requests/${q}/cancel`, live({ by: C.castEngineer })], ['POST', '/api/requests/req-0001/cancel', live({ by: v, [v]: v })]);
  out.push(['POST', '/api/clock', live({ clock: { minutes: v, to: v } })], ['POST', '/api/clock', live({ clock: { [v]: v } })], ['POST', '/api/clock', live({ clock: v })]);
  out.push(['POST', '/api/reaper/run', live({ [v]: v })], ['POST', '/api/drift/reconcile', live({ [v]: v })], ['POST', '/api/drift/remediate', live({ findingId: v })], ['POST', '/api/drift/remediate', live({ findingId: C.castEngineer, [v]: v })]);
  for (const f of ['op', 'platform', 'resource', 'subjectKind', 'subjectId', 'level']) out.push(['POST', '/api/platforms/out-of-band', live({ change: { op: 'grant', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer, level: 'read', [f]: v } })]);
  out.push(['POST', '/api/platforms/out-of-band', live({ change: { [v]: v } })], ['POST', '/api/platforms/sync', live({ change: { platform: v, sync: v, [v]: v } })], ['POST', '/api/platforms/sync', live({ change: v })]);
  out.push(['PUT', `/api/policies/${q}`, live({ policy: pol })], ['PUT', '/api/policies/pol-code-write', live({ policy: pol })], ['PUT', '/api/policies/pol-code-write', live({ policy: { [v]: 1 } })], ['PUT', '/api/policies/pol-code-write', live({ policy: v })]);
  out.push(['POST', `/api/policies/${q}/retire`, live({})], ['POST', '/api/policies/pol-code-write/retire', live({ [v]: v })]);
  out.push(['PUT', '/api/integrations', live({ integrations: v })], ['PUT', '/api/integrations', live({ integrations: { [v]: { Hitl: v }, slack: { [v]: v, Hitl: v } } })], ['PUT', '/api/integrations', live({ integrations: [v] })]);
  out.push(['POST', '/api/preview', live({ request: R({ reason: v, requestedBy: v, platform: v, [v]: v }) })], ['POST', '/api/preview', { mode: v, vertical: v, request: v, [v]: v }], ['POST', '/api/reset', { [v]: v }]);
  out.push(['POST', '/api/requests', v], ['POST', '/api/requests', [v]], ['POST', '/api/requests', live({ request: [v] })]);
  for (const g of [`/api/state?mode=${q}`, `/api/state?mode=live&vertical=${q}&scenario=${q}`, `/api/state?mode=mock&scenario=${q}`, `/api/story?vertical=${q}`, `/api/diagram?name=${q}&vertical=${q}`, `/api/info?x=${q}`, `/api/health?x=${q}`,
    `/api/${q}`, `/api/state/${q}`, `/api/requests/${q}`, `/api/policies/${q}`, `/api/health/${q}`, `/${q}`, `/${q}/x/${q}`, `/assets/${q}.js`, `/${q}.map`, `/.${q}`]) out.push(['GET', g]);
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) for (const p of [`/${q}`, `/api/${q}`, `/api/requests/${q}`, `/api/state?mode=${q}`, `/api/health?x=${q}`, `/api/requests/${q}/decision`]) out.push([m, p, m === 'DELETE' || m === 'OPTIONS' ? undefined : {}]);
  if (printable(v)) {
    for (const h of ['x-workspace', 'traceparent', 'origin', 'referer', 'x-forwarded-for', 'authorization', 'cookie', 'content-type', 'accept', 'user-agent', 'x-request-id']) {
      out.push(['GET', '/api/state?mode=live', undefined, { [h]: v }], ['POST', '/api/requests', live({ request: R() }), { [h]: v }], ['GET', `/${q}`, undefined, { [h]: v }]);
    }
  }
  return out;
}

// The label never contains the path (it carries the payload): the place's number.
async function call(url, [method, path, body, headers = {}], label) {
  const h = { origin: url, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
  try {
    const r = await fetch(`${url}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return `${method} ${label} -> ${r.status}\n${hdrs(r)}\n${await r.text()}`;
  } catch (e) { return `${method} ${label} -> client error ${e.code || e.name}`; } // a header the client itself refuses
}

test('the sweep: 22 payloads typed into every place of every endpoint come back in no answer, no later state, and not on stdout or stderr', async () => {
  assert.equal(SWEEP.length, 22);
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  let calls = 0;
  await withServer(async (url) => {
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      for (const [name, v, needle] of SWEEP) {
        // a pending request to act on, in a fresh workspace per payload (ids that do not look like credentials)
        const ws = { 'x-workspace': `sweep-${SWEEP.findIndex((x) => x[0] === name)}` };
        await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident' }) }), ws);
        const texts = [];
        let n = 0; for (const pl of places(v)) { calls += 1; n += 1; texts.push(await call(url, [pl[0], pl[1], pl[2], { ...ws, ...(pl[3] || {}) }], `place ${n}`)); }
        const hit = texts.filter((t) => t.includes(needle));
        assert.deepEqual(hit.map((t) => `${t.split('\n')[0]} ... ${JSON.stringify(t.slice(Math.max(0, t.indexOf(needle) - 120), t.indexOf(needle) + 40))}`), [], `${name}: "${needle}" came back`);
        // the state afterwards (requests, hops, audit, outbox, receipts) and a different workspace
        for (const w of [ws, {}]) { const st = await (await get(url, '/api/state?mode=live', w)).text(); assert.ok(!st.includes(needle), `${name}: absent from the state afterwards`); }
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  });
  assert.ok(calls > 2000, `${calls} calls`);
  for (const [name, , needle] of SWEEP) assert.ok(!out.join('').includes(needle), `${name}: nothing was logged`);
});

// The echoes the review named: every hop pane shows MASKED input, including path ids, unknown keys and object KEYS.
test('every hop request body shows masked input: fields, path ids, unknown keys and object keys (the review\'s exact repros)', async () => {
  await withServer(async (url) => {
    for (const [name, v, needle] of SWEEP) {
      const ws = { 'x-workspace': `hop-${SWEEP.findIndex((x) => x[0] === name)}` };
      const shown = async (path, body, method = 'POST') => {
        const r = await (method === 'PUT' ? put : post)(url, path, body, ws); const j = await r.json();
        assert.ok(!JSON.stringify(j).includes(needle), `${name} ${path}: not in the answer`);
        return j.hops[0].request.body;
      };
      // the repro: a request whose reason is a userinfo / any payload, ACCEPTED, then the stored reason and the echo
      const ok = await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: v }) }), ws); const okj = await ok.json();
      assert.equal(ok.status, 200, name);
      assert.match(okj.hops[0].request.body.reason, /\[masked\]/, `${name}: the echoed reason`);
      assert.match(okj.state.requests[0].reason, /\[masked\]/, `${name}: the stored reason`);
      // a denial comment
      const dj = await (await post(url, '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', comment: v } }), ws)).json();
      assert.match(dj.state.requests[0].approval.DenialReason, /\[masked\]/, `${name}: DenialReason`);
      assert.match(dj.hops[0].request.body.comment, /\[masked\]/, `${name}: the echoed comment`);
      // each field of a request, a decision, a cancel, a remediation, an out-of-band change
      for (const f of ['requestedBy', 'subjectId', 'platform', 'resource', 'level', 'policyId', 'subjectKind']) assert.match((await shown('/api/requests', live({ request: spec({ [f]: v }) }))) [f], /\[masked\]/, `${name} request.${f}`);
      for (const f of ['approver', 'via', 'decision']) assert.match((await shown('/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'approve', via: 'console', [f]: v } })))[f], /\[masked\]/, `${name} decision.${f}`);
      assert.match((await shown('/api/requests/req-0001/cancel', live({ by: v }))).by, /\[masked\]/, `${name} by`);
      assert.match((await shown('/api/drift/remediate', live({ findingId: v }))).findingId, /\[masked\]/, `${name} findingId`);
      for (const f of ['op', 'platform', 'resource', 'subjectId', 'level']) assert.match((await shown('/api/platforms/out-of-band', live({ change: { op: 'grant', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer, level: 'read', [f]: v } })))[f], /\[masked\]/, `${name} change.${f}`);
      // path ids
      assert.match((await shown(`/api/requests/${enc(v)}/cancel`, live({ by: C.castEngineer }))).requestId, /\[masked\]/, `${name} cancel path id`);
      assert.match((await shown(`/api/requests/${enc(v)}/decision`, live({ decision: { approver: C.castSecLead, decision: 'approve' } }))).requestId, /\[masked\]/, `${name} decision path id`);
      assert.match((await shown(`/api/policies/${enc(v)}`, live({ policy: {} }), 'PUT')).id, /\[masked\]/, `${name} policy path id`);
      assert.match((await shown(`/api/policies/${enc(v)}/retire`, live({}))).id, /\[masked\]/, `${name} retire path id`);
      // unknown keys and object KEYS
      const uk = await shown('/api/requests', live({ request: { ...spec(), [v]: 1 } }));
      assert.ok(Object.keys(uk).some((k) => k.includes('[masked]')), `${name}: an unknown key is masked in the echo`);
      const pk = await shown('/api/policies/pol-code-write', live({ policy: { [v]: 1 } }), 'PUT');
      assert.ok(Object.keys(pk.policy).some((k) => k.includes('[masked]')), `${name}: a policy key is masked in the echo`);
      const ik = await shown('/api/integrations', live({ integrations: v }), 'PUT');
      assert.match(ik.integrations ?? ik, /\[masked\]/, `${name}: integrations as text`);
    }
  });
});

test('an error never quotes a key name or a slice of one: the answer to a policy with an unknown key is the same whatever the key is', async () => {
  await withServer(async (url) => {
    const errs = async (k) => (await (await put(url, '/api/policies/pol-code-write', live({ policy: { [k]: 1 } }), {})).json()).errors;
    const base = await errs('zz');
    assert.ok(Array.isArray(base) && base.includes('the policy carries a field the lab does not take'));
    for (const [, v] of SWEEP) assert.deepEqual(await errs(v), base);
    assert.deepEqual(await errs('a'.repeat(80)), base);
    for (const e of base) assert.ok(!/zz|"/.test(e), e);
    // and the other places that used to describe an unknown key
    const r = await post(url, '/api/requests', live({ request: { ...spec(), zzkey: 1 } })); const j = await r.json();
    assert.ok(!JSON.stringify(j.detail).includes('zzkey') && !JSON.stringify(j.errors || []).includes('zzkey'));
  });
});
