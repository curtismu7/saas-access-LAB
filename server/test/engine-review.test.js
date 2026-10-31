// Tests added after an independent review: chat actions that survive the outbox rolling over, a chain that cannot be completed, policy edits
// against a waiting request, hand-made access over a live grant, receipts that cannot be truncated, and impossible calendar dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { C, newEngine, spec, dec, grantWrite } from './helpers.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);
const edit = (e, id, patch = {}) => { const p = e.policy(id); return { maxLevel: p.maxLevel, maxDurationMin: p.maxDurationMin, chain: p.chain.map((c) => ({ ...c })), requireDistinctApprovers: p.requireDistinctApprovers, requestTtlMin: p.requestTtlMin, channel: p.channel, autoApprove: { ...p.autoApprove }, ...patch }; };
const members = (e, platform, resource) => e.snapshot().platforms.find((p) => p.id === platform).groups.find((g) => g.resource === resource).members;
const hand = (e, o = {}) => e.outOfBand({ op: 'grant', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer, level: 'read', ...o });

// ---- S3: chat approval and the outbox --------------------------------------------------------------------------------------------------------

test('S3: the outbox is capped, and a chat approval still works after the outbox has rolled over (the action is kept on the request)', () => {
  const e = newEngine();
  const first = e.createRequest(spec({ policyId: 'pol-incident' }));
  for (let i = 0; i < 90; i++) e.createRequest(spec({ policyId: 'pol-incident' }));
  assert.equal(e.snapshot().outbox.length, e.snapshot().limits.outbox, 'the outbox is bounded at its cap');
  assert.ok(!e.snapshot().outbox.some((m) => m.requestId === first.id), 'the first request\'s messages have rolled out of the outbox');
  e.decide(dec(first.id, C.castSecLead, { via: 'slack' }));
  assert.equal(e.snapshot().requests.find((r) => r.id === first.id).status, 'granted');
});

test('S3: a channel edit after creation does not take a waiting request\'s chat approval away (the channel is frozen on the request)', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { channel: 'mattermost' }));
  refused(() => e.decide(dec(r.id, C.castSecLead, { via: 'mattermost' })), 'no_chat_action');
  e.decide(dec(r.id, C.castSecLead, { via: 'slack' }));
  assert.equal(e.snapshot().requests[0].status, 'granted');
  assert.deepEqual([...new Set(e.snapshot().outbox.filter((m) => m.requestId === r.id).map((m) => m.channel))].filter((c) => ['slack', 'mattermost'].includes(c)), ['slack']);
  assert.equal(e.snapshot().requests[0].channel, 'slack');
});

test('S3: a chat message for LEVEL 1 does not let an approver act from chat at level 2 when no level 2 message was sent', () => {
  const e = newEngine();
  const chain = [{ role: 'security', required: 1 }, { role: 'security', required: 1 }];
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { chain, requireDistinctApprovers: false }));
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  e.decide(dec(r.id, C.castSecLead, { via: 'slack' }));                // level 1, from chat
  assert.equal(e.snapshot().requests[0].currentLevel, 1);
  const live = e.s.requests[0]; live.chatActions = live.chatActions.filter((c) => c.level !== 1); // white-box: no level 2 message went out
  refused(() => e.decide(dec(r.id, C.castSecLead, { via: 'slack' })), 'no_chat_action');
  e.decide(dec(r.id, C.castSecLead));                                    // the console still works
  assert.equal(e.snapshot().requests[0].status, 'granted');
});

test('S3: the chat action belongs to the approver it was sent to (an approver who was routed but not messaged cannot act from chat)', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ policyId: 'pol-incident' }));
  const live = e.s.requests.find((x) => x.id === r.id);
  live.chatActions = live.chatActions.filter((c) => c.to !== C.castSecLead2); // white-box: only lee.park was messaged
  refused(() => e.decide(dec(r.id, C.castSecLead2, { via: 'slack' })), 'no_chat_action');
  e.decide(dec(r.id, C.castSecLead, { via: 'slack' }));
  assert.equal(e.snapshot().requests[0].status, 'granted');
  assert.deepEqual(e.s.requests[0].chatActions, [], 'a terminal request keeps no chat actions');
});

// ---- S4: a chain that can never be completed -------------------------------------------------------------------------------------------------

test('S4: with a different person at every level, a request whose levels share their only approver is refused up front, in the preview and on creation', () => {
  const e = newEngine();
  const asAgent = spec({ requestedBy: C.castAgent2, subjectKind: 'agent', subjectId: C.castAgent2, policyId: 'pol-code-write' });
  // ledger-reconciler's custodian is sam.jones, who is also the owner of the repository: the only candidate at level 1 and at level 2
  const pv = e.preview(asAgent);
  assert.equal(pv.ok, false); assert.equal(pv.error.code, 'no_eligible_approver'); assert.match(pv.error.detail, /level 2.*different person at every level/);
  refused(() => e.createRequest(asAgent), 'no_eligible_approver');
  assert.equal(e.snapshot().requests.length, 0);
  // with the flag off, one person may satisfy both levels, so it is allowed
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { requireDistinctApprovers: false }));
  assert.equal(e.preview(asAgent).ok, true);
  const r = e.createRequest(asAgent);
  e.decide(dec(r.id, C.castOwner)); e.decide(dec(r.id, C.castOwner));
  assert.equal(e.snapshot().requests[0].status, 'granted');
});

test('S4: the feasibility check is a real matching: three levels need three different people where they are the only candidates, and a spare candidate fixes it', () => {
  const e = newEngine();
  // security group has two people: level 1 and 2 can both be filled, a third security level cannot
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { chain: [{ role: 'security', required: 1 }, { role: 'security', required: 1 }, { role: 'security', required: 1 }], requireDistinctApprovers: true }));
  const bad = e.preview(spec({ policyId: 'pol-incident' }));
  assert.equal(bad.ok, false); assert.match(bad.error.detail, /level 3/);
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { chain: [{ role: 'security', required: 1 }, { role: 'security', required: 1 }], requireDistinctApprovers: true }));
  assert.equal(e.preview(spec({ policyId: 'pol-incident' })).ok, true);
  // two approvals at one level and one at the next: three people needed, two exist
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { chain: [{ role: 'security', required: 2 }, { role: 'security', required: 1 }], requireDistinctApprovers: true }));
  assert.equal(e.preview(spec({ policyId: 'pol-incident' })).ok, false);
  e.updatePolicy('pol-incident', edit(e, 'pol-incident', { chain: [{ role: 'security', required: 2 }, { role: 'security', required: 1 }], requireDistinctApprovers: false }));
  assert.equal(e.preview(spec({ policyId: 'pol-incident' })).ok, true);
  // an auto-approved request needs no approver at all
  assert.equal(e.preview(spec({ policyId: 'pol-code-read', level: 'read' })).ok, true);
});

// ---- S5: a policy edited while a request waits -----------------------------------------------------------------------------------------------

test('S5: the level and window are checked against the LIVE policy when the last level approves; a narrowed policy refuses that approval, and the request stays pending', () => {
  const e = newEngine();
  const r = e.createRequest(spec({ durationMin: 480 }));
  e.decide(dec(r.id, C.castManager));
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxLevel: 'read', maxDurationMin: 5 }));
  assert.equal(e.snapshot().requests[0].chain.length, 2, 'the chain was frozen at creation');
  refused(() => e.decide(dec(r.id, C.castOwner)), 'policy_no_longer_allows');
  assert.equal(e.snapshot().requests[0].status, 'pending'); assert.equal(e.snapshot().grants.length, 0);
  assert.equal(e.snapshot().requests[0].approval.ApprovedBy.length, 1, 'the refused approval was not recorded');
  // widening the policy again lets it complete
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { maxLevel: 'write', maxDurationMin: 480 }));
  e.decide(dec(r.id, C.castOwner));
  assert.equal(e.snapshot().requests[0].status, 'granted'); assert.equal(e.snapshot().grants[0].level, 'write');
});

test('S5: the live check covers the level and the window separately, and the first level of a longer chain is not blocked by it', () => {
  const run = (patch) => { const e = newEngine(); const r = e.createRequest(spec({ durationMin: 400 })); e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', patch)); e.decide(dec(r.id, C.castManager)); try { e.decide(dec(r.id, C.castOwner)); return 'granted'; } catch (x) { return x.code; } };
  assert.equal(run({ maxLevel: 'triage' }), 'policy_no_longer_allows');
  assert.equal(run({ maxDurationMin: 399 }), 'policy_no_longer_allows');
  assert.equal(run({ maxDurationMin: 400 }), 'granted');
  assert.equal(run({ requestTtlMin: 600 }), 'granted', 'an edit that does not narrow anything does not block');
});

test('S5: a request whose policy was retired is cancelled, so it cannot be approved at all', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  e.retirePolicy('pol-code-write');
  refused(() => e.decide(dec(r.id, C.castManager)), 'already_decided');
});

test('S5: the chat channel follows the request, not the live policy (notifications for later levels and the outcome go to the frozen channel)', () => {
  const e = newEngine();
  const r = e.createRequest(spec());
  e.updatePolicy('pol-code-write', edit(e, 'pol-code-write', { channel: 'mattermost' }));
  e.decide(dec(r.id, C.castManager, { via: 'slack' }));
  e.decide(dec(r.id, C.castOwner, { via: 'slack' }));
  const chats = e.snapshot().outbox.filter((m) => m.requestId === r.id && ['slack', 'mattermost'].includes(m.channel));
  assert.ok(chats.length >= 3 && chats.every((m) => m.channel === 'slack'));
});

// ---- S6: hand-made access over a live grant --------------------------------------------------------------------------------------------------

test('S6: access removed by hand and re-added at a LOWER level is drift (reduced), and the reaper never removes the hand-made entry', () => {
  const e = newEngine(); grantWrite(e, { durationMin: 30 });
  e.outOfBand({ op: 'remove', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer });
  hand(e, { level: 'read' });
  assert.deepEqual(e.diff().map((d) => [d.kind, d.onPlatform, d.expected, d.origin]), [['reduced', 'read', 'write', 'out-of-band']], 'not a match');
  assert.equal(e.reconcile('manual').findings, 1);
  assert.equal(e.snapshot().drift.open[0].kind, 'reduced');
  refused(() => e.remediate({ findingId: e.snapshot().drift.open[0].id }), 'nothing_to_revoke');
  e.advance({ minutes: 31 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core').map((m) => [m.id, m.level, m.origin]), [[C.castEngineer, 'read', 'out-of-band']], 'the hand-made entry survives the reaper');
  assert.deepEqual(e.diff().map((d) => d.kind), ['unrecorded'], 'and is now plain drift');
});

test('S6: a hand-made entry at the SAME level as the grant is not flagged while the grant lives, and still survives when it ends', () => {
  const e = newEngine(); grantWrite(e, { durationMin: 30 });
  e.outOfBand({ op: 'remove', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer });
  hand(e, { level: 'write' });
  assert.deepEqual(e.diff().map((d) => d.kind), ['match']);
  e.advance({ minutes: 31 });
  assert.equal(members(e, 'github', 'gh-repo-core').length, 1);
});

test('S6: a lab grant that arrives over a lower hand-made entry restores that floor when it ends', () => {
  const e = newEngine();
  hand(e, { level: 'read' });
  const r = e.createRequest(spec({ policyId: 'pol-incident', durationMin: 30 })); e.decide(dec(r.id, C.castSecLead));
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'write');
  e.advance({ minutes: 31 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core').map((m) => [m.level, m.origin]), [['read', 'out-of-band']]);
});

// ---- S9: receipts -----------------------------------------------------------------------------------------------------------------------------

const sha = (s) => createHash('sha256').update(s).digest('hex');
const made = () => { const e = newEngine(); for (let i = 0; i < 4; i++) e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30 + i })); e.advance({ minutes: 200 }); return e; };

test('S9: editing any field of a receipt (its id, kind, time or grant, not only its body) is detected', () => {
  for (const [name, f] of [['id', (r) => { r.id = 'r-9999'; }], ['kind', (r) => { r.kind = 'removal'; }], ['at', (r) => { r.at = '2000-01-01T00:00:00.000Z'; }], ['grantId', (r) => { r.grantId = 'g-9'; }], ['body', (r) => { r.body.level = 'admin'; }]]) {
    const e = made(); assert.equal(e.verifyReceipts().ok, true);
    f(e.s.receipts[1]);
    assert.equal(e.verifyReceipts().ok, false, name);
  }
});

test('S9: dropping the newest receipts is detected against the count and head held beside them; so is adding one', () => {
  for (const n of [1, 3]) { const e = made(); const had = e.s.receipts.length; e.s.receipts.length -= n; const v = e.verifyReceipts(); assert.equal(v.ok, false); assert.equal(v.at, 'commitment'); assert.ok(had > n); }
  const e = made(); const before = e.snapshot().receipts.commitment;
  assert.equal(before.count, e.s.receipts.length); assert.equal(before.head, e.s.receipts.at(-1).hash);
  e.s.receipts.push({ ...e.s.receipts.at(-1), id: 'r-0099' });
  assert.equal(e.verifyReceipts().ok, false);
});

test('S9: the limit is stated honestly: a rewrite of BOTH the receipts and the commitment verifies (no key, no external anchor)', () => {
  const e = made();
  const rs = e.s.receipts; rs[1].body.level = 'admin';
  let prev = '0'.repeat(64);
  for (const r of rs) { r.prevHash = prev; r.hash = sha(`${prev}|${JSON.stringify({ id: r.id, kind: r.kind, at: r.at, grantId: r.grantId, body: r.body })}`); prev = r.hash; }
  e.s.commit = { count: rs.length, head: prev };
  assert.equal(e.verifyReceipts().ok, true, 'a full recompute forges the chain: the README and the app say so');
  // ...but the head a visitor wrote down earlier no longer matches
  assert.notEqual(e.snapshot().receipts.commitment.head, made().snapshot().receipts.commitment.head);
});

test('S9: the commitment is shown in the state and starts empty', () => {
  const e = newEngine();
  assert.deepEqual(e.snapshot().receipts.commitment, { count: 0, head: '0'.repeat(64) });
  assert.equal(e.verifyReceipts().ok, true);
});

// ---- N1 ---------------------------------------------------------------------------------------------------------------------------------------

test('N1: an impossible calendar date is refused, a real one accepted (leap day included)', () => {
  for (const to of ['2026-02-31T00:00Z', '2026-04-31T10:00:00Z', '2026-13-01T00:00:00Z', '2026-11-31T00:00:00.000Z', '2027-02-29T00:00:00Z', '2026-11-05T24:30:00Z', '2026-11-05T10:61:00Z']) refused(() => newEngine().advance({ to }), 'bad_time');
  const e = newEngine();
  e.advance({ to: '2026-11-05T10:15:30Z' });
  assert.equal(e.snapshot().clock, '2026-11-05T10:15:30.000Z');
  assert.throws(() => newEngine().advance({ to: '2028-02-29T00:00:00Z' }), (x) => x.code === 'advance_too_far', 'a real leap day parses (and then fails only on the 7 day limit)');
});
