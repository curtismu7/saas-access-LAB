// The glue between the HTTP layer and the engine: Mock reads tables, Live drives the workspace's engine. Every action gets one W3C
// trace and a list of hops (the raw request and response panes), with anything credential-shaped masked.
import { Engine } from './engine.js';
import { perform } from './actions.js';
import { maskDeep } from './credentials.js';
import { newTrace, formatTraceparent } from './trace.js';

// A copy of the visitor's parameters that is safe to show: every string AND every object key masked by the shared masker (shared/mask.js through
// credentials.js), nothing else changed. Nothing is cut: a write whose body is over a bound (bounds.js) is refused before it gets here, so what arrives is
// small enough to show whole.
export const scrub = (value) => maskDeep(value);

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
