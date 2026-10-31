import test from 'node:test';
import assert from 'node:assert/strict';
import { C, newEngine, spec, dec, grantWrite } from './helpers.js';
import { InputError } from '../src/errors.js';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof InputError && e.code === code, code);
const hand = (e, o = {}) => e.outOfBand({ op: 'grant', platform: 'github', resource: 'gh-repo-infra', subjectKind: 'human', subjectId: C.castEngineer2, level: 'write', ...o });
const kinds = (e) => e.snapshot().diff.map((d) => d.kind);
const members = (e, platform, resource) => e.snapshot().platforms.find((p) => p.id === platform).groups.find((g) => g.resource === resource).members;

test('with nothing granted and nothing changed by hand there is no drift', () => {
  const e = newEngine();
  assert.deepEqual(kinds(e), []);
  const run = e.reconcile('manual');
  assert.equal(run.findings, 0);
});

test('a grant that matches its receipt is not drift', () => {
  const e = newEngine(); grantWrite(e);
  assert.deepEqual(kinds(e), ['match']);
  assert.equal(e.reconcile('manual').findings, 0);
});

test('access granted by hand on the platform is flagged as unrecorded, with who, where and how much', () => {
  const e = newEngine(); hand(e);
  assert.deepEqual(kinds(e), ['unrecorded']);
  const run = e.reconcile('manual');
  assert.equal(run.findings, 1); assert.equal(run.newFindings, 1);
  const f = e.snapshot().drift.open[0];
  assert.deepEqual([f.kind, f.platform, f.resource, f.subject.id, f.onPlatform, f.expected], ['unrecorded', 'github', 'gh-repo-infra', C.castEngineer2, 'write', null]);
  assert.equal(members(e, 'github', 'gh-repo-infra')[0].origin, 'out-of-band');
  assert.ok(e.snapshot().audit.some((a) => a.kind === 'drift.found'));
  assert.ok(e.snapshot().platforms[0].log.some((l) => /not Privilege/.test(l.actor)), 'the platform\'s own log says it was changed by hand');
});

test('more access than the receipts justify is elevated; a missing platform entry is missing', () => {
  const e = newEngine(); grantWrite(e);
  hand(e, { resource: 'gh-repo-core', subjectId: C.castEngineer, level: 'admin' });
  assert.deepEqual(kinds(e), ['elevated']);
  e.outOfBand({ op: 'remove', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer });
  assert.deepEqual(kinds(e), ['missing']);
  assert.equal(e.reconcile('manual').findings, 1);
  assert.equal(e.snapshot().drift.open[0].kind, 'missing');
});

test('hand changes are checked: kind, platform, resource, subject, level, and no change that changes nothing', () => {
  const e = newEngine();
  for (const [patch, code] of [[{ op: 'steal' }, 'bad_op'], [{ platform: 'jira' }, 'bad_platform'], [{ resource: 'nope' }, 'bad_resource'], [{ resource: 'snow-role-writer' }, 'bad_resource'], [{ subjectId: 'ghost' }, 'bad_subject'],
    [{ subjectKind: 'agent' }, 'bad_subject'], [{ level: 'root' }, 'bad_level'], [{ level: undefined }, 'bad_level']]) refused(() => hand(e, patch), code);
  refused(() => e.outOfBand({ op: 'remove', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer }), 'nothing_there');
  hand(e);
  refused(() => hand(e, { level: 'read' }), 'nothing_to_change');
  refused(() => hand(e, { level: 'write' }), 'nothing_to_change');
  for (const x of [null, undefined, 'x', 5]) refused(() => e.outOfBand(x), 'bad_op');
  assert.equal(e.snapshot().platforms[0].groups.flatMap((g) => g.members).length, 1);
});

test('drift after reap: the reaper removes the grant, leaving no drift; access added by hand afterwards is drift', () => {
  const e = newEngine(); grantWrite(e);
  e.advance({ minutes: 61 });
  assert.deepEqual(kinds(e), [], 'clean after the reap');
  assert.equal(e.reconcile('manual').findings, 0);
  hand(e, { resource: 'gh-repo-core', subjectId: C.castEngineer, level: 'write' });
  assert.deepEqual(kinds(e), ['unrecorded']);
});

test('the reaper never removes hand-made access: it was never a grant, and it stays after the grant ends', () => {
  const e = newEngine();
  e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60 }));
  hand(e, { resource: 'gh-repo-core', subjectId: C.castEngineer, level: 'admin' });
  assert.deepEqual(kinds(e), ['elevated']);
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'admin');
  e.advance({ minutes: 61 });
  const m = members(e, 'github', 'gh-repo-core');
  assert.equal(m.length, 1, 'the hand-made access is still there');
  assert.deepEqual([m[0].level, m[0].origin], ['admin', 'out-of-band']);
  assert.deepEqual(kinds(e), ['unrecorded']);
});

test('a grant over existing hand-made access restores it, not removes it, when the grant ends', () => {
  const e = newEngine();
  hand(e, { resource: 'gh-repo-core', subjectId: C.castEngineer, level: 'triage' });
  e.createRequest(spec({ policyId: 'pol-code-read', level: 'read', durationMin: 60 }));
  const m = members(e, 'github', 'gh-repo-core')[0];
  assert.deepEqual([m.level, m.origin, m.prior], ['triage', 'privilege', 'triage'], 'the higher hand-made level is kept while the grant lives');
  e.advance({ minutes: 61 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core').map((x) => [x.level, x.origin]), [['triage', 'out-of-band']]);
});

test('the nightly reconcile runs by itself when the lab clock crosses 02:00, once per night, and finds hand-made access', () => {
  const e = newEngine(); hand(e);
  e.advance({ minutes: 60 }); // 10:00: no night passed
  assert.equal(e.snapshot().drift.runs.length, 0);
  const r = e.advance({ minutes: 1440 }); // to 10:00 next day: crossed 02:00 once
  assert.equal(r.nightly, 1);
  assert.deepEqual(e.snapshot().drift.runs.map((x) => x.trigger), ['nightly']);
  assert.equal(e.snapshot().drift.open.length, 1);
  const r2 = e.advance({ minutes: 3 * 1440 });
  assert.equal(r2.nightly, 3, 'one run per night, not one per move');
  assert.equal(e.snapshot().drift.open[0].firstSeenAt < e.snapshot().drift.open[0].lastSeenAt, true, 'the same finding is kept, not duplicated');
  assert.equal(e.snapshot().audit.filter((a) => a.kind === 'drift.found').length, 1);
});

test('a move that lands exactly on 02:00 runs the nightly reconcile; one that ends a minute before does not', () => {
  const e = newEngine();
  e.advance({ to: '2026-11-03T01:59:00Z' }); assert.equal(e.snapshot().drift.runs.length, 0);
  e.advance({ minutes: 1 }); assert.equal(e.snapshot().drift.runs.length, 1);
});

test('remediation revokes unrecorded access on the platform and reconciles again; a missing finding has nothing to revoke', () => {
  const e = newEngine(); hand(e); e.reconcile('manual');
  const id = e.snapshot().drift.open[0].id;
  refused(() => e.remediate({ findingId: 'd-9999' }), 'not_found');
  refused(() => e.remediate({ findingId: 5 }), 'not_found');
  e.remediate({ findingId: id });
  assert.deepEqual(members(e, 'github', 'gh-repo-infra'), []);
  assert.deepEqual(e.snapshot().drift.open, []);
  assert.ok(e.snapshot().audit.some((a) => a.kind === 'drift.remediated'));
  assert.ok(e.snapshot().audit.some((a) => a.kind === 'drift.cleared'));
  // missing
  grantWrite(e); e.outOfBand({ op: 'remove', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: C.castEngineer }); e.reconcile('manual');
  refused(() => e.remediate({ findingId: e.snapshot().drift.open[0].id }), 'nothing_to_revoke');
});

test('remediating an elevated finding lowers the platform to what the receipts justify', () => {
  const e = newEngine(); grantWrite(e);
  hand(e, { resource: 'gh-repo-core', subjectId: C.castEngineer, level: 'admin' }); e.reconcile('manual');
  e.remediate({ findingId: e.snapshot().drift.open[0].id });
  assert.equal(members(e, 'github', 'gh-repo-core')[0].level, 'write');
  assert.deepEqual(kinds(e), ['match']);
  e.advance({ minutes: 61 });
  assert.deepEqual(members(e, 'github', 'gh-repo-core'), [], 'the receipt-backed access then ends normally');
});

test('Sync off for a platform: the reconcile no longer reads it (a lab reading of the swagger Sync field); other platforms are unaffected', () => {
  const e = newEngine();
  e.outOfBand({ op: 'grant', platform: 'snowflake', resource: 'snow-role-writer', subjectKind: 'human', subjectId: C.castEngineer, level: 'member' });
  hand(e);
  assert.equal(e.diff().filter((d) => d.kind !== 'match').length, 2);
  e.setSync({ platform: 'snowflake', sync: false });
  assert.deepEqual(e.diff().map((d) => d.platform), ['github']);
  assert.equal(e.reconcile('manual').findings, 1);
  e.setSync({ platform: 'snowflake', sync: true });
  assert.equal(e.reconcile('manual').findings, 2);
  refused(() => e.setSync({ platform: 'github', sync: false }), 'bad_platform');
  refused(() => e.setSync({ platform: 'snowflake', sync: 'no' }), 'bad_sync');
  refused(() => e.setSync(null), 'bad_platform');
  assert.deepEqual(Object.keys(e.snapshot().sync).sort(), ['databricks', 'salesforce', 'snowflake']);
});

test('the reaper still removes access on a platform whose Sync is off (Sync is about reading for the reconcile)', () => {
  const e = newEngine(); e.setSync({ platform: 'snowflake', sync: false });
  const r = e.createRequest(spec({ platform: 'snowflake', resource: 'snow-role-writer', level: 'member', policyId: 'pol-warehouse', durationMin: 30 }));
  e.decide(dec(r.id, C.castDataOwner)); e.decide(dec(r.id, C.castSecLead));
  e.advance({ minutes: 31 });
  assert.deepEqual(members(e, 'snowflake', 'snow-role-writer'), []);
});

test('the findings list is bounded', () => {
  const e = newEngine();
  for (let i = 0; i < 3; i++) hand(e, { resource: ['gh-repo-core', 'gh-repo-infra', 'gh-team-releases'][i], level: i === 2 ? 'member' : 'read' });
  assert.ok(e.reconcile('manual').findings <= e.snapshot().limits.findings);
});
