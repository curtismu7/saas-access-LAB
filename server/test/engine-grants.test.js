import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, spec, dec, grantWrite } from './helpers.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);
const members = (e, platform, resource) => e.snapshot().platforms.find((p) => p.id === platform).groups.find((g) => g.resource === resource).members;
const grantAuto = (e, o = {}) => e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60, ...o }));
// An incident grant: the security group approves.
const incident = (e, o = {}) => { const r = e.createRequest(spec({ policyId: 'pol-incident', durationMin: 60, ...o })); e.decide(dec(r.id, C.castSecLead2)); return r; };

test('a grant puts real state on the platform and the reaper removes it when the window closes', () => {
  const e = newEngine(); grantWrite(e);
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), [{ subjectKind: 'human', id: C.castEngineer, level: 'write', origin: 'privilege', prior: null, since: '2026-11-02T09:00:00.000Z' }]);
  e.advance({ minutes: 59 });
  assert.equal(members(e, 'github', 'gh-repo-core').length, 1, 'still there before the expiry');
  e.advance({ minutes: 1 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), [], 'gone at the expiry');
  assert.equal(e.snapshot().grants[0].status, 'expired');
  assert.equal(e.snapshot().grants[0].removalReason, 'expired');
});

test('the reaper acts on the grants alone: it removes access long after the request workflow finished', () => {
  const e = newEngine(); const r = grantWrite(e, { durationMin: 480 });
  assert.equal(e.snapshot().requests.find((x) => x.id === r.id).status, 'granted');
  e.advance({ minutes: 1440 }); // a whole day later
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), []);
  assert.equal(e.snapshot().requests.find((x) => x.id === r.id).status, 'granted', 'the request stays a finished workflow');
});

test('the reaper is idempotent: another pass at the same time, or later, changes nothing', () => {
  const e = newEngine(); grantWrite(e);
  e.advance({ minutes: 61 });
  const before = JSON.stringify([e.snapshot().grants, e.snapshot().audit.length, e.snapshot().receipts.items.length, e.snapshot().platforms]);
  assert.deepEqual(e.reap(), { reaped: [], requestsExpired: [] });
  assert.deepEqual(e.reap(), { reaped: [], requestsExpired: [] });
  assert.equal(JSON.stringify([e.snapshot().grants, e.snapshot().audit.length, e.snapshot().receipts.items.length, e.snapshot().platforms]), before);
  assert.equal(e.snapshot().receipts.items.length, 2, 'one receipt for the grant, one for its removal, never a third');
});

test('a manual reaper pass at the expiry instant removes the grant; one minute before does not', () => {
  const e = newEngine(); grantWrite(e);
  e.s.clock += 59 * 60_000; assert.deepEqual(e.reap().reaped, []);
  e.s.clock += 60_000; assert.deepEqual(e.reap().reaped, ['g-0001']);
});

test('reference counting: two policies grant the same access; the first to end leaves the access in place', () => {
  const e = newEngine();
  grantWrite(e, { durationMin: 480 });             // routine, until 17:00
  incident(e);                                      // incident, until 10:00
  assert.deepEqual(e.snapshot().grants.map((g) => g.refCount), [2, 2], 'both grants share one holding');
  assert.equal(e.snapshot().holdings[0].refCount, 2);
  assert.equal(members(e, 'github', 'gh-repo-core').length, 1, 'one platform entry, not two');
  e.advance({ minutes: 61 });
  const [incidentGrant, routine] = e.snapshot().grants;
  assert.equal(incidentGrant.status, 'expired'); assert.equal(routine.status, 'active');
  assert.equal(routine.refCount, 1);
  assert.equal(members(e, 'github', 'gh-repo-core').length, 1, 'the other policy still grants it');
  e.advance({ minutes: 480 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), [], 'gone when the last reference ends');
});

test('reference counting: removing (retiring) one policy does not remove access the other still grants', () => {
  const e = newEngine();
  grantWrite(e, { durationMin: 480 });
  incident(e, { durationMin: 240 });
  const out = e.retirePolicy('pol-incident');
  assert.deepEqual(out.revoked, ['g-0002']);
  assert.equal(members(e, 'github', 'gh-repo-core').length, 1, 'the routine grant still holds the access');
  assert.equal(e.snapshot().grants.find((g) => g.id === 'g-0002').removalReason, 'policy-retired');
  assert.equal(e.snapshot().grants.find((g) => g.id === 'g-0001').status, 'active');
  const out2 = e.retirePolicy('pol-code-write');
  assert.deepEqual(out2.revoked, ['g-0001']);
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), []);
});

test('the platform entry holds the HIGHEST live level, and falls back when the higher grant ends', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-read', { ...edit(e, 'pol-code-read'), maxLevel: 'triage', autoApprove: { enabled: true, maxLevel: 'triage', maxDurationMin: 120 } });
  grantAuto(e, { level: 'triage', durationMin: 120 });
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'triage');
  incident(e, { durationMin: 60 });
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'write');
  e.advance({ minutes: 61 });
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'triage', 'drops back to what the other grant gives');
  e.advance({ minutes: 60 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), []);
});

test('holdings are per subject and per resource: another person or another resource is not a shared reference', () => {
  const e = newEngine();
  grantAuto(e); grantAuto(e, { requestedBy: C.castEngineer2, subjectId: C.castEngineer2 }); grantAuto(e, { resource: 'gh-repo-infra' });
  assert.deepEqual(e.snapshot().grants.map((g) => g.refCount), [1, 1, 1]);
  e.advance({ minutes: 61 });
  assert.equal(e.snapshot().grants.every((g) => g.status === 'expired'), true);
  assert.equal(e.snapshot().platforms.flatMap((p) => p.groups).flatMap((g) => g.members).length, 0);
});

test('an agent and a human are separate subjects even with the same id', () => {
  const e = newEngine();
  grantAuto(e); grantAuto(e, { subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castAgent });
  assert.equal(members(e, 'github', 'gh-repo-core').length, 2);
  assert.ok(members(e, 'github', 'gh-repo-core').some((m) => m.subjectKind === 'agent'));
});

test('the clock only moves forward: backwards, zero, fractional, string and huge moves are refused', () => {
  const e = newEngine();
  for (const m of [-15, 0, -1]) refused(() => e.advance({ minutes: m }), 'clock_backwards');
  for (const m of ['15', 1.5, NaN, null, undefined, {}, [15], true]) refused(() => e.advance({ minutes: m }), 'bad_minutes');
  refused(() => e.advance({ minutes: 10081 }), 'advance_too_far');
  refused(() => e.advance({ to: '2026-11-02T08:00:00Z' }), 'clock_backwards');
  refused(() => e.advance({ to: '2026-11-02T09:00:00Z' }), 'clock_backwards');
  for (const to of ['tomorrow', 5, '2026-13-45T00:00:00Z', '2026-11-02', null]) refused(() => e.advance({ to }), 'bad_time');
  for (const x of [null, undefined, 5, 'x', []]) refused(() => e.advance(x), 'bad_minutes');
  assert.equal(e.snapshot().clock, '2026-11-02T09:00:00.000Z', 'no refused move changed the clock');
  e.advance({ to: '2026-11-02T10:00:00Z' });
  assert.equal(e.snapshot().clock, '2026-11-02T10:00:00.000Z');
  e.advance({ minutes: 15 }); assert.equal(e.snapshot().clock, '2026-11-02T10:15:00.000Z');
});

test('a clock move cannot undo a removal: after the reaper, going back is refused and the access stays gone', () => {
  const e = newEngine(); grantWrite(e); e.advance({ minutes: 61 });
  refused(() => e.advance({ minutes: -61 }), 'clock_backwards');
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), []);
});

test('the reaper wakes every 5 lab minutes: a removal inside a long move is stamped at the tick, with its lag', () => {
  const e = newEngine(); e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 61 })); // expires 10:01
  e.advance({ minutes: 600 });
  const g = e.snapshot().grants[0];
  assert.equal(g.removedAt, '2026-11-02T10:05:00.000Z');
  const a = e.snapshot().audit.find((x) => x.kind === 'grant.reaped');
  assert.equal(a.lagMin, 4);
});

test('a move that ends exactly at the expiry removes the grant at that instant (lag 0)', () => {
  const e = newEngine(); grantAuto(e); e.advance({ minutes: 60 });
  assert.equal(e.snapshot().grants[0].removedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(e.snapshot().audit.find((x) => x.kind === 'grant.reaped').lagMin, 0);
});

test('a grant starts when the last approval lands, not when the request was made', () => {
  const e = newEngine(); const r = e.createRequest(spec({ durationMin: 60 }));
  e.advance({ minutes: 30 });
  e.decide(dec(r.id, C.castManager)); e.decide(dec(r.id, C.castOwner));
  assert.equal(e.snapshot().grants[0].grantedAt, '2026-11-02T09:30:00.000Z');
  assert.equal(e.snapshot().grants[0].expiresAt, '2026-11-02T10:30:00.000Z');
});

test('a held request is not a grant: nothing is on the platform until the last level approves', () => {
  const e = newEngine(); const r = e.createRequest(spec()); e.decide(dec(r.id, C.castManager));
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), []);
});

test('every platform gets real state of its own kind: collaborators, members, role holders, privileges, assignments', () => {
  const e = newEngine();
  const ask = (platform, resource, level, policyId, who) => { const r = e.createRequest(spec({ platform, resource, level, policyId, durationMin: 30 })); for (const a of who) e.decide(dec(r.id, a)); return r; };
  ask('github', 'gh-team-releases', 'member', 'pol-release-team', [C.castManager]);
  ask('gitlab', 'gl-project-service', 'developer', 'pol-gitlab', [C.castManager]);
  ask('salesforce', 'sf-permset-reader', 'assigned', 'pol-salesforce', [C.castManager, C.castSecLead]);
  ask('snowflake', 'snow-role-analyst', 'member', 'pol-warehouse', [C.castDataOwner, C.castSecLead]);
  ask('databricks', 'dbx-schema-pii', 'SELECT', 'pol-lakehouse-pii', [C.castDataOwner, C.castSecLead]);
  ask('google', 'gw-role-helpdesk', 'assigned', 'pol-workspace-admin', [C.castManager, C.castSecLead]);
  const view = e.snapshot().platforms;
  assert.deepEqual(view.map((p) => p.groups.flatMap((g) => g.members).length), [1, 1, 1, 1, 1, 1]);
  e.advance({ minutes: 31 });
  assert.deepEqual(e.snapshot().platforms.map((p) => p.groups.flatMap((g) => g.members).length), [0, 0, 0, 0, 0, 0]);
});

test('the platform calls shown are illustrations: the auth METHOD name appears and no credential does', () => {
  const e = newEngine();
  e.trace = { traceId: 'a'.repeat(32), span: () => 'b'.repeat(16) };
  grantAuto(e);
  const hop = e.hops.find((h) => /GitHub/.test(h.label));
  assert.ok(hop, 'a simulated GitHub call was recorded');
  assert.equal(hop.request.auth.method, 'personal access token');
  assert.equal(hop.request.auth.value, 'never shown, never stored');
  assert.match(hop.request.url, /^https:\/\/github\.example\//);
  assert.match(hop.request.headers.traceparent, /^00-a{32}-b{16}-01$/);
});

test('the grant limit is a refusal', () => {
  const e = newEngine();
  const max = e.snapshot().limits.grants;
  for (let i = 0; i < max; i++) grantAuto(e, { subjectId: i % 2 ? C.castEngineer2 : C.castEngineer, requestedBy: i % 2 ? C.castEngineer2 : C.castEngineer });
  refused(() => grantAuto(e), 'limit_reached');
  assert.equal(e.snapshot().grants.length, max);
});

test('reset returns the engine to its start: clock, requests, grants, platform state, outbox, audit and edited policies', () => {
  const e = newEngine(); grantWrite(e); e.advance({ minutes: 30 }); e.updatePolicy('pol-incident', { ...edit(e, 'pol-incident'), maxDurationMin: 10 });
  e.reset();
  const s = e.snapshot();
  assert.equal(s.clock, '2026-11-02T09:00:00.000Z');
  assert.deepEqual([s.requests.length, s.grants.length, s.audit.length, s.outbox.length, s.receipts.items.length, s.platforms.flatMap((p) => p.groups).flatMap((g) => g.members).length], [0, 0, 0, 0, 0, 0]);
  assert.equal(s.policies.find((p) => p.id === 'pol-incident').maxDurationMin, 240);
});

const edit = (e, id) => { const p = e.policy(id); return { maxLevel: p.maxLevel, maxDurationMin: p.maxDurationMin, chain: p.chain, requireDistinctApprovers: p.requireDistinctApprovers, requestTtlMin: p.requestTtlMin, channel: p.channel, autoApprove: p.autoApprove }; };
