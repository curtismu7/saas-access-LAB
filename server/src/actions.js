// One dispatch for everything that changes an engine, used by the API, the scripted scenarios and the tests, so they cannot drift apart.
// A refusal from the engine is data ({ ok: false, code, detail }), never an exception; anything else is a bug and propagates.
import { InputError } from './errors.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Strict: a body may carry only the listed keys. The error never says which key was unexpected (it could be a credential).
export function onlyKeys(obj, allowed) {
  if (!isObj(obj)) return false;
  return Object.keys(obj).every((k) => allowed.includes(k));
}
export const REQUEST_KEYS = ['requestedBy', 'subjectKind', 'subjectId', 'platform', 'resource', 'level', 'durationMin', 'policyId', 'reason'];
export const DECISION_KEYS = ['approver', 'decision', 'via', 'comment'];
export const OOB_KEYS = ['op', 'platform', 'resource', 'subjectKind', 'subjectId', 'level'];
export const CLOCK_KEYS = ['minutes', 'to'];

const OPS = {
  request: (e, p) => { if (!onlyKeys(p, REQUEST_KEYS)) throw new InputError('unknown_field', 'the request carries a field the lab does not take'); const r = e.createRequest(p); return { requestId: r.id, status: r.status, grantId: r.approval.GrantID }; },
  decide: (e, p) => { if (!onlyKeys(p, ['requestId', ...DECISION_KEYS])) throw new InputError('unknown_field', 'the decision carries a field the lab does not take'); const r = e.decide(p); return { requestId: r.id, status: r.status, grantId: r.approval.GrantID, level: r.currentLevel + 1 }; },
  cancel: (e, p) => { const r = e.cancel(p); return { requestId: r.id, status: r.status }; },
  advance: (e, p) => { if (!onlyKeys(p, CLOCK_KEYS)) throw new InputError('unknown_field', 'the clock call carries a field the lab does not take'); return e.advance(p); },
  reap: (e) => e.reap(),
  reconcile: (e) => { const r = e.reconcile('manual'); return { run: r.id, findings: r.findings, newFindings: r.newFindings }; },
  remediate: (e, p) => { const r = e.remediate(p); return { run: r.id, findings: r.findings }; },
  outOfBand: (e, p) => { if (!onlyKeys(p, OOB_KEYS)) throw new InputError('unknown_field', 'the call carries a field the lab does not take'); return e.outOfBand(p); },
  updatePolicy: (e, p) => { const pol = e.updatePolicy(p?.id, p?.policy); return { policyId: pol.id }; },
  retirePolicy: (e, p) => e.retirePolicy(p?.id),
  setSync: (e, p) => e.setSync(p),
  updateIntegrations: (e, p) => { e.updateIntegrations(p); return { updated: true }; },
};
export const OP_NAMES = Object.keys(OPS);

export function perform(engine, op, params) {
  if (!Object.hasOwn(OPS, op)) throw new Error(`unknown op ${op}`);
  try { return { ok: true, result: OPS[op](engine, params) }; }
  catch (e) { if (e instanceof InputError) return { ok: false, status: e.status, code: e.code, detail: e.message, ...(e.errors ? { errors: e.errors } : {}) }; throw e; }
}
