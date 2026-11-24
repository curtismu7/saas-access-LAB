// Rule 27: this lab's run panel. The records are built from the lab's own decisions only (Mock: the stored scenario steps; Live: the answers
// the workspace's engine gave), each stdout line is one decision, and a failed writer never changes an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRunLog, decisionLine, decisionRows, stdoutValue, MAX_ROWS } from '../src/runObs.js';
import { assertRunObservability, classify, createMasker } from '../src/runObservability.js';
import { MOCK_TABLE } from '../src/mockTable.js';
import { installNetguard } from '../src/netguard.js';
import { VERTICALS } from '../src/cast.js';

const C = VERTICALS.finance;

installNetguard();
const MATCHER_WORDS = ['refused', 'denied', 'rejected', 'forbidden', 'failed', 'invalid', 'expired', 'mismatch', 'token', 'audience', 'scope', 'served'];
const PRODUCTS = ['pingfederate', 'pinggateway', 'privilege-gateway', 'privilege-siem', 'promptguard', 'mcp-server'];

// A server with a writer the test owns. `write` receives each line; the default keeps the lines.
async function withLab(fn, { write, runLog } = {}) {
  const lines = [];
  const log = runLog || createRunLog({ write: write || ((s) => lines.push(s)) });
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  await health.ready;
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, configFile: '/nonexistent/customer.config.json', runLog: log }) });
  const base = url.replace(/\/$/, '');
  const api = (ws = 'ws-a') => ({
    get: (p) => fetch(`${base}${p}`, { headers: { 'x-workspace': ws } }),
    post: (p, body, { method = 'POST' } = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-workspace': ws, origin: base }, body: JSON.stringify(body) }),
  });
  try { await fn({ api, lines, base }); } finally { health.stop(); await new Promise((r) => server.close(r)); }
}

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const req = (o = {}) => ({ requestedBy: C.castEngineer, subjectKind: 'human', subjectId: C.castEngineer, platform: 'github', resource: 'gh-repo-core', level: 'read', durationMin: 60, policyId: 'pol-code-read', reason: 'Review', ...o });
const lineFields = (line) => line.split(' ').filter((t) => t.includes('=')).map((t) => t.split('=')[0]);

test('Mock: every scenario gives a record of its stored steps, every row simulated, no row presented as logged or as a response', async () => {
  await withLab(async ({ api }) => {
    for (const sc of MOCK_TABLE.verticals.finance.scenarios) {
      const r = await (await api('mock-ws').get(`/api/run-observability?mode=mock&vertical=finance&scenario=${sc.id}`)).json();
      assert.equal(r.mode, 'mock');
      assert.equal(r.scenario, sc.id);
      if (r.record === null) continue;
      assert.equal(r.record.source, 'mock');
      assert.deepEqual(assertRunObservability(r.record), [], sc.id);
      for (const row of r.record.rows) assert.ok(row.origin === 'simulated' || row.origin === 'not-logged', `${sc.id} ${row.origin}`);
      for (const layer of ['person', 'agent', 'authorize', 'gateway']) assert.equal(r.record.coverage[layer], 'not-logged', `${sc.id} ${layer}`);
      assert.ok(Object.values(r.record.reasons).every((s) => s.length > 0));
    }
  });
});

test('Mock: the self-approval scenario shows the lab stopping self-approval (blocked), not a plain refusal, and the approval that counted', async () => {
  await withLab(async ({ api }) => {
    const r = await (await api().get('/api/run-observability?mode=mock&vertical=finance&scenario=self-approval')).json();
    const blocked = r.record.rows.filter((x) => x.outcome === 'blocked');
    assert.ok(blocked.length >= 2, 'self-approval and the agent approver are the lab stops');
    assert.ok(r.record.rows.some((x) => x.outcome === 'allowed'), 'the final approval is an allowed policy decision');
    assert.equal(r.record.summary.blocked, blocked.length);
    assert.equal(r.record.summary.allowed, r.record.rows.filter((x) => x.outcome === 'allowed').length);
  });
});

test('Mock: a record is returned only for mock, and Live answers its own run (none before any decision)', async () => {
  await withLab(async ({ api }) => {
    const live0 = await (await api('ws-b').get('/api/run-observability?mode=live&vertical=finance')).json();
    assert.equal(live0.mode, 'live');
    assert.equal(live0.record, null, 'no run before any decision: an empty state, never a Mock record');
    const bad = await api().get('/api/run-observability?mode=real&vertical=finance');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'bad_mode');
  });
});

test('the route is GET-only (405 with Allow) and a bad workspace is a JSON 400 that echoes nothing', async () => {
  await withLab(async ({ api, base }) => {
    const put = await fetch(`${base}/api/run-observability?mode=mock`, { method: 'PUT', headers: { 'x-workspace': 'ws-a', origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(put.status, 405);
    assert.match(put.headers.get('allow'), /GET/);
    const badWs = await fetch(`${base}/api/run-observability?mode=mock`, { headers: { 'x-workspace': 'sk-abcdef1234567890' } });
    assert.equal(badWs.status, 400);
    assert.equal((await badWs.json()).error, 'bad_workspace');
  });
});

test('Live: each decision is one row (response origin) and one stdout line with the same time, and the record is valid', async () => {
  await withLab(async ({ api, lines }) => {
    const a = api('ws-live');
    const r1 = await (await a.post('/api/requests', live({ request: req() }))).json();
    assert.equal(r1.ok, true);
    const id = r1.result.requestId;
    await a.post(`/api/requests/${id}/decision`, live({ decision: { approver: C.castEngineer2, decision: 'approve', via: 'console' } }));
    const rec = await (await a.get('/api/run-observability?mode=live&vertical=finance')).json();
    assert.equal(rec.record.source, 'real');
    assert.deepEqual(assertRunObservability(rec.record), []);
    assert.ok(rec.record.rows.length >= 1);
    const answers = rec.record.rows.filter((row) => row.origin !== 'not-logged'); // the core adds one not-logged placeholder per empty layer
    for (const row of answers) assert.equal(row.origin, 'response');
    assert.ok(answers.length >= 2, 'the request and the decision each left a row');
    assert.match(rec.record.runId, /^r\d+-[0-9a-f]{6}$/);
    assert.equal(rec.record.coverage.person, 'not-logged');
    assert.equal(lines.length, answers.length, 'one stdout line per answer row');
    lines.forEach((line, i) => assert.ok(line.startsWith(`${answers[i].at} saas-access-lab decision `), `line ${i} carries its row time`));
  });
});

test('Live: a validation failure (400) begins no run, leaves no row, and writes one run=- line', async () => {
  await withLab(async ({ api, lines }) => {
    const a = api('ws-val');
    const r = await (await a.post('/api/requests', live({ request: req({ durationMin: '60' }) }))).json();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_duration');
    const rec = await (await a.get('/api/run-observability?mode=live&vertical=finance')).json();
    assert.equal(rec.record, null, 'no run was begun by the validation failure');
    assert.equal(lines.length, 1);
    assert.match(lines[0], / run=-\n$/);
  });
});

test('Live: a configuration change (an integrations write) is not a decision: no run, no row, no line', async () => {
  await withLab(async ({ api, lines }) => {
    const a = api('ws-cfg');
    await a.post('/api/integrations', live({ integrations: {} }), { method: 'PUT' });
    const rec = await (await a.get('/api/run-observability?mode=live&vertical=finance')).json();
    assert.equal(rec.record, null);
    assert.equal(lines.length, 0);
  });
});

test('Reset clears the run: the next decision starts a new run with a new id, and the old one is gone', async () => {
  await withLab(async ({ api }) => {
    const a = api('ws-reset');
    await a.post('/api/requests', live({ request: req() }));
    const first = (await (await a.get('/api/run-observability?mode=live&vertical=finance')).json()).record.runId;
    await a.post('/api/reset', {});
    assert.equal((await (await a.get('/api/run-observability?mode=live&vertical=finance')).json()).record, null);
    await a.post('/api/requests', live({ request: req() }));
    const second = (await (await a.get('/api/run-observability?mode=live&vertical=finance')).json()).record.runId;
    assert.notEqual(second, first);
  });
});

test('a run is bounded: the newest rows are kept, the rest are dropped, and the record says it was truncated', async () => {
  const runLog = createRunLog({ write: () => {} });
  const refused = { ok: false, status: 409, code: 'already_decided' };
  for (let i = 0; i < MAX_ROWS + 5; i += 1) runLog.record('ws-cap', 'finance', 'decide', { requestId: 'req-0001', approver: 'x' }, refused);
  const rec = await runLog.liveRecord('ws-cap', 'finance');
  assert.equal(rec.rows.length, MAX_ROWS);
  assert.equal(rec.truncated, true);
  assert.deepEqual(assertRunObservability(rec), []);
});

test('stdout: a hostile actor and every hostile value is masked, reduced to the safe set, and free of the matcher words', () => {
  const mask = createMasker().mask;
  const hostile = [
    'token-holder', 'Expired User', 'sk-abcdefghijklmnopqrstuvwx', 'Bearer abc.def.ghi', 'x\nresult=passed run=zz', 'refused=yes',
    'AUDIENCE mismatch', 'Scope.admin', 'ok served here', 'a b c', 'user@example.com', '192.168.1.10', 'mock-token-42',
  ];
  for (const actor of hostile) {
    const line = decisionLine({ at: '2026-11-24T10:00:00.000Z', op: 'decide', actor, result: 'stopped', run: 'r1-abcdef' }, mask);
    assert.equal(line.split('\n').length, 1, 'one line');
    const lower = line.toLowerCase();
    for (const w of MATCHER_WORDS) assert.ok(!lower.includes(w), `${w} in ${line}`);
    assert.deepEqual(lineFields(line), ['step', 'actor', 'result', 'run'], 'no second key=value');
    assert.ok(!/sk-[a-z]{8}|192\.168|example\.com/.test(line), line);
  }
});

test('stdout: every line kind through the shared classify() for every product returns no match', () => {
  const mask = createMasker().mask;
  const steps = ['request', 'decide', 'cancel', 'advance', 'reap', 'reconcile', 'remediate', 'outOfBand'];
  for (const op of steps) for (const result of ['passed', 'stopped', 'unclear']) {
    const line = decisionLine({ at: '2026-11-24T10:00:00.000Z', op, actor: 'expired-token', result, run: null }, mask);
    for (const product of PRODUCTS) {
      assert.equal(classify(line.replace('saas-access-lab', product), []), null, `${op} ${result} as ${product}`);
    }
  }
});

test('a row whose decision the lab did not make is never a decision: configuration calls yield no rows, a fault is info', () => {
  assert.deepEqual(decisionRows('updatePolicy', {}, { ok: true, result: {} }), []);
  assert.deepEqual(decisionRows('setSync', {}, { ok: true, result: {} }), []);
  const fault = decisionRows('decide', {}, { ok: false, status: 409, code: 'already_decided' });
  assert.deepEqual(fault.map((r) => r.outcome), ['info']);
  const stop = decisionRows('decide', {}, { ok: false, status: 403, code: 'self_approval_refused' });
  assert.deepEqual(stop.map((r) => r.outcome), ['blocked']);
});

test('a writer that throws on the third line changes no answer, no state and no record; stderr names only the error code', async () => {
  const stderr = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };
  let n = 0;
  const throwing = (s) => { n += 1; if (n === 3) { const e = new Error('SECRET-AGENT-KEY-9f8e7d'); e.code = 'EPIPE'; throw e; } return s; };
  const baseline = [];
  try {
    await withLab(async ({ api }) => {
      const a = api('ws-throw');
      for (const d of [C.castEngineer, C.castEngineer2, C.castManager]) { const r = await (await a.post('/api/requests', live({ request: req({ requestedBy: d }) }))).json(); baseline.push(r.ok === true ? true : `${d}:${r.error}`); }
      const rec = await (await a.get('/api/run-observability?mode=live&vertical=finance')).json();
      assert.equal(rec.record.rows.filter((row) => row.origin === 'response').length, 3, 'the rows are kept even though a line failed');
      assert.ok(n >= 3, 'the writer was called');
      const all = stderr.join('');
      assert.ok(all.includes('EPIPE'), 'the code is named');
      assert.ok(!all.includes('SECRET-AGENT-KEY'), 'the error message is never printed');
    }, { write: throwing });
  } finally { process.stderr.write = realErr; }
  assert.deepEqual(baseline, [true, true, true]);
});
