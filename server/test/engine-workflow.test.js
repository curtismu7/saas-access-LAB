import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, spec, dec } from './helpers.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);
const status = (e, id) => e.snapshot().requests.find((r) => r.id === id).status;
// A pol-code-write request: level 1 manager, level 2 owner.
const ask = (e, o) => e.createRequest(spec(o));

test('a two-level chain: level 1 approves, then level 2, then the grant exists with an expiry and a receipt', () => {
  const e = newEngine(); const r = ask(e);
  e.decide(dec(r.id, C.castManager));
  assert.equal(status(e, r.id), 'pending');
  assert.deepEqual(e.snapshot().requests[0].approval.Approvers, [C.castOwner], 'now routed to level 2');
  assert.equal(e.snapshot().requests[0].approval.NotifiedLevel, 2);
  assert.equal(e.snapshot().grants.length, 0);
  e.decide(dec(r.id, C.castOwner));
  assert.equal(status(e, r.id), 'granted');
  const g = e.snapshot().grants[0];
  assert.equal(g.status, 'active'); assert.equal(g.expiresAt, '2026-11-02T10:00:00.000Z'); assert.deepEqual(g.approvedBy.map((a) => a.id), [C.castManager, C.castOwner]);
  assert.equal(g.receiptId, 'r-0001');
  assert.equal(e.snapshot().requests[0].approval.GrantID, g.id);
});

test('self-approval is refused: the requester, the subject, and an agent approver', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ requestedBy: C.castSecLead, subjectId: C.castSecLead, policyId: 'pol-incident' }));
  refused(() => e.decide(dec(r.id, C.castSecLead)), 'self_approval_refused');
  refused(() => e.decide(dec(r.id, C.castSecLead, { decision: 'deny' })), 'self_approval_refused');
  refused(() => e.decide(dec(r.id, C.castAgent)), 'approver_not_human');
  assert.equal(status(e, r.id), 'pending', 'the refusals changed nothing');
  // a manager asking on behalf of an engineer cannot approve either, even if routed
  const r2 = e.createRequest(spec({ requestedBy: C.castManager, subjectId: C.castEngineer, policyId: 'pol-incident' }));
  e.decide(dec(r2.id, C.castSecLead));
  assert.equal(status(e, r2.id), 'granted');
  // the subject, when someone else asked for them, cannot approve for themselves (white-box: the default roster never routes a request to its own subject)
  const r3 = e.createRequest(spec({ policyId: 'pol-incident' }));
  const live = e.s.requests.find((x) => x.id === r3.id); live.subject = { kind: 'human', id: C.castSecLead }; live.requestedBy = C.castSecLead2;
  refused(() => e.decide(dec(r3.id, C.castSecLead)), 'self_approval_refused');
  refused(() => e.decide(dec(r3.id, C.castSecLead2)), 'self_approval_refused');
});

test('the refusal reason says whose approval it was', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ requestedBy: C.castSecLead, subjectId: C.castSecLead, policyId: 'pol-incident' }));
  assert.throws(() => e.decide(dec(r.id, C.castSecLead)), /the approver made this request/);
  const r2 = e.createRequest(spec({ policyId: 'pol-incident' }));
  const live = e.s.requests.find((x) => x.id === r2.id); live.subject = { kind: 'human', id: C.castSecLead }; live.requestedBy = C.castSecLead2;
  assert.throws(() => e.decide(dec(r2.id, C.castSecLead)), /the approver is the subject/);
});

test('someone not routed to the current level cannot approve; routing follows the level', () => {
  const e = newEngine(); const r = ask(e);
  refused(() => e.decide(dec(r.id, C.castOwner)), 'not_an_approver'); // level 2's approver, but level 1 is current
  refused(() => e.decide(dec(r.id, C.castEngineer2)), 'not_an_approver');
  refused(() => e.decide(dec(r.id, C.castSecLead)), 'not_an_approver');
  e.decide(dec(r.id, C.castManager));
  refused(() => e.decide(dec(r.id, C.castManager)), 'not_an_approver'); // level 2 now
});

test('input to a decision is type-checked and never echoed', () => {
  const e = newEngine(); const r = ask(e);
  const bad = [[{ requestId: 7 }, 'bad_request_id'], [{ requestId: 'x'.repeat(30) }, 'bad_request_id'], [{ requestId: 'req-9999' }, 'not_found'], [{ approver: 5 }, 'approver_unknown'], [{ approver: 'ghost' }, 'approver_unknown'],
    [{ decision: 'maybe' }, 'bad_decision'], [{ decision: undefined }, 'bad_decision'], [{ via: 'fax' }, 'bad_channel'], [{ via: 5 }, 'bad_channel'], [{ comment: 5 }, 'bad_comment']];
  for (const [patch, code] of bad) refused(() => e.decide({ ...dec(r.id, C.castManager), ...patch }), code);
  for (const x of [null, undefined, 'x', 5, []]) refused(() => e.decide(x), 'bad_request_id');
  assert.equal(status(e, r.id), 'pending');
});

test('deny ends the request; approving after a deny, or approving twice, is refused', () => {
  const e = newEngine(); const r = ask(e);
  e.decide(dec(r.id, C.castManager, { decision: 'deny', comment: 'not now' }));
  assert.equal(status(e, r.id), 'denied');
  const q = e.snapshot().requests[0];
  assert.equal(q.approval.DeniedBy, C.castManager); assert.equal(q.approval.DenialReason, 'not now');
  refused(() => e.decide(dec(r.id, C.castManager)), 'already_decided');
  refused(() => e.decide(dec(r.id, C.castOwner)), 'already_decided');
  refused(() => e.decide(dec(r.id, C.castManager, { decision: 'deny' })), 'already_decided');
  assert.equal(e.snapshot().grants.length, 0);
});

test('duplicate approval: a granted request cannot be approved again, and no second grant appears', () => {
  const e = newEngine(); const r = ask(e);
  e.decide(dec(r.id, C.castManager)); e.decide(dec(r.id, C.castOwner));
  refused(() => e.decide(dec(r.id, C.castOwner)), 'already_decided');
  refused(() => e.decide(dec(r.id, C.castManager)), 'already_decided');
  assert.equal(e.snapshot().grants.length, 1);
});

test('two approvals required at one level: the same person cannot count twice', () => {
  const e = newEngine();
  e.updatePolicy('pol-incident', { ...pickEdit(e.policy('pol-incident')), chain: [{ role: 'security', required: 2 }] });
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  e.decide(dec(r.id, C.castSecLead));
  assert.equal(status(e, r.id), 'pending');
  refused(() => e.decide(dec(r.id, C.castSecLead)), 'already_approved');
  assert.equal(e.snapshot().requests[0].approval.ApprovalCount, 1);
  e.decide(dec(r.id, C.castSecLead2));
  assert.equal(status(e, r.id), 'granted');
  assert.equal(e.snapshot().requests[0].approval.DistinctApprovers, 2);
});

test('distinct approvers across levels: required by the policy flag, and only then', () => {
  const e = newEngine();
  const chain = [{ role: 'security', required: 1 }, { role: 'security', required: 1 }];
  e.updatePolicy('pol-incident', { ...pickEdit(e.policy('pol-incident')), chain, requireDistinctApprovers: true });
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  e.decide(dec(r.id, C.castSecLead));
  refused(() => e.decide(dec(r.id, C.castSecLead)), 'distinct_approver_required');
  e.decide(dec(r.id, C.castSecLead2)); assert.equal(status(e, r.id), 'granted');
  e.updatePolicy('pol-incident', { ...pickEdit(e.policy('pol-incident')), chain, requireDistinctApprovers: false });
  const r2 = e.createRequest(spec({ policyId: 'pol-incident' }));
  e.decide(dec(r2.id, C.castSecLead)); e.decide(dec(r2.id, C.castSecLead));
  assert.equal(status(e, r2.id), 'granted', 'with the flag off one person may satisfy both levels');
});

test('an expired request cannot be approved: the window closes on the lab clock', () => {
  const e = newEngine(); const r = ask(e);
  e.decide(dec(r.id, C.castManager));
  e.advance({ minutes: 119 });
  assert.equal(status(e, r.id), 'pending', 'still inside the 120 minute window');
  e.advance({ minutes: 1 });
  assert.equal(status(e, r.id), 'expired');
  assert.equal(e.snapshot().requests[0].approval.ExpiredAt, '2026-11-02T11:00:00.000Z');
  refused(() => e.decide(dec(r.id, C.castOwner)), 'request_expired');
  refused(() => e.decide(dec(r.id, C.castOwner, { decision: 'deny' })), 'request_expired');
  assert.equal(e.snapshot().grants.length, 0);
});

test('approve-after-expiry is refused even if the sweep has not run: the decision itself checks the window', () => {
  const e = newEngine(); const r = ask(e);
  e.s.clock += 121 * 60_000; // move the clock without a reaper pass (an internal shortcut)
  refused(() => e.decide(dec(r.id, C.castManager)), 'request_expired');
  assert.equal(status(e, r.id), 'expired');
});

test('a request one minute inside its window can still be approved; at the boundary it cannot', () => {
  const e = newEngine(); const r = ask(e);
  e.s.clock += 119 * 60_000;
  e.decide(dec(r.id, C.castManager));
  assert.equal(status(e, r.id), 'pending');
  const r2 = ask(e); e.s.clock += 120 * 60_000;
  refused(() => e.decide(dec(r2.id, C.castManager)), 'request_expired');
});

test('cancel: only the requester or the subject, only while pending', () => {
  const e = newEngine(); const r = ask(e);
  refused(() => e.cancel({ requestId: r.id, by: C.castEngineer2 }), 'not_yours');
  refused(() => e.cancel({ requestId: r.id, by: 'ghost' }), 'bad_requester');
  refused(() => e.cancel({ requestId: 'req-0099', by: C.castEngineer }), 'not_found');
  e.cancel({ requestId: r.id, by: C.castEngineer });
  assert.equal(status(e, r.id), 'cancelled');
  refused(() => e.cancel({ requestId: r.id, by: C.castEngineer }), 'already_decided');
  refused(() => e.decide(dec(r.id, C.castManager)), 'already_decided');
});

test('auto-approval by policy: no approver, recorded as the policy, a grant straight away', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60 }));
  assert.equal(r.status, 'granted');
  const g = e.snapshot().grants[0];
  assert.deepEqual(g.approvedBy, [{ id: 'policy:pol-code-read', via: 'policy', level: 0 }]);
  assert.ok(e.snapshot().audit.some((a) => a.kind === 'request.auto_approved' && a.actor === 'policy:pol-code-read'));
  // above the rule: not automatic
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 121 })).status, 'pending');
  e.updatePolicy('pol-code-read', { ...pickEdit(e.policy('pol-code-read')), maxLevel: 'triage' });
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'triage', durationMin: 60 })).status, 'pending', 'a level above the auto rule needs approval');
});

test('auto-approval does not bypass the checks: self-approval does not apply, but a bad request is still refused', () => {
  const e = newEngine();
  refused(() => e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: '60' })), 'bad_duration');
  refused(() => e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60, requestedBy: C.castEngineer2 })), 'requester_not_allowed');
});

test('concurrent decisions on one request: exactly one grant, whoever gets there second is refused', async () => {
  const e = newEngine();
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  const results = await Promise.allSettled([C.castSecLead, C.castSecLead2].map((who) => Promise.resolve().then(() => e.decide(dec(r.id, who)))));
  assert.deepEqual(results.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'already_decided');
  assert.equal(e.snapshot().grants.length, 1);
  assert.equal(e.snapshot().requests[0].approval.ApprovalCount, 1);
});

test('concurrent decisions when two approvals are needed: both count, one grant', async () => {
  const e = newEngine();
  e.updatePolicy('pol-incident', { ...pickEdit(e.policy('pol-incident')), chain: [{ role: 'security', required: 2 }] });
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  await Promise.all([C.castSecLead, C.castSecLead2].map((who) => Promise.resolve().then(() => e.decide(dec(r.id, who)))));
  assert.equal(e.snapshot().grants.length, 1);
  assert.equal(e.snapshot().requests[0].approval.ApprovalCount, 2);
});

test('an agent and a human with the same request get the same decision, recorded the same way', () => {
  const e = newEngine();
  const h = e.createRequest(spec({ platform: 'databricks', resource: 'dbx-schema-gold', level: 'MODIFY', durationMin: 120, policyId: 'pol-lakehouse' }));
  const a = e.createRequest(spec({ platform: 'databricks', resource: 'dbx-schema-gold', level: 'MODIFY', durationMin: 120, policyId: 'pol-lakehouse', subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castAgent }));
  e.decide(dec(h.id, C.castDataOwner)); e.decide(dec(a.id, C.castDataOwner));
  const [ga, gh] = e.snapshot().grants;
  const shape = (g) => ({ ...g, id: 0, requestId: 0, subject: g.subject.kind, requestedBy: 0, receiptId: 0 });
  assert.deepEqual(shape(ga), shape(gh).constructor === Object ? { ...shape(gh), subject: 'agent' } : null);
  const kinds = e.snapshot().audit.filter((x) => x.kind === 'grant.created').map((x) => x.subject.kind).sort();
  assert.deepEqual(kinds, ['agent', 'human']);
});

test('a notify-only channel cannot approve; a chat channel needs a message with buttons for that approver and level', () => {
  const e = newEngine(); const r = ask(e);
  for (const via of ['msteams', 'jira', 'servicenow']) refused(() => e.decide(dec(r.id, C.castManager, { via })), 'channel_notify_only');
  refused(() => e.decide(dec(r.id, C.castManager, { via: 'mattermost' })), 'no_chat_action'); // the policy sends approvals to Slack
  e.decide(dec(r.id, C.castManager, { via: 'slack' }));
  refused(() => e.decide(dec(r.id, C.castManager, { via: 'slack' })), 'not_an_approver');
  e.decide(dec(r.id, C.castOwner, { via: 'slack' }));
  assert.equal(status(e, r.id), 'granted');
});

test('with Slack Hitl off nobody is sent an approval message, so a chat approval is refused; the console still works', () => {
  const e = newEngine();
  e.updateIntegrations({ slack: { Hitl: false } });
  const r = ask(e);
  assert.equal(e.snapshot().outbox.filter((m) => m.channel === 'slack').length, 0);
  refused(() => e.decide(dec(r.id, C.castManager, { via: 'slack' })), 'no_chat_action');
  e.decide(dec(r.id, C.castManager));
  assert.equal(e.snapshot().requests[0].currentLevel, 1);
});

test('the decision of a terminal request pulls the buttons: a chat approval after the fact is refused', () => {
  const e = newEngine(); const r = ask(e);
  e.decide(dec(r.id, C.castManager, { via: 'slack', decision: 'deny' }));
  assert.ok(e.snapshot().outbox.filter((m) => m.kind === 'approval_request').every((m) => m.actions.length === 0 && m.pulled));
  refused(() => e.decide(dec(r.id, C.castManager, { via: 'slack' })), 'already_decided');
});

const pickEdit = (p) => ({ maxLevel: p.maxLevel, maxDurationMin: p.maxDurationMin, chain: p.chain, requireDistinctApprovers: p.requireDistinctApprovers, requestTtlMin: p.requestTtlMin, channel: p.channel, autoApprove: p.autoApprove });
