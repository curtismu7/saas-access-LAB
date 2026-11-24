// Rule 27: this lab's side of the shared run-observability panel. The core (server/src/runObservability.js) is vendored and never edited here.
//
// The lab runs no product and reads no log. Its own policy engine (the stand-in for the request, approval and reaper steps of a Privilege workflow)
// makes the decisions, and the panel shows them as they were made:
//   - Mock: each row is an event the mock computed when its table was built (read from the stored steps, never re-run), origin `simulated`.
//   - Live: each row is an answer the lab's own engine gave the page, held as an API response, origin `response`. Each row also leaves one
//     timestamped stdout line, written at the time of the answer. Nothing reads that line here.
// Validation failures (400s that are input shape, not policy) are not decisions: they begin no run and leave no row.
import { randomBytes } from 'node:crypto';
import { createMasker, createRunObservability, LAYERS } from './runObservability.js';

export const MAX_ROWS = 500;
export const MAX_RUNS = 500; // runs kept per lab: a new run past this drops the one written longest ago
const SERVICE = 'saas-access-lab';
const VALIDATION = new Set(['bad_duration']);
const REFUSED_CODES = new Set(['level_above_policy', 'not_an_approver']);
const BLOCKED_CODES = new Set(['self_approval_refused', 'approver_not_human']);

// The words a shared matcher reads as a decision. A stdout value that contains one (in any case) is replaced by the mark, never printed.
const MATCHER_WORDS = ['refused', 'denied', 'rejected', 'forbidden', 'failed', 'invalid', 'expired', 'mismatch', 'token', 'audience', 'scope', 'served'];
const UNSAFE = /[^A-Za-z0-9._:/@-]/g;

export const WHY = {
  person: 'This lab has no sign-in: requesters and approvers are names the scenario or the page gives, and no identity provider is called.',
  agent: 'No agent token is issued here. An agent is the subject of a request, shown under Privilege, and is not a token exchange.',
  authorize: 'This lab has no PingOne Authorize step.',
  privilege: 'No request, approval, reaper or reconcile decision happened in this run.',
  gateway: 'The lab puts no gateway in front of its platforms, so no gateway decision or log exists.',
  resource: 'The six platforms are simulated inside the lab, and no platform log exists to read.',
};

const fields = (r) => ({ layer: r.layer, outcome: r.outcome, message: r.message, detail: r.detail });
const row = (layer, outcome, message, detail) => ({ layer, outcome, message, ...(detail ? { detail } : {}) });

// The decision rows one engine call leaves. `outcome` is what perform() returned: { ok, result } or { ok: false, status, code }.
// Only policy points give allowed, refused or blocked; everything else is info. An empty list means the call was not a decision.
export function decisionRows(op, params, outcome) {
  const p = params && typeof params === 'object' ? params : {};
  if (!outcome.ok) {
    const code = outcome.code;
    if (VALIDATION.has(code)) return [];
    if (code === 'level_above_policy') return [row('privilege', 'refused', 'The policy does not allow this level for this request', { code })];
    if (code === 'not_an_approver') return [row('privilege', 'refused', 'The approver is not routed to this approval level', { code })];
    if (BLOCKED_CODES.has(code)) return [row('privilege', 'blocked', 'The lab stopped a self-approval or non-human approval', { code })];
    if (outcome.status === 400) return [];
    return [row('privilege', 'info', `The call was not a decision: ${String(code || 'unknown').slice(0, 40)}`, { code })];
  }
  const r = outcome.result || {};
  switch (op) {
    case 'request':
      return r.status === 'granted'
        ? [row('privilege', 'allowed', `Policy approved ${r.requestId} with no approval step`)]
        : [row('privilege', 'info', `${r.requestId} is waiting for approval`)];
    case 'decide':
      if (r.status === 'granted') return [row('privilege', 'allowed', `Final approval: ${r.requestId} is granted`)];
      // A denial ends the request at the policy point (the lab stops the access), so it is refused; the approval steps before it are info.
      if (r.status === 'denied') return [row('privilege', 'refused', `${r.requestId} was denied by its approver`)];
      return [row('privilege', 'info', `An approval was recorded; ${r.requestId} waits for the next level`)];
    case 'cancel': return [row('privilege', 'info', `${r.requestId} was cancelled`)];
    case 'advance': return [row('privilege', 'info', 'The lab clock moved forward; the reaper removes expired access')];
    case 'reap': return [row('privilege', 'info', 'The reaper ran: expired access was removed on the lab platforms')];
    case 'reconcile': return [row('privilege', 'info', `The nightly reconcile ran: ${Array.isArray(r.findings) ? r.findings.length : 0} finding(s)`)];
    case 'remediate': return [row('privilege', 'info', `Drift was remediated in run ${String(r.run || '-').slice(0, 40)}`)];
    case 'outOfBand': return [row('resource', 'info', 'Access was changed by hand on a platform, outside Privilege')];
    default: return []; // updatePolicy, retirePolicy, setSync, updateIntegrations: configuration, not decisions
  }
}

// The actor of a call, as the page typed it (the stdout line sanitises it).
export function actorOf(op, params) {
  const p = params && typeof params === 'object' ? params : {};
  switch (op) {
    case 'request': return p.requestedBy;
    case 'decide': return p.approver;
    case 'cancel': return p.by;
    case 'advance': return 'visitor';
    case 'outOfBand': return 'by-hand';
    case 'reap': return 'reaper';
    case 'reconcile': case 'remediate': return 'reconcile';
    default: return 'lab';
  }
}

const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

// One stdout value: masked, then reduced to the safe set, then replaced by the mark if it holds a matcher word. Never a second key=value.
export function stdoutValue(v, mask = createMasker().mask) {
  const s = String(v ?? '-').slice(0, 200);
  const clean = String(mask(s)).replace(UNSAFE, '_').slice(0, 64) || '-';
  const low = clean.toLowerCase();
  return MATCHER_WORDS.some((w) => low.includes(w)) ? 'masked' : clean;
}

// One timestamped line per decision: the step, the actor and the result. Run `-` when the call began no run.
export function decisionLine({ at, op, actor, result, run }, mask) {
  return `${at} ${SERVICE} decision step=${stdoutValue(op, mask)} actor=${stdoutValue(actor, mask)} result=${result} run=${run ? stdoutValue(run, mask) : '-'}`;
}

// The record of a Mock scenario, from the steps its table stored (the engine ran them once, when the table was built).
export async function mockRunRecord({ vertical, scenario }) {
  const rows = scenario.steps.flatMap((st) => decisionRows(st.op, st.params, st.result).map((r) => ({ ...fields(r), at: st.at })));
  if (!rows.length) return null;
  const at = rows.map((r) => r.at);
  return createRunObservability().collectRun({
    runId: `mock-${vertical}-${scenario.id}`, startedAt: at[0], endedAt: at[at.length - 1], source: 'mock',
    layers: LAYERS.map((layer) => {
      const mine = rows.filter((r) => r.layer === layer);
      return { layer, products: [], reason: WHY[layer], simulated: mine.map((r) => ({ at: r.at, outcome: r.outcome, message: r.message, detail: r.detail })) };
    }),
  });
}

// The record of one Live run: the lab's own answers (response rows), and the layers the run did not touch say so.
async function liveRunRecord(run) {
  const at = run.rows.map((r) => r.at);
  const record = await createRunObservability().collectRun({
    runId: run.runId, startedAt: at[0], endedAt: at[at.length - 1], source: 'real',
    layers: LAYERS.map((layer) => {
      const mine = run.rows.filter((r) => r.layer === layer);
      return { layer, products: [], reason: WHY[layer], responses: mine.map((r) => ({ at: r.at, outcome: r.outcome, message: r.message, detail: r.detail })) };
    }),
  });
  if (run.dropped > 0) record.truncated = true; // the oldest rows were dropped at MAX_ROWS: say so
  return record;
}

// A safe code or name for stderr: never err.message (a forced error can carry a secret).
const codeOf = (err) => String(err?.code || err?.name || 'error').replace(UNSAFE, '_').slice(0, 40);

// The Live recorder: one run per workspace and vertical, started by its first decision after a reset. `write` takes one line of text.
export function createRunLog({ write = () => {}, now = () => new Date().toISOString() } = {}) {
  const mask = createMasker().mask;
  const runs = new Map();
  let counter = 0;
  const emit = (line) => {
    try { write(`${line}\n`); }
    catch (err) { process.stderr.write(`run-observability: a stdout line was not written (${codeOf(err)})\n`); }
  };
  const keyOf = (ws, vertical) => `${ws}|${vertical}`;

  // Called once per engine call in Live. Assigns and stores the run before any line is written. A validation failure writes one run=- line.
  function record(ws, vertical, op, params, outcome) {
    const rows = decisionRows(op, params, outcome);
    if (!rows.length) {
      if (!outcome.ok && outcome.status === 400) emit(decisionLine({ at: now(), op, actor: actorOf(op, params), result: 'unclear', run: null }, mask));
      return null;
    }
    const key = keyOf(ws, vertical);
    let run = runs.get(key);
    if (run) { runs.delete(key); runs.set(key, run); } // re-inserted: the map's first key is the run written longest ago
    else {
      if (runs.size >= MAX_RUNS) runs.delete(runs.keys().next().value);
      counter += 1;
      run = { runId: `r${counter}-${randomBytes(3).toString('hex')}`, rows: [], dropped: 0 };
      runs.set(key, run);
    }
    const stamped = rows.map((r) => ({ ...fields(r), at: now() }));
    for (const r of stamped) run.rows.push(r);
    while (run.rows.length > MAX_ROWS) { run.rows.shift(); run.dropped += 1; }
    for (const r of stamped) emit(decisionLine({ at: r.at, op, actor: actorOf(op, params), result: RESULT[r.outcome], run: run.runId }, mask));
    return run.runId;
  }

  // The current run of a workspace and vertical, as a record. null before any decision in it.
  async function liveRecord(ws, vertical) {
    const run = runs.get(keyOf(ws, vertical));
    return run && run.rows.length ? liveRunRecord(run) : null;
  }

  // Reset clears every vertical of the workspace: the next decision starts a new run with a new id.
  function reset(ws) { for (const k of [...runs.keys()]) if (k.startsWith(`${ws}|`)) runs.delete(k); }

  return { record, liveRecord, reset };
}
