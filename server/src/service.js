// The glue between the HTTP layer and the engine: Mock reads tables, Live drives the workspace's engine. Every action gets one W3C
// trace and a list of hops (the raw request and response panes), with anything credential-shaped masked.
import { Engine } from './engine.js';
import { perform } from './actions.js';
import { cleanFree } from './credentials.js';
import { newTrace, formatTraceparent } from './trace.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A copy of the visitor's parameters that is safe to show: every string AND every object key masked, nothing else changed. Nothing is cut: a write whose
// body is over a bound (bounds.js) is refused before it gets here, so what arrives is small enough to show whole. Depth-limited as a second guard.
export function scrub(value, depth = 0) {
  if (typeof value === 'string') return cleanFree(value);
  if (depth > 8) return '[nested too deep to show]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (isObj(value)) {
    const out = {}; const used = new Set();
    for (const k of Object.keys(value)) {
      let nk = cleanFree(k); let n = 2;
      while (used.has(nk)) { nk = `${cleanFree(k)}#${n}`; n += 1; }
      used.add(nk);
      Object.defineProperty(out, nk, { value: scrub(value[k], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
}

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
