// One Express app. /api = health, info, story, diagram, state, preview and the action endpoints (requests, decisions, clock, reaper, drift, platforms,
// policies, integrations, reset). Server state per workspace id (X-Workspace) is one engine per vertical, so one visitor's Reset never touches another's.
// Mock reads generated tables and refuses every write; Live drives the engine. Both are loopback-only with zero outbound calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { loadCast, verticalFrom } from './cast.js';
import { defaultMode, modeOf } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { InputError } from './errors.js';
import { MOCK_TABLE } from './mockTable.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';
import { Engine } from './engine.js';
import { liveState, mockState, runAction } from './service.js';
import { maskDeep } from './mask.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createApp({ health = createHealth(), configFile = CONFIG, workspaces = createWorkspaces(), table = MOCK_TABLE, webDist = WEB_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  // Defence in depth: every JSON answer is masked for credential-shaped values, whatever path produced it.
  api.use((_req, res, next) => { const send = res.json.bind(res); res.json = (b) => send(maskDeep(b)); next(); });
  api.use('/health', health.router);
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const ws = (req, res) => { const id = workspaceFrom(req); if (!id) res.status(400).json({ error: 'bad_workspace' }); return id; };
  const bodyOf = (req) => (isObj(req.body) ? req.body : {});

  api.get('/story', (req, res) => { noStore(res); res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => { noStore(res); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  api.get('/info', (_req, res) => { noStore(res); res.json({ mode: defaultMode(), modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });

  api.get('/state', (req, res) => {
    const id = ws(req, res); if (!id) return;
    noStore(res);
    const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const vertical = verticalOf(req);
    if (mode === 'mock') return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario) });
    return res.json({ mode, vertical, workspace: id, state: liveState(id, workspaces, vertical, castFor(req)) });
  });

  // Read-only: the same checks and routing as a real request, creating nothing. Mock uses a fresh engine, Live the workspace's own.
  api.post('/preview', (req, res) => {
    const id = ws(req, res); if (!id) return;
    noStore(res);
    const body = bodyOf(req);
    const mode = modeOf(body.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const e = mode === 'mock' ? new Engine(castFor(req)) : workspaces.engine(id, verticalOf(req), castFor(req));
    return res.json({ workspace: id, mode, preview: e.preview(body.request) });
  });

  // Every write: Live only, strict top-level keys, one trace, hops, and the whole fresh state back.
  const write = (method, route, { op, keys, params }) => {
    api[method](route, (req, res, next) => {
      const id = ws(req, res); if (!id) return;
      noStore(res);
      try {
        if (!isObj(req.body)) return res.status(400).json({ error: 'bad_request' });
        const mode = modeOf(req.body.mode);
        if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
        if (mode === 'mock') return res.status(409).json({ error: 'mock_is_read_only', detail: 'Mock mode only reads tables: switch to Live to act' });
        if (!Object.keys(req.body).every((k) => ['mode', 'vertical', 'refusalsAs200', ...keys].includes(k))) return res.status(400).json({ error: 'unknown_field', detail: 'the body carries a field the lab does not take' });
        const vertical = verticalOf(req);
        const r = runAction({ ws: id, workspaces, vertical, cast: castFor(req), op, params: params(req), traceparent: req.headers.traceparent, route: { method: method.toUpperCase(), url: `/api${route}` } });
        res.set('traceparent', r.traceparent);
        const common = { workspace: id, mode, vertical, hops: r.hops, hopsTruncated: r.hopsTruncated, traceId: r.traceId, state: r.state };
        if (r.outcome.ok) return res.json({ ok: true, result: r.outcome.result, ...common });
        // The page asks for refusals as data (HTTP 200 with ok: false): a browser logs every 4xx answer as a console error, and a refusal the visitor
        // asked for (self-approval, an expired request) is the point of the demo. Anyone else gets the honest 4xx status.
        return res.status(req.body.refusalsAs200 === true ? 200 : (r.outcome.status || 400)).json({ ok: false, error: r.outcome.code, detail: r.outcome.detail, ...(r.outcome.errors ? { errors: r.outcome.errors } : {}), ...common });
      } catch (e) { return next(e); }
    });
  };
  const idParam = (req) => (typeof req.params.id === 'string' ? req.params.id : '');
  write('post', '/requests', { op: 'request', keys: ['request'], params: (req) => req.body.request });
  write('post', '/requests/:id/decision', { op: 'decide', keys: ['decision'], params: (req) => ({ ...(isObj(req.body.decision) ? req.body.decision : { __bad: 1 }), requestId: idParam(req) }) });
  write('post', '/requests/:id/cancel', { op: 'cancel', keys: ['by'], params: (req) => ({ requestId: idParam(req), by: req.body.by }) });
  write('post', '/clock', { op: 'advance', keys: ['clock'], params: (req) => (isObj(req.body.clock) ? req.body.clock : { __bad: 1 }) });
  write('post', '/reaper/run', { op: 'reap', keys: [], params: () => ({}) });
  write('post', '/drift/reconcile', { op: 'reconcile', keys: [], params: () => ({}) });
  write('post', '/drift/remediate', { op: 'remediate', keys: ['findingId'], params: (req) => ({ findingId: req.body.findingId }) });
  write('post', '/platforms/out-of-band', { op: 'outOfBand', keys: ['change'], params: (req) => (isObj(req.body.change) ? req.body.change : { __bad: 1 }) });
  write('post', '/platforms/sync', { op: 'setSync', keys: ['change'], params: (req) => req.body.change });
  write('put', '/policies/:id', { op: 'updatePolicy', keys: ['policy'], params: (req) => ({ id: idParam(req), policy: req.body.policy }) });
  write('post', '/policies/:id/retire', { op: 'retirePolicy', keys: [], params: (req) => ({ id: idParam(req) }) });
  write('put', '/integrations', { op: 'updateIntegrations', keys: ['integrations'], params: (req) => req.body.integrations });

  // Reset clears this workspace's engines (requests, grants, receipts, platform state, outbox, audit, the clock) and nothing else.
  api.post('/reset', (req, res) => { const id = ws(req, res); if (!id) return; noStore(res); workspaces.reset(id); return res.json({ reset: 'ok', workspace: id }); });
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  // The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an
  // HTML stack trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code });
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
