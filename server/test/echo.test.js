// A credential the visitor types must come back in NO response field, hop pane, receipt, outbox entry, log line or error: tested by typing every
// credential shape into every place a request can carry text, on every endpoint, and searching every answer (and the process output) for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, put, spec, withServer } from './helpers.js';
import { SECRETS } from './secrets.js';

const NEEDLES = Object.fromEntries(Object.entries(SECRETS).map(([k, v]) => [k, { raw: v, probe: k === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : k === 'bearer' ? 'tokenvalue' : k === 'assignment' ? 'hunter2hunter2' : v }]));
const W = (id) => ({ 'x-workspace': id });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });

test('typing every credential shape into every field of every endpoint never echoes it', async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log; const origErr = console.error;
  await withServer(async (url) => {
    // a request and a hold to decide, so the decision and policy endpoints have something real to act on
    await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident' }) }));
    const sweep = async (name, v) => {
      const bodies = [
        ['POST', '/api/requests', live({ request: spec({ reason: v, requestedBy: v, subjectId: v, platform: v, resource: v, level: v, policyId: v, subjectKind: v, durationMin: v }) })],
        ['POST', '/api/requests', live({ request: spec({ reason: `r ${v}` }), [v]: v })],
        ['POST', '/api/requests', live({ request: { ...spec(), [v]: v } })],
        ['POST', `/api/requests/${encodeURIComponent(v)}/decision`, live({ decision: { approver: v, decision: v, via: v, comment: v } })],
        ['POST', '/api/requests/req-0001/decision', live({ decision: { approver: v, decision: 'approve', via: 'console', comment: v } })],
        ['POST', '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead, decision: 'deny', via: 'console', comment: `c ${v}` } })],
        ['POST', `/api/requests/${encodeURIComponent(v)}/cancel`, live({ by: v })],
        ['POST', '/api/clock', live({ clock: { minutes: v, to: v } })],
        ['POST', '/api/clock', live({ clock: { [v]: v } })],
        ['POST', '/api/reaper/run', live({ [v]: v })],
        ['POST', '/api/drift/remediate', live({ findingId: v })],
        ['POST', '/api/platforms/out-of-band', live({ change: { op: v, platform: v, resource: v, subjectKind: v, subjectId: v, level: v } })],
        ['POST', '/api/platforms/sync', live({ change: { platform: v, sync: v } })],
        ['PUT', `/api/policies/${encodeURIComponent(v)}`, live({ policy: { maxLevel: v, maxDurationMin: v, chain: [{ role: v, required: v }], requireDistinctApprovers: v, requestTtlMin: v, channel: v, autoApprove: { enabled: v, maxLevel: v, maxDurationMin: v }, [v]: v } })],
        ['POST', `/api/policies/${encodeURIComponent(v)}/retire`, live({})],
        ['PUT', '/api/integrations', live({ integrations: { [v]: { Hitl: v }, slack: { [v]: v, Hitl: v } } })],
        ['POST', '/api/preview', live({ request: spec({ reason: v, requestedBy: v, platform: v }) })],
        ['POST', '/api/preview', { mode: v, vertical: v, request: v }],
        ['POST', '/api/reset', { [v]: v }],
      ];
      const gets = [`/api/state?mode=${encodeURIComponent(v)}`, `/api/state?mode=live&vertical=${encodeURIComponent(v)}&scenario=${encodeURIComponent(v)}`, `/api/state?mode=mock&scenario=${encodeURIComponent(v)}`, `/api/story?vertical=${encodeURIComponent(v)}`, `/api/diagram?name=${encodeURIComponent(v)}&vertical=${encodeURIComponent(v)}`, `/api/${encodeURIComponent(v)}`, `/api/health?x=${encodeURIComponent(v)}`];
      const texts = [];
      for (const [m, p, b] of bodies) { const r = await (m === 'PUT' ? put : post)(url, p, b); texts.push(`${m} ${r.status} ${await r.text()} ${[...r.headers.values()].join(' ')}`); }
      for (const g of gets) { const r = await get(url, g); texts.push(`GET ${r.status} ${await r.text()} ${[...r.headers.values()].join(' ')}`); }
      for (const hv of [v, `a ${v}`]) { const r = await get(url, '/api/state?mode=live', { 'x-workspace': hv.slice(0, 40).replace(/[^\x20-\x7e]/g, '?') }); texts.push(`H ${r.status} ${await r.text()}`); }
      return texts.join('\n');
    };
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      for (const [name, n] of Object.entries(NEEDLES)) {
        const text = await sweep(name, n.raw);
        assert.ok(!text.includes(n.probe), `${name}: the raw value is absent from every answer: ${text.split('\n').filter((l) => l.includes(n.probe)).map((l) => l.slice(0, 160)).join(' | ')}`);
        // the live state afterwards (receipts, hops, outbox, audit) is clean too
        const state = JSON.stringify(await (await get(url, '/api/state?mode=live')).json());
        assert.ok(!state.includes(n.probe), `${name}: absent from the state`);
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; console.log = origLog; console.error = origErr; }
  });
  for (const n of Object.values(NEEDLES)) assert.ok(!out.join('').includes(n.probe), 'nothing was logged');
});

test('a credential in a real, accepted request is masked in the response, the hops, the outbox, the receipts and the audit trail', async () => {
  await withServer(async (url) => {
    for (const [name, n] of Object.entries(NEEDLES)) {
      const ws = `echo-${name.toLowerCase()}`.slice(0, 30).replace(/[^a-z0-9-]/g, '-');
      const r = await post(url, '/api/requests', live({ request: spec({ policyId: 'pol-incident', reason: `please ${n.raw} thanks` }) }), W(ws));
      const body = await r.text();
      assert.equal(r.status, 200, name);
      assert.ok(!body.includes(n.probe), `${name}: not in the answer`);
      assert.match(body, /\[masked:/);
      const d = await post(url, '/api/requests/req-0001/decision', live({ decision: { approver: C.castSecLead2, decision: 'approve', via: 'slack', comment: `ok ${n.raw}` } }), W(ws));
      const db = await d.text();
      assert.equal(d.status, 200); assert.ok(!db.includes(n.probe), `${name}: not in the decision answer`);
      assert.ok(db.includes('"outbox"') && db.includes('"receipts"') && db.includes('"audit"') && db.includes('"hops"'));
    }
  });
});

test('field names are not echoed either: an unknown key that is itself a credential never comes back', async () => {
  await withServer(async (url) => {
    for (const n of Object.values(NEEDLES)) {
      const r = await post(url, '/api/requests', live({ request: { ...spec(), [n.raw]: 1 } }));
      const t = await r.text();
      assert.equal(r.status, 400); assert.ok(!t.includes(n.probe));
      const p = await put(url, '/api/policies/pol-incident', live({ policy: { [n.raw]: 1 } }));
      assert.ok(!(await p.text()).includes(n.probe));
    }
  });
});
