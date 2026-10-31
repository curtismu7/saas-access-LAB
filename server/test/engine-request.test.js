import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, spec } from './helpers.js';
import { VERTICALS } from '../src/cast.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);

test('a valid request is created pending, with the chain, the approvers and the approval window', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  assert.equal(r.status, 'pending');
  assert.equal(r.id, 'req-0001');
  assert.deepEqual(r.approval.Approvers, [C.castManager]);
  assert.equal(r.approval.NotifiedLevel, 1);
  assert.equal(r.approval.ExpiresAt, '2026-11-02T11:00:00.000Z');
  assert.equal(e.snapshot().grants.length, 0, 'nothing is granted before approval');
});

test('every required argument is type-checked: missing or wrong-typed values are refused, never defaulted', () => {
  const e = newEngine();
  const bad = [
    [{ requestedBy: undefined }, 'bad_requester'], [{ requestedBy: 7 }, 'bad_requester'], [{ requestedBy: 'nobody' }, 'bad_requester'], [{ requestedBy: {} }, 'bad_requester'],
    [{ subjectKind: 'robot' }, 'bad_subject_kind'], [{ subjectKind: undefined }, 'bad_subject_kind'],
    [{ subjectId: 'nobody' }, 'bad_subject'], [{ subjectId: 42 }, 'bad_subject'], [{ subjectKind: 'agent' }, 'bad_subject'],
    [{ platform: 'jira' }, 'bad_platform'], [{ platform: '__proto__' }, 'bad_platform'], [{ platform: ['github'] }, 'bad_platform'], [{ platform: undefined }, 'bad_platform'],
    [{ resource: 'nope' }, 'bad_resource'], [{ resource: 'constructor' }, 'bad_resource'], [{ resource: 'snow-role-writer' }, 'bad_resource'], [{ resource: undefined }, 'bad_resource'],
    [{ level: 'root' }, 'bad_level'], [{ level: 'toString' }, 'bad_level'], [{ level: undefined }, 'bad_level'], [{ level: 3 }, 'bad_level'],
    [{ policyId: undefined }, 'bad_policy'], [{ policyId: 'nope' }, 'bad_policy'], [{ policyId: '__proto__' }, 'bad_policy'], [{ policyId: 'hasOwnProperty' }, 'bad_policy'],
    [{ policyId: 'pol-gitlab' }, 'policy_does_not_cover'],
    [{ reason: 12 }, 'bad_reason'], [{ reason: {} }, 'bad_reason'],
  ];
  for (const [patch, code] of bad) refused(() => e.createRequest(spec(patch)), code);
  assert.equal(e.snapshot().requests.length, 0, 'a refused request leaves nothing behind');
  for (const x of [null, undefined, 'x', 7, [], [1]]) refused(() => e.createRequest(x), 'bad_requester');
});

test('every grant carries an expiry: the duration must be a whole number of minutes from 1, inside the policy maximum', () => {
  const e = newEngine();
  for (const d of ['60', -5, 0, 0.5, 1.5, NaN, Infinity, -Infinity, null, undefined, {}, [], true, 1e12]) refused(() => e.createRequest(spec({ durationMin: d })), d === 1e12 ? 'duration_above_policy' : 'bad_duration');
  refused(() => e.createRequest(spec({ durationMin: 481 })), 'duration_above_policy');
  assert.equal(e.createRequest(spec({ durationMin: 480 })).durationMin, 480);
  assert.equal(e.createRequest(spec({ durationMin: 1 })).durationMin, 1);
});

test('a grant cannot be created without an expiry, even by calling the internals directly', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  for (const d of [undefined, null, 0, -1, NaN, Infinity, '60', 100000]) {
    refused(() => e.makeGrant({ ...r, durationMin: d }, []), 'bad_duration');
  }
  assert.equal(e.snapshot().grants.length, 0);
});

test('the level must not exceed what the policy may grant, and a retired policy refuses new requests', () => {
  const e = newEngine();
  refused(() => e.createRequest(spec({ level: 'maintain' })), 'level_above_policy');
  refused(() => e.createRequest(spec({ policyId: 'pol-code-read', level: 'triage' })), 'level_above_policy');
  e.retirePolicy('pol-code-write');
  refused(() => e.createRequest(spec()), 'policy_retired');
});

test('who may ask: the subject, or the subject\'s manager (an agent\'s custodian); nobody else', () => {
  const e = newEngine();
  const inc = (o) => spec({ policyId: 'pol-incident', ...o });
  assert.ok(e.createRequest(inc({ requestedBy: C.castManager })), 'the manager asks for the engineer');
  refused(() => e.createRequest(inc({ requestedBy: C.castEngineer2 })), 'requester_not_allowed');
  assert.ok(e.createRequest(inc({ subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castAgent })), 'the agent asks for itself');
  assert.ok(e.createRequest(inc({ subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castEngineer2 })), 'its custodian asks for it');
  refused(() => e.createRequest(inc({ subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castEngineer })), 'requester_not_allowed');
});

test('routing resolves each role to the right people', () => {
  const e = newEngine();
  const r = e.routing([{ role: 'manager', required: 1 }, { role: 'resource-owner', required: 1 }, { role: 'security', required: 1 }, { role: 'data-owner', required: 1 }], { subject: { kind: 'human', id: C.castEngineer }, resource: 'gh-repo-core', requestedBy: C.castEngineer });
  assert.deepEqual(r.map((l) => l.candidates.map((c) => c.id)), [[C.castManager], [C.castOwner], [C.castSecLead, C.castSecLead2], [C.castDataOwner]]);
  const infra = e.routing([{ role: 'resource-owner', required: 1 }], { subject: { kind: 'human', id: C.castEngineer }, resource: 'gh-repo-infra', requestedBy: C.castEngineer });
  assert.deepEqual(infra[0].candidates.map((c) => c.id), [C.castSecLead], 'the owner depends on the resource');
  const agent = e.routing([{ role: 'manager', required: 1 }], { subject: { kind: 'agent', id: C.castAgent }, resource: 'gh-repo-core', requestedBy: C.castAgent });
  assert.deepEqual(agent[0].candidates.map((c) => c.id), [C.castEngineer2], 'an agent routes to its custodian');
});

test('routing marks the requester, the subject and non-humans as not allowed, with the reason', () => {
  const e = newEngine();
  const r = e.routing([{ role: 'security', required: 1 }], { subject: { kind: 'human', id: C.castSecLead }, resource: 'gh-repo-core', requestedBy: C.castSecLead });
  assert.deepEqual(r[0].candidates, [{ id: C.castSecLead, allowed: false, reason: 'requester' }, { id: C.castSecLead2, allowed: true, reason: null }]);
  const m = e.routing([{ role: 'manager', required: 1 }], { subject: { kind: 'human', id: C.castEngineer }, resource: 'gh-repo-core', requestedBy: C.castManager });
  assert.equal(m[0].candidates[0].reason, 'requester');
  const s = e.routing([{ role: 'security', required: 1 }], { subject: { kind: 'human', id: C.castSecLead2 }, resource: 'gh-repo-core', requestedBy: C.castManager });
  assert.equal(s[0].candidates.find((c) => c.id === C.castSecLead2).reason, 'subject');
});

test('a request nobody could ever approve is refused up front (the owner asking for their own resource)', () => {
  const e = newEngine();
  // the owner of gh-repo-core asks for write: level 1 is the owner's manager, level 2 is the owner: only the requester
  refused(() => e.createRequest(spec({ requestedBy: C.castOwner, subjectId: C.castOwner })), 'no_eligible_approver');
  // a level that needs two approvals when only one person is eligible
  e.updatePolicy('pol-incident', { ...pick(e.policy('pol-incident')), chain: [{ role: 'manager', required: 2 }] });
  refused(() => e.createRequest(spec({ policyId: 'pol-incident' })), 'no_eligible_approver');
});

test('preview gives the same verdicts as a real request and creates nothing', () => {
  const e = newEngine();
  const ok = e.preview(spec());
  assert.equal(ok.ok, true); assert.equal(ok.routing.length, 2); assert.equal(ok.autoApprove, false);
  assert.equal(e.preview(spec({ durationMin: '60' })).error.code, 'bad_duration');
  assert.equal(e.preview(spec({ requestedBy: C.castOwner, subjectId: C.castOwner })).error.code, 'no_eligible_approver');
  assert.equal(e.preview(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60 })).autoApprove, true);
  assert.equal(e.preview(null).ok, false);
  assert.equal(e.snapshot().requests.length, 0);
});

test('the request limit is a refusal, not a silent drop', () => {
  const e = newEngine();
  for (let i = 0; i < e.snapshot().limits.requests; i++) e.createRequest(spec());
  refused(() => e.createRequest(spec()), 'limit_reached');
  assert.equal(e.snapshot().requests.length, 200);
});

test('every vertical pack gives a working engine (names differ, behaviour does not)', () => {
  for (const cast of Object.values(VERTICALS)) {
    const e = newEngine(cast);
    const r = e.createRequest({ ...spec(), requestedBy: cast.castEngineer, subjectId: cast.castEngineer });
    assert.deepEqual(r.approval.Approvers, [cast.castManager]);
    assert.equal(new Set(e.snapshot().roster.map((p) => p.id)).size, e.snapshot().roster.length, 'the roster ids are unique');
  }
});

const pick = (p) => ({ maxLevel: p.maxLevel, maxDurationMin: p.maxDurationMin, chain: p.chain, requireDistinctApprovers: p.requireDistinctApprovers, requestTtlMin: p.requestTtlMin, channel: p.channel, autoApprove: p.autoApprove });
