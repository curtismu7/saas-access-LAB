import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, json, post, put, rawHttp, spec, withServer } from './helpers.js';
import { installNetguard } from '../src/netguard.js';

const guard = installNetguard();
const W = (id) => ({ 'x-workspace': id });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const ask = (url, o, ws = 'default') => post(url, '/api/requests', live({ request: spec(o) }), W(ws));
const decide = (url, id, d, ws = 'default') => post(url, `/api/requests/${id}/decision`, live({ decision: d }), W(ws));

test('health, info and story answer; the story fills every token for every vertical', async () => {
  await withServer(async (url) => {
    const h = await json(await get(url, '/api/health'));
    assert.equal(h.schema, 'demo-health/1'); assert.equal(h.demo.id, 'saas-access-lab');
    const info = await json(await get(url, '/api/info'));
    assert.deepEqual([info.simulated, info.unverified, info.release], [true, true, '2026-11-02']);
    for (const v of ['finance', 'health', 'retail']) {
      const s = await json(await get(url, `/api/story?vertical=${v}`));
      assert.ok(!/\{\{/.test(JSON.stringify(s)), v);
      assert.equal(s.platforms.length, 6); assert.equal(s.vertical, v);
    }
    assert.equal((await json(await get(url, '/api/story?vertical=__proto__'))).vertical, 'finance', 'an unknown vertical falls back, never errors');
  });
});

test('the state: Mock gives a generated scenario, Live gives the workspace engine, both the same shape', async () => {
  await withServer(async (url) => {
    const m = await json(await get(url, '/api/state?mode=mock&vertical=finance&scenario=drift'));
    const l = await json(await get(url, '/api/state?mode=live&vertical=finance'));
    assert.equal(m.scenario.id, 'drift'); assert.equal(m.scenarios.length, 6); assert.equal(m.state.drift.open.length, 2);
    assert.deepEqual(Object.keys(m.state).sort(), Object.keys(l.state).sort(), 'one shape for both');
    assert.equal(l.state.requests.length, 0);
    assert.equal((await json(await get(url, '/api/state?mode=mock&scenario=nope'))).scenario.id, 'warehouse-role', 'an unknown scenario falls back');
    assert.equal((await get(url, '/api/state?mode=prod')).status, 400);
    assert.equal((await get(url, '/api/state')).status, 400);
    assert.equal((await get(url, '/api/state?mode=live', W('Bad Id'))).status, 400);
  });
});

test('Mock is read-only: every write is refused with 409 and changes nothing', async () => {
  await withServer(async (url) => {
    const body = { mode: 'mock', vertical: 'finance' };
    const calls = [
      post(url, '/api/requests', { ...body, request: spec() }), post(url, '/api/requests/req-0001/decision', { ...body, decision: {} }), post(url, '/api/requests/req-0001/cancel', { ...body, by: C.castEngineer }),
      post(url, '/api/clock', { ...body, clock: { minutes: 5 } }), post(url, '/api/reaper/run', body), post(url, '/api/drift/reconcile', body), post(url, '/api/drift/remediate', { ...body, findingId: 'd-0001' }),
      post(url, '/api/platforms/out-of-band', { ...body, change: {} }), post(url, '/api/platforms/sync', { ...body, change: {} }), put(url, '/api/policies/pol-incident', { ...body, policy: {} }),
      post(url, '/api/policies/pol-incident/retire', body), put(url, '/api/integrations', { ...body, integrations: {} }),
    ];
    for (const r of await Promise.all(calls)) { assert.equal(r.status, 409); assert.equal((await r.json()).error, 'mock_is_read_only'); }
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.requests.length, 0);
  });
});

test('writes need a mode of mock or live, an object body, and only known top-level keys', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/requests', { vertical: 'finance', request: spec() })).status, 400);
    assert.equal((await post(url, '/api/requests', { mode: 'prod', request: spec() })).status, 400);
    assert.equal((await post(url, '/api/requests', [1])).status, 400);
    const r = await post(url, '/api/requests', live({ request: spec(), token: 'x' }));
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'unknown_field');
    const r2 = await post(url, '/api/requests', live({ request: { ...spec(), password: 'x' } }));
    assert.equal(r2.status, 400); assert.equal((await r2.json()).error, 'unknown_field');
    const r3 = await post(url, '/api/clock', live({ clock: { minutes: 5, secret: 'x' } }));
    assert.equal((await r3.json()).error, 'unknown_field');
    assert.equal((await post(url, '/api/requests', live({ request: 'x' }))).status, 400);
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.requests.length, 0);
  });
});

test('Live: a request is created, approved in two levels, granted, and the whole state comes back with hops', async () => {
  await withServer(async (url) => {
    const r = await ask(url, {});
    const b = await r.json();
    assert.equal(r.status, 200); assert.equal(b.ok, true); assert.equal(b.result.status, 'pending'); assert.equal(b.state.requests.length, 1);
    assert.ok(b.hops.length >= 3); assert.equal(b.hops[0].label, 'browser to the lab API');
    assert.match(r.headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal((await decide(url, 'req-0001', { approver: C.castManager, decision: 'approve', via: 'slack' })).status, 200);
    const last = await json(await decide(url, 'req-0001', { approver: C.castOwner, decision: 'approve' }));
    assert.equal(last.result.status, 'granted'); assert.equal(last.state.grants[0].status, 'active');
    assert.ok(last.hops.some((h) => /GitHub \(simulated API call, grant\)/.test(h.label)), 'the simulated platform call is a hop');
    const clock = await json(await post(url, '/api/clock', live({ clock: { minutes: 61 } })));
    assert.deepEqual(clock.result.reaped, ['g-0001']); assert.equal(clock.state.grants[0].status, 'expired');
  });
});

test('refusals come back as JSON with their code, status and the state: self-approval 403, unknown 404, decided 409', async () => {
  await withServer(async (url) => {
    await ask(url, { policyId: 'pol-incident', requestedBy: C.castSecLead, subjectId: C.castSecLead });
    const s = await decide(url, 'req-0001', { approver: C.castSecLead, decision: 'approve' });
    const sb = await s.json();
    assert.equal(s.status, 403); assert.equal(sb.error, 'self_approval_refused'); assert.match(sb.detail, /approver made this request/); assert.equal(sb.ok, false); assert.ok(sb.state);
    assert.equal((await decide(url, 'req-0099', { approver: C.castSecLead2, decision: 'approve' })).status, 404);
    assert.equal((await decide(url, 'nope', { approver: C.castSecLead2, decision: 'approve' })).status, 400);
    assert.equal((await decide(url, 'req-0001', { approver: C.castSecLead2, decision: 'approve' })).status, 200);
    const again = await decide(url, 'req-0001', { approver: C.castSecLead2, decision: 'approve' });
    assert.equal(again.status, 409); assert.equal((await again.json()).error, 'already_decided');
    assert.equal((await decide(url, 'req-0001', { approver: C.castSecLead2, decision: 'approve', evil: 1 })).status, 400);
    assert.equal((await decide(url, 'req-0001', 'x')).status, 400);
  });
});

test('every refusal of a bad request: a duration that is a string, negative, zero, huge or missing never creates a request', async () => {
  await withServer(async (url) => {
    for (const d of ['60', -1, 0, 99999999, 1.5, null]) { const r = await ask(url, { durationMin: d }); assert.equal(r.status, d === 99999999 ? 400 : 400, String(d)); }
    const r = await post(url, '/api/requests', live({ request: (({ durationMin, ...rest }) => rest)(spec()) }));
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'bad_duration');
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.requests.length, 0);
  });
});

test('concurrent approvals over HTTP: two approvers at once give exactly one grant', async () => {
  await withServer(async (url) => {
    await ask(url, { policyId: 'pol-incident' });
    const rs = await Promise.all([C.castSecLead, C.castSecLead2].map((a) => decide(url, 'req-0001', { approver: a, decision: 'approve' })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.grants.length, 1);
  });
});

test('preview works in both modes, creates nothing, and reports refusals as data', async () => {
  await withServer(async (url) => {
    for (const mode of ['mock', 'live']) {
      const ok = await json(await post(url, '/api/preview', { mode, vertical: 'finance', request: spec() }));
      assert.equal(ok.preview.ok, true); assert.equal(ok.preview.routing.length, 2);
      const bad = await json(await post(url, '/api/preview', { mode, vertical: 'finance', request: spec({ durationMin: 'x' }) }));
      assert.equal(bad.preview.error.code, 'bad_duration');
    }
    assert.equal((await post(url, '/api/preview', { mode: 'nope', request: {} })).status, 400);
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.requests.length, 0);
  });
});

test('workspaces are isolated: one visitor\'s request, clock and Reset never touch another\'s', async () => {
  await withServer(async (url) => {
    await ask(url, {}, 'ws-a'); await post(url, '/api/clock', live({ clock: { minutes: 30 } }), W('ws-a'));
    const a = await json(await get(url, '/api/state?mode=live', W('ws-a')));
    const b = await json(await get(url, '/api/state?mode=live', W('ws-b')));
    assert.equal(a.state.requests.length, 1); assert.equal(b.state.requests.length, 0);
    assert.equal(a.state.clock, '2026-11-02T09:30:00.000Z'); assert.equal(b.state.clock, '2026-11-02T09:00:00.000Z');
    await ask(url, {}, 'ws-b');
    const reset = await json(await post(url, '/api/reset', {}, W('ws-a')));
    assert.deepEqual(reset, { reset: 'ok', workspace: 'ws-a' });
    assert.equal((await json(await get(url, '/api/state?mode=live', W('ws-a')))).state.requests.length, 0);
    assert.equal((await json(await get(url, '/api/state?mode=live', W('ws-b')))).state.requests.length, 1);
    assert.equal((await post(url, '/api/reset', {}, W('Bad Id'))).status, 400);
  });
});

test('each vertical has its own engine inside a workspace; Reset clears all of them', async () => {
  await withServer(async (url) => {
    await post(url, '/api/requests', { mode: 'live', vertical: 'health', request: spec({ requestedBy: 'lena.ortiz', subjectId: 'lena.ortiz' }) });
    assert.equal((await json(await get(url, '/api/state?mode=live&vertical=health'))).state.requests.length, 1);
    assert.equal((await json(await get(url, '/api/state?mode=live&vertical=finance'))).state.requests.length, 0);
    await post(url, '/api/reset', {});
    assert.equal((await json(await get(url, '/api/state?mode=live&vertical=health'))).state.requests.length, 0);
  });
});

test('the policy editor over HTTP: a valid edit applies, an invalid one is refused with every reason, retire releases grants', async () => {
  await withServer(async (url) => {
    const cur = (await json(await get(url, '/api/state?mode=live'))).state.policies.find((p) => p.id === 'pol-incident');
    const edit = { maxLevel: cur.maxLevel, maxDurationMin: 100, chain: cur.chain, requireDistinctApprovers: cur.requireDistinctApprovers, requestTtlMin: cur.requestTtlMin, channel: cur.channel, autoApprove: cur.autoApprove };
    const ok = await put(url, '/api/policies/pol-incident', live({ policy: edit }));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).state.policies.find((p) => p.id === 'pol-incident').maxDurationMin, 100);
    const bad = await put(url, '/api/policies/pol-incident', live({ policy: { ...edit, maxDurationMin: 0, chain: [] } }));
    const bb = await bad.json();
    assert.equal(bad.status, 400); assert.equal(bb.error, 'bad_policy'); assert.equal(bb.errors.length, 2);
    assert.equal((await put(url, '/api/policies/nope', live({ policy: edit }))).status, 404);
    await ask(url, { policyId: 'pol-incident' }); await decide(url, 'req-0001', { approver: C.castSecLead2, decision: 'approve' });
    const rt = await json(await post(url, '/api/policies/pol-incident/retire', live({})));
    assert.deepEqual(rt.result.revoked, ['g-0001']);
  });
});

test('drift over HTTP: by hand, reconcile, remediate', async () => {
  await withServer(async (url) => {
    const oob = await post(url, '/api/platforms/out-of-band', live({ change: { op: 'grant', platform: 'github', resource: 'gh-repo-infra', subjectKind: 'human', subjectId: C.castEngineer2, level: 'write' } }));
    assert.equal(oob.status, 200);
    const rec = await json(await post(url, '/api/drift/reconcile', live({})));
    assert.equal(rec.result.findings, 1); assert.equal(rec.state.drift.open[0].kind, 'unrecorded');
    const rem = await json(await post(url, '/api/drift/remediate', live({ findingId: rec.state.drift.open[0].id })));
    assert.equal(rem.state.drift.open.length, 0);
    const sync = await post(url, '/api/platforms/sync', live({ change: { platform: 'snowflake', sync: false } }));
    assert.equal((await sync.json()).state.sync.snowflake, false);
  });
});

test('a traceparent from the caller continues its trace; a bad one starts a new trace', async () => {
  await withServer(async (url) => {
    const tid = 'a'.repeat(32);
    const r = await post(url, '/api/requests', live({ request: spec() }), { traceparent: `00-${tid}-${'b'.repeat(16)}-01` });
    const b = await r.json();
    assert.equal(b.traceId, tid);
    assert.ok(b.hops.every((h) => h.request.headers.traceparent.startsWith(`00-${tid}-`)), 'every hop carries the trace');
    assert.equal(new Set(b.hops.map((h) => h.request.headers.traceparent.split('-')[2])).size, b.hops.length, 'a new span for every hop');
    const r2 = await json(await post(url, '/api/requests', live({ request: spec() }), { traceparent: 'garbage' }));
    assert.notEqual(r2.traceId, tid); assert.match(r2.traceId, /^[0-9a-f]{32}$/);
  });
});

test('the Host check, same-origin writes, body size, JSON errors and 404 behave; no stack trace ever leaves', async () => {
  await withServer(async (url) => {
    assert.equal((await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example.invalid' } })).status, 403);
    assert.equal((await post(url, '/api/reset', {}, { origin: 'http://evil.example.invalid' })).status, 403);
    assert.equal((await post(url, '/api/requests', live({ request: { reason: 'x'.repeat(40000) } }))).status, 413);
    const bad = await rawHttp(`${url}/api/requests`, { method: 'POST', headers: { host: new URL(url).host, 'content-type': 'application/json', origin: url }, body: '{"mode":' });
    assert.equal(bad.status, 400); assert.doesNotMatch(bad.text, /node_modules|at .*\(/);
    const nf = await get(url, '/api/nope'); assert.equal(nf.status, 404); assert.deepEqual(await nf.json(), { error: 'not_found' });
    assert.equal((await get(url, '/api/requests/req-0001/decision')).status, 404);
    assert.equal((await get(url, '/api/health')).headers.get('x-content-type-options'), 'nosniff');
  });
});

test('zero outbound network attempts across the whole API in both modes', async () => {
  await withServer(async (url) => {
    for (const mode of ['mock', 'live']) {
      await get(url, `/api/state?mode=${mode}`); await post(url, '/api/preview', { mode, request: spec() });
      await post(url, '/api/requests', { mode, vertical: 'finance', request: spec() });
    }
    await post(url, '/api/clock', live({ clock: { minutes: 1440 } }));
    await post(url, '/api/drift/reconcile', live({}));
  });
  assert.deepEqual(guard.attempts, []);
});
