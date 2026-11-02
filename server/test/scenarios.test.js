import test from 'node:test';
import assert from 'node:assert/strict';
import { VERTICALS } from '../src/cast.js';
import { EXPECTED, SCENARIO_IDS, buildMockTable, runScenario, scenarioList } from '../src/scenarios.js';
import { MOCK_TABLE } from '../src/mockTable.js';
import { mockState } from '../src/service.js';
import { withServer, get, json, post } from './helpers.js';

test('every scripted step gives the result the story says it does, in every vertical', () => {
  for (const [v, cast] of Object.entries(VERTICALS)) {
    for (const sc of scenarioList(cast)) {
      const { steps } = runScenario(cast, sc);
      assert.deepEqual(steps.map((s) => (s.result.ok ? 'ok' : s.result.code)), EXPECTED[sc.id], `${v}/${sc.id}`);
    }
  }
  assert.equal(SCENARIO_IDS.length, 6);
});

test('Mock parity: the committed Mock table is exactly what the engine generates (a drift test)', () => {
  assert.deepEqual(MOCK_TABLE, buildMockTable());
});

test('Mock parity: a scenario replayed through the Live HTTP API ends in the same state as the Mock table says', async () => {
  const cast = VERTICALS.finance;
  const ops = { request: ['POST', () => '/api/requests', (p) => ({ request: p })], decide: ['POST', (p) => `/api/requests/${p.requestId}/decision`, (p) => ({ decision: (({ requestId, ...r }) => r)(p) })], advance: ['POST', () => '/api/clock', (p) => ({ clock: p })], reconcile: ['POST', () => '/api/drift/reconcile', () => ({})], outOfBand: ['POST', () => '/api/platforms/out-of-band', (p) => ({ change: p })] };
  await withServer(async (url) => {
    for (const sc of scenarioList(cast)) {
      const ws = `parity-${sc.id}`.slice(0, 30);
      let last;
      for (const st of sc.steps) { const [m, path, body] = ops[st.op]; last = await json(await post(url, path(st.params), { mode: 'live', vertical: 'finance', ...body(st.params) }, { 'x-workspace': ws })); }
      const live = (await json(await get(url, '/api/state?mode=live&vertical=finance', { 'x-workspace': ws }))).state;
      const mock = mockState(MOCK_TABLE, 'finance', sc.id).state;
      for (const k of ['clock', 'grants', 'requests', 'platforms', 'diff', 'drift', 'audit', 'outbox', 'holdings']) assert.deepEqual(live[k], mock[k], `${sc.id}: ${k}`);
      assert.ok(last);
    }
  });
});

test('Mock mode shows what the story says: self-approval refused with its reason, the overlap leaves one reference, drift leaves two findings', () => {
  const s = mockState(MOCK_TABLE, 'finance', 'self-approval');
  assert.equal(s.scenario.steps[1].result.code, 'self_approval_refused'); assert.match(s.scenario.steps[1].result.detail, /approver made this request/);
  const o = mockState(MOCK_TABLE, 'finance', 'overlap').state;
  assert.deepEqual(o.grants.map((g) => g.status), ['expired', 'active']); assert.equal(o.holdings[0].refCount, 1); assert.equal(o.holdings[0].onPlatform, 'write');
  const d = mockState(MOCK_TABLE, 'finance', 'drift').state;
  assert.deepEqual(d.drift.open.map((f) => f.kind), ['unrecorded', 'unrecorded']);
  const w = mockState(MOCK_TABLE, 'finance', 'warehouse-role').state;
  assert.equal(w.grants[0].status, 'expired'); assert.deepEqual(w.diff, []);
  const a = mockState(MOCK_TABLE, 'finance', 'agent-and-human').state;
  assert.deepEqual(a.grants.map((g) => g.subject.kind).sort(), ['agent', 'human']);
});

test('the Mock table carries no credential-shaped text and no real host', async () => {
  const { findCredentials } = await import('../src/credentials.js'); const { scanHosts } = await import('../src/safety.js');
  // every string and every key on its own (hashes and trace ids are long and legitimate: skipped)
  const found = []; const work = [[MOCK_TABLE, '']];
  while (work.length) {
    const [x, name] = work.pop();
    if (typeof x === 'string') { if (!/^(hash|prevHash|head)$/.test(name) && findCredentials(x).length) found.push(x.slice(0, 40)); }
    else if (Array.isArray(x)) for (const v of x) work.push([v, name]);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (findCredentials(k).length) found.push(k); work.push([v, k]); }
  }
  assert.deepEqual(found, []);
  assert.deepEqual(scanHosts(JSON.stringify(MOCK_TABLE)), []);
});
