import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, spec, dec } from './helpers.js';
import { EDITABLE_FIELDS, defaultPolicies, policyProblems, validateEdit } from '../src/policies.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);
const edit = (e, id, patch = {}) => { const p = e.policy(id); return { maxLevel: p.maxLevel, maxDurationMin: p.maxDurationMin, chain: p.chain.map((c) => ({ ...c })), requireDistinctApprovers: p.requireDistinctApprovers, requestTtlMin: p.requestTtlMin, channel: p.channel, autoApprove: { ...p.autoApprove }, ...patch }; };

test('the default policies are structurally valid and cover every resource at least once', () => {
  assert.deepEqual(policyProblems(defaultPolicies()), []);
  const covered = new Set(defaultPolicies().flatMap((p) => p.resources));
  assert.equal(covered.size, 13);
  assert.deepEqual([...EDITABLE_FIELDS].sort(), ['autoApprove', 'chain', 'channel', 'maxDurationMin', 'maxLevel', 'requestTtlMin', 'requireDistinctApprovers']);
});

// --- one test per editable field: change it, and the behaviour of a NEW request changes in the way the field says (mutation-proof) ---------------

test('field maxLevel: lowering it refuses a level that was fine; raising it allows one that was not', () => {
  const e = newEngine();
  assert.ok(e.createRequest(spec({ level: 'write' })));
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxLevel: 'triage' }));
  refused(() => e.createRequest(spec({ level: 'write' })), 'level_above_policy');
  assert.ok(e.createRequest(spec({ level: 'triage' })));
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxLevel: 'admin' }));
  assert.ok(e.createRequest(spec({ level: 'admin' })));
});

test('field maxDurationMin: the longest window is enforced exactly (the value, and one more)', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxDurationMin: 90 }));
  assert.ok(e.createRequest(spec({ durationMin: 90 })));
  refused(() => e.createRequest(spec({ durationMin: 91 })), 'duration_above_policy');
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxDurationMin: 600 }));
  assert.ok(e.createRequest(spec({ durationMin: 600 })));
});

test('field chain (depth): one level, two levels and three levels need that many approvals', () => {
  for (const n of [1, 2, 3]) {
    const e = newEngine();
    const chain = [{ role: 'manager', required: 1 }, { role: 'resource-owner', required: 1 }, { role: 'security', required: 1 }].slice(0, n);
    e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { chain }));
    const r = e.createRequest(spec());
    const who = [C.castManager, C.castOwner, C.castSecLead];
    for (let i = 0; i < n; i++) { assert.equal(e.snapshot().requests[0].status, 'pending', `still pending before level ${i + 1}`); e.decide(dec(r.id, who[i])); }
    assert.equal(e.snapshot().requests[0].status, 'granted', `${n} level(s)`);
  }
});

test('field chain (role): the role decides who the request is routed to', () => {
  const e = newEngine();
  for (const [role, expect] of [['manager', [C.castManager]], ['resource-owner', [C.castOwner]], ['security', [C.castSecLead, C.castSecLead2]], ['data-owner', [C.castDataOwner]]]) {
    e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { chain: [{ role, required: 1 }] }));
    assert.deepEqual(e.createRequest(spec()).approval.Approvers, expect, role);
  }
});

test('field chain (required): the number of approvals needed at a level', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { chain: [{ role: 'security', required: 2 }] }));
  const r = e.createRequest(spec());
  assert.equal(r.approval.RequiredApprovals, 2);
  e.decide(dec(r.id, C.castSecLead)); assert.equal(e.snapshot().requests[0].status, 'pending');
  e.decide(dec(r.id, C.castSecLead2)); assert.equal(e.snapshot().requests[0].status, 'granted');
});

test('field requireDistinctApprovers: on, one person cannot approve two levels; off, they can', () => {
  const chain = [{ role: 'security', required: 1 }, { role: 'security', required: 1 }];
  const run = (flag) => { const e = newEngine(); e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { chain, requireDistinctApprovers: flag })); const r = e.createRequest(spec()); e.decide(dec(r.id, C.castSecLead)); try { e.decide(dec(r.id, C.castSecLead)); return 'granted-by-one'; } catch (x) { return x.code; } };
  assert.equal(run(true), 'distinct_approver_required');
  assert.equal(run(false), 'granted-by-one');
});

test('field requestTtlMin: the approval window is exactly the value on the lab clock', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { requestTtlMin: 10 }));
  const r = e.createRequest(spec());
  assert.equal(r.approval.ExpiresAt, '2026-11-02T09:10:00.000Z');
  e.advance({ minutes: 9 }); assert.equal(e.snapshot().requests[0].status, 'pending');
  e.advance({ minutes: 1 }); assert.equal(e.snapshot().requests[0].status, 'expired');
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { requestTtlMin: 2880 }));
  assert.equal(e.createRequest(spec()).approval.ExpiresAt, '2026-11-04T09:10:00.000Z');
});

test('field channel: the approval message goes to Slack or Mattermost and only that channel can approve', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { channel: 'mattermost' }));
  const r = e.createRequest(spec());
  const chat = e.snapshot().outbox.filter((m) => m.kind === 'approval_request');
  assert.deepEqual([...new Set(chat.map((m) => m.channel))], ['mattermost']);
  assert.throws(() => e.decide(dec(r.id, C.castManager, { via: 'slack' })), (x) => x.code === 'no_chat_action');
  e.decide(dec(r.id, C.castManager, { via: 'mattermost' }));
  assert.equal(e.snapshot().requests[0].currentLevel, 1);
});

test('field autoApprove.enabled: off, a request that fits needs approval; on, it does not', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-read', edit(e, 'pol-code-read', { autoApprove: { enabled: false, maxLevel: 'read', maxDurationMin: 120 } }));
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30 })).status, 'pending');
  e.updatePolicy('pol-code-read', edit(e, 'pol-code-read', { autoApprove: { enabled: true, maxLevel: 'read', maxDurationMin: 120 } }));
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30 })).status, 'granted');
});

test('field autoApprove.maxLevel: a level above the rule needs approval, at the rule it does not', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { autoApprove: { enabled: true, maxLevel: 'triage', maxDurationMin: 60 } }));
  assert.equal(e.createRequest(spec({ level: 'triage', durationMin: 60 })).status, 'granted');
  assert.equal(e.createRequest(spec({ level: 'write', durationMin: 60 })).status, 'pending');
});

test('field autoApprove.maxDurationMin: a longer window needs approval, at the rule it does not', () => {
  const e = newEngine();
  e.updatePolicy('pol-code-read', edit(e, 'pol-code-read', { autoApprove: { enabled: true, maxLevel: 'read', maxDurationMin: 45 } }));
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 45 })).status, 'granted');
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 46 })).status, 'pending');
  e.updatePolicy('pol-code-read', edit(e, 'pol-code-read', { autoApprove: { enabled: true, maxLevel: 'read', maxDurationMin: 0 } }));
  assert.equal(e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 1 })).status, 'pending', '0 turns automatic approval off for every window');
});

test('self-approval is not a policy field: no edit can switch it off', () => {
  const e = newEngine();
  assert.ok(!EDITABLE_FIELDS.some((f) => /self/i.test(f)));
  refused(() => e.updatePolicy('pol-incident', { ...edit(e, 'pol-incident'), allowSelfApproval: true }), 'bad_policy');
  const r = e.createRequest(spec({ requestedBy: C.castSecLead, subjectId: C.castSecLead, policyId: 'pol-incident' }));
  assert.throws(() => e.decide(dec(r.id, C.castSecLead)), (x) => x.code === 'self_approval_refused');
});

test('an edited policy changes NEW requests only: a request already waiting keeps the chain it was created with', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { chain: [{ role: 'security', required: 1 }] }));
  assert.equal(e.snapshot().requests[0].chain.length, 2);
  e.decide(dec(r.id, C.castManager)); e.decide(dec(r.id, C.castOwner));
  assert.equal(e.snapshot().requests[0].status, 'granted');
  assert.equal(e.createRequest(spec()).chain.length, 1);
});

test('validateEdit refuses every wrong shape and never clamps', () => {
  const p = defaultPolicies().find((x) => x.id === 'pol-code-write');
  const good = { maxLevel: 'write', maxDurationMin: 60, chain: [{ role: 'manager', required: 1 }], requireDistinctApprovers: true, requestTtlMin: 60, channel: 'slack', autoApprove: { enabled: false, maxLevel: 'read', maxDurationMin: 0 } };
  assert.equal(validateEdit(good, p).ok, true);
  const bad = [
    { maxLevel: 'root' }, { maxLevel: 3 }, { maxLevel: undefined }, { maxDurationMin: 0 }, { maxDurationMin: 10081 }, { maxDurationMin: 1.5 }, { maxDurationMin: '60' }, { maxDurationMin: NaN },
    { requestTtlMin: 4 }, { requestTtlMin: 2881 }, { requestTtlMin: '60' }, { channel: 'teams' }, { channel: undefined }, { requireDistinctApprovers: 'yes' }, { requireDistinctApprovers: 1 },
    { chain: [] }, { chain: [1, 2, 3, 4].map(() => ({ role: 'manager', required: 1 })) }, { chain: 'x' }, { chain: [{ role: 'boss', required: 1 }] }, { chain: [{ role: 'manager', required: 3 }] }, { chain: [{ role: 'manager', required: 0 }] },
    { chain: [{ role: 'manager', required: '1' }] }, { chain: [{ role: 'manager', required: 1, extra: true }] }, { chain: [null] },
    { autoApprove: null }, { autoApprove: { enabled: 'yes', maxLevel: 'read', maxDurationMin: 0 } }, { autoApprove: { enabled: true, maxLevel: 'root', maxDurationMin: 0 } }, { autoApprove: { enabled: true, maxLevel: 'read', maxDurationMin: -1 } },
    { autoApprove: { enabled: true, maxLevel: 'read', maxDurationMin: 0, extra: 1 } }, { extra: 1 }, { __proto__x: 1 },
  ];
  for (const b of bad) assert.equal(validateEdit({ ...good, ...b }, p).ok, false, JSON.stringify(b));
  for (const x of [null, undefined, 'x', 5, []]) assert.equal(validateEdit(x, p).ok, false);
  assert.equal(validateEdit({ ...good, maxLevel: 'admin' }, p).ok, true, 'the level scale of the resource decides');
  // an unknown key's name is not echoed back
  const r = validateEdit({ ...good, 'ghp_abcdefghijklmnopqrstuvwxyz0123': 1 }, p);
  assert.ok(!JSON.stringify(r).includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
});

test('a refused edit changes nothing; a retired policy cannot be edited; unknown ids are refused', () => {
  const e = newEngine();
  const before = JSON.stringify(e.policy('pol-incident'));
  refused(() => e.updatePolicy('pol-incident', { ...edit(e, 'pol-incident'), maxDurationMin: 0 }), 'bad_policy');
  assert.equal(JSON.stringify(e.policy('pol-incident')), before);
  refused(() => e.updatePolicy('nope', edit(e, 'pol-incident')), 'not_found');
  refused(() => e.updatePolicy('__proto__', edit(e, 'pol-incident')), 'not_found');
  refused(() => e.updatePolicy(5, edit(e, 'pol-incident')), 'not_found');
  e.retirePolicy('pol-incident');
  refused(() => e.updatePolicy('pol-incident', edit(e, 'pol-incident')), 'policy_retired');
  refused(() => e.retirePolicy('pol-incident'), 'policy_retired');
  refused(() => e.retirePolicy('constructor'), 'not_found');
});

test('retiring a policy cancels the requests still waiting under it', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  const out = e.retirePolicy('pol-code-write');
  assert.deepEqual(out.cancelled, [r.id]);
  assert.equal(e.snapshot().requests[0].status, 'cancelled');
  assert.throws(() => e.decide(dec(r.id, C.castManager)), (x) => x.code === 'already_decided');
});

// --- integrations (Hitl) -----------------------------------------------------------------------------------------------------------------------

test('integration Hitl: Slack off sends no approval message; Jira and ServiceNow Hitl decide whether a ticket is opened; Teams enabled decides notices', () => {
  const e = newEngine();
  e.updateIntegrations({ slack: { Hitl: false }, jira: { Hitl: false }, servicenow: { Hitl: false }, msteams: { enabled: false } });
  e.createRequest(spec());
  assert.equal(e.snapshot().outbox.length, 0);
  assert.equal(e.snapshot().requests[0].approval.JiraTicketID, null);
  e.updateIntegrations({ jira: { Hitl: true } });
  e.createRequest(spec());
  assert.deepEqual(e.snapshot().outbox.map((m) => m.channel), ['jira']);
  assert.match(e.snapshot().requests[0].approval.JiraTicketID, /^ACCESS-\d+$/);
  e.updateIntegrations({ servicenow: { Hitl: true }, msteams: { enabled: true }, slack: { Hitl: true } });
  e.createRequest(spec());
  assert.deepEqual([...new Set(e.snapshot().outbox.filter((m) => m.requestId === 'req-0003').map((m) => m.channel))].sort(), ['jira', 'msteams', 'servicenow', 'slack']);
  assert.match(e.snapshot().requests[0].approval.ServiceNowTableRecordId, /^TASK\d{5}$/);
});

test('integrations are strict: only known booleans on known integrations', () => {
  const e = newEngine();
  for (const x of [null, undefined, 'x', 5, [], { slack: 5 }, { slack: [] }, { nope: { Hitl: true } }, { slack: { Hitl: 'yes' } }, { slack: { WorkspaceID: 'x' } }, { msteams: { Hitl: true } }, { jira: { project: 'X' } }, { __proto__x: {} }]) refused(() => e.updateIntegrations(x), 'bad_integrations');
  assert.equal(e.snapshot().integrations.slack.Hitl, true, 'a refused update changes nothing');
});

test('approval messages carry the swagger-named ApproverNotifications, per approver and per level', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  assert.deepEqual(e.snapshot().requests[0].approval.ApproverNotifications.map((n) => Object.keys(n)), [['ApproverUserID', 'IntegrationType', 'ChannelID', 'MessageID', 'WorkspaceID']]);
  e.decide(dec(r.id, C.castManager));
  const n = e.snapshot().requests[0].approval.ApproverNotifications;
  assert.deepEqual(n.map((x) => x.ApproverUserID), [C.castManager, C.castOwner]);
  assert.equal(n[0].IntegrationType, 'slack'); assert.equal(n[0].WorkspaceID, 'T-LAB');
  assert.equal(e.snapshot().requests[0].approval.NotifiedLevel, 2);
});

test('RetiredAt: the first terminal delivery sends the outcome once; a redelivered terminal event changes nothing', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  assert.equal(e.snapshot().requests[0].approval.RetiredAt, null);
  e.decide(dec(r.id, C.castSecLead));
  const at = e.snapshot().requests[0].approval.RetiredAt;
  assert.ok(at);
  const count = e.snapshot().outbox.length;
  assert.equal(e.redeliverTerminal(r.id), false);
  assert.equal(e.redeliverTerminal(r.id), false);
  assert.equal(e.snapshot().outbox.length, count, 'no duplicate outcome mail, Jira comment or ServiceNow close');
  assert.equal(e.snapshot().requests[0].approval.RetiredAt, at);
  const outcomes = e.snapshot().outbox.filter((m) => /outcome|ticket-update/.test(m.kind)).map((m) => m.channel).sort();
  assert.deepEqual(outcomes, ['jira', 'msteams', 'servicenow', 'slack']);
  assert.equal(e.redeliverTerminal('req-0099'), false);
});

test('notify-only channels get no actions; chat gets Approve and Deny', () => {
  const e = newEngine(); e.createRequest(spec());
  for (const m of e.snapshot().outbox) {
    if (['msteams', 'jira', 'servicenow'].includes(m.channel)) assert.deepEqual(m.actions, [], m.channel);
    else assert.deepEqual(m.actions, ['approve', 'deny']);
  }
});
