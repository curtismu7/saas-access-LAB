// The glue between the HTTP layer and the engine: Mock reads tables, Live drives the workspace's engine. Every action gets one W3C
// trace and a list of hops (the raw request and response panes), with anything credential-shaped masked.
import { Engine, defaultIntegrations } from './engine.js';
import { perform, REQUEST_KEYS, DECISION_KEYS, OOB_KEYS, CLOCK_KEYS } from './actions.js';
import { EDITABLE_FIELDS } from './policies.js';
import { maskDeep } from './credentials.js';
import { newTrace, formatTraceparent } from './trace.js';

// The field names the lab itself takes (request, decision, clock, out-of-band, sync, policy and integration fields, and the body wrappers). A key typed by
// the visitor that is not one of them is NEVER echoed as typed: the masker cannot judge a one-character secret ("login: bob / x") or a bare word, but an
// allow-list can, so such a key is shown as the mark. Known names stay readable so the hop pane still teaches the real shape of each call.
export const KNOWN_KEYS = new Set([
  'mode', 'vertical', 'refusalsAs200', 'request', 'decision', 'by', 'clock', 'findingId', 'change', 'policy', 'integrations', 'id', 'requestId',
  ...REQUEST_KEYS, ...DECISION_KEYS, ...OOB_KEYS, ...CLOCK_KEYS, ...EDITABLE_FIELDS, 'sync', 'role', 'required', 'enabled', 'maxLevel', 'maxDurationMin',
  ...Object.entries(defaultIntegrations()).flatMap(([name, v]) => [name, ...Object.keys(v)]),
]);
const MARK = '[masked]';
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

// A copy in which every object key that is not a known field name is the mark ("[masked]", "[masked]#2" ...: nothing is dropped, two unknown keys stay apart).
// Iterative: a deep structure cannot overflow the stack.
export function nameKeys(value) {
  const out = {};
  const work = [[value, out, 'v']];
  while (work.length) {
    const [x, dst, key] = work.pop();
    if (Array.isArray(x)) {
      const copy = []; put(dst, key, copy);
      for (let i = x.length - 1; i >= 0; i -= 1) work.push([x[i], copy, i]);
    } else if (x !== null && typeof x === 'object') {
      const copy = {}; put(dst, key, copy);
      const used = new Set(); const names = [];
      for (const k of Object.keys(x)) {
        let nk = KNOWN_KEYS.has(k) ? k : MARK; let n = 2;
        while (used.has(nk)) { nk = `${MARK}#${n}`; n += 1; }
        used.add(nk); names.push([k, nk]);
      }
      for (let i = names.length - 1; i >= 0; i -= 1) work.push([x[names[i][0]], copy, names[i][1]]);
    } else put(dst, key, x);
  }
  return out.v;
}

// A copy of the visitor's parameters that is safe to show: unknown keys shown as the mark (above), then every string AND every remaining key masked by the
// shared masker (shared/mask.js through credentials.js). Nothing is cut: a write whose body is over a bound (bounds.js) is refused before it gets here, so
// what arrives is small enough to show whole.
export const scrub = (value) => maskDeep(nameKeys(value));

export function mockState(table, vertical, scenarioId) {
  const v = table.verticals[vertical];
  const sc = (typeof scenarioId === 'string' && v.scenarios.find((s) => s.id === scenarioId)) || v.scenarios[0];
  return { state: { ...v.base, ...sc.state }, scenario: { id: sc.id, title: sc.title, say: sc.say, steps: sc.steps }, scenarios: v.scenarios.map((s) => ({ id: s.id, title: s.title, say: s.say })) };
}

export function liveState(ws, workspaces, vertical, cast) {
  const e = workspaces.peek(ws, vertical) || new Engine(cast);
  return e.snapshot();
}

// Runs one engine action for a workspace with a trace. Returns { outcome, hops, traceparent, state }.
export function runAction({ ws, workspaces, vertical, cast, op, params, traceparent, route }) {
  const e = workspaces.engine(ws, vertical, cast);
  const t = newTrace(traceparent);
  const root = t.span();
  e.trace = { traceId: t.traceId, span: t.span }; e.hops = []; e.hopsTruncated = false;
  let outcome;
  try { outcome = perform(e, op, params); } finally { e.trace = null; }
  const first = { n: 1, label: 'browser to the lab API', request: { method: route.method, url: route.url, headers: { traceparent: formatTraceparent(t.traceId, root), 'x-workspace': ws }, body: scrub(params) }, response: { status: outcome.ok ? 200 : outcome.status, body: outcome.ok ? { ok: true } : { error: outcome.code } } };
  const hops = [first, ...e.hops.map((h, i) => ({ ...h, n: i + 2 }))];
  const truncated = e.hopsTruncated; e.hops = [];
  return { outcome, hops, hopsTruncated: truncated, traceparent: formatTraceparent(t.traceId, root), traceId: t.traceId, state: e.snapshot() };
}
