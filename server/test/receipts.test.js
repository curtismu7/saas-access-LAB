import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, grantWrite, spec } from './helpers.js';

test('every grant has a receipt, chained to the one before it; its removal gets another', () => {
  const e = newEngine();
  grantWrite(e);
  e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30 }));
  const items = e.snapshot().receipts.items;
  assert.deepEqual(items.map((r) => [r.id, r.kind, r.grantId]), [['r-0001', 'grant', 'g-0001'], ['r-0002', 'grant', 'g-0002']]);
  assert.equal(items[0].prevHash, '0'.repeat(64));
  assert.equal(items[1].prevHash, items[0].hash);
  e.advance({ minutes: 61 });
  const all = e.snapshot().receipts.items;
  assert.equal(all.length, 4);
  assert.equal(all.filter((r) => r.kind === 'removal').length, 2);
  assert.deepEqual(e.verifyReceipts(), { ok: true, count: 4, head: all[3].hash });
  assert.ok(e.snapshot().grants.every((g) => g.receiptId && g.removalReceiptId));
});

test('a receipt records the reference count at the time, the approvers and the expiry', () => {
  const e = newEngine();
  grantWrite(e, { durationMin: 480 });
  const r = e.createRequest(spec({ policyId: 'pol-incident', durationMin: 60 }));
  e.decide({ requestId: r.id, approver: C.castSecLead2, decision: 'approve' });
  const body = e.s.receipts[1].body;
  assert.equal(body.refCount, 2);
  assert.deepEqual(body.approvedBy, [C.castSecLead2]);
  assert.equal(body.expiresAt, '2026-11-02T10:00:00.000Z');
  assert.equal(e.s.receipts[0].body.refCount, 1);
});

test('tampering with any receipt (its body, its order, a deletion) is detected, computed from the receipts themselves', () => {
  const make = () => { const e = newEngine(); grantWrite(e); e.advance({ minutes: 61 }); return e; };
  let e = make(); assert.equal(e.verifyReceipts().ok, true);
  e = make(); e.s.receipts[0].body.level = 'admin'; assert.deepEqual(e.verifyReceipts(), { ok: false, at: 'r-0001' });
  e = make(); e.s.receipts[1].body.removalReason = 'revoked'; assert.deepEqual(e.verifyReceipts(), { ok: false, at: 'r-0002' });
  e = make(); e.s.receipts.reverse(); assert.equal(e.verifyReceipts().ok, false);
  e = make(); e.s.receipts.shift(); assert.equal(e.verifyReceipts().ok, false);
  e = make(); e.s.receipts[1].hash = 'f'.repeat(64); assert.equal(e.verifyReceipts().ok, false);
});

test('the same calls give the same receipts: the engine is deterministic (the Mock tables depend on it)', () => {
  const run = () => { const e = newEngine(); grantWrite(e); e.advance({ minutes: 90 }); return e.snapshot(); };
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

test('every removal is an event in the one audit trail, for humans and agents alike', () => {
  const e = newEngine();
  e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30 }));
  e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 30, subjectKind: 'agent', subjectId: C.castAgent, requestedBy: C.castAgent }));
  e.advance({ minutes: 31 });
  const reaped = e.snapshot().audit.filter((a) => a.kind === 'grant.reaped');
  assert.deepEqual(reaped.map((a) => a.subject.kind).sort(), ['agent', 'human']);
  assert.deepEqual(Object.keys(reaped[0]).sort(), Object.keys(reaped[1]).sort(), 'the same shape');
});

test('the audit trail is bounded', () => {
  const e = newEngine();
  for (let i = 0; i < 600; i++) e.audit('test.event', 'x', { i });
  assert.equal(e.snapshot().audit.length, e.snapshot().limits.audit);
  assert.equal(e.snapshot().audit[0].i, 599, 'newest first');
});

test('audit data can never overwrite the entry\'s own kind, actor, time or number', () => {
  const e = newEngine();
  const a = e.audit('real.kind', 'real-actor', { kind: 'forged', actor: 'forged', at: 'forged', n: 999 });
  assert.equal(a.kind, 'real.kind'); assert.equal(a.actor, 'real-actor'); assert.notEqual(a.at, 'forged'); assert.notEqual(a.n, 999);
});
