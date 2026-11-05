// One Express app. /api = health, info, story, diagram, state, preview and the action endpoints (requests, decisions, clock, reaper, drift, platforms,
// policies, integrations, reset). Server state per workspace id (X-Workspace) is one engine per vertical, so one visitor's Reset never touches another's.
// Mock reads generated tables and refuses every write; Live drives the engine. Both are loopback-only with zero outbound calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { buildMethodTable, charsetProblem, isPageAddress, methodNotAllowed } from './shared/hygiene.js';
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
import { overBounds } from './bounds.js';
import { shelfInfo } from './shelfLink.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TOO_BIG = 'a text (over 400 characters), a name (over 80), a list (over 20), an object (over 40 keys) or the nesting (over 6 levels) is more than the lab takes: nothing was run';

// The one route table: path -> methods (":id" is one segment, case and one trailing slash are not significant, HEAD follows GET). It answers the 405 and
// nothing else; the handlers below are registered once each, and a test checks that every route registered here is in the table and the other way round.
export const ROUTES = {
  '/api/shelf': ['GET'],
  '/api/health': ['GET'],
  '/api/info': ['GET'],
  '/api/story': ['GET'],
  '/api/diagram': ['GET'],
  '/api/state': ['GET'],
  '/api/preview': ['POST'],
  '/api/requests': ['POST'],
  '/api/requests/:id/decision': ['POST'],
  '/api/requests/:id/cancel': ['POST'],
  '/api/clock': ['POST'],
  '/api/reaper/run': ['POST'],
  '/api/drift/reconcile': ['POST'],
  '/api/drift/remediate': ['POST'],
  '/api/platforms/out-of-band': ['POST'],
  '/api/platforms/sync': ['POST'],
  '/api/policies/:id': ['PUT'],
  '/api/policies/:id/retire': ['POST'],
  '/api/integrations': ['PUT'],
  '/api/reset': ['POST'],
};
const METHODS = buildMethodTable(ROUTES);

export function createApp({ health = createHealth(), configFile = CONFIG, workspaces = createWorkspaces(), table = MOCK_TABLE, webDist = WEB_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // 0. The response mask, first of all: everything that leaves through res.json (hops, echo, state, audit, errors) is passed through maskDeep, values AND object
  //    keys, whatever path produced it. The input is never mutated.
  app.use((_req, res, next) => { const send = res.json.bind(res); res.json = (b) => send(maskDeep(b)); next(); });
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  // 1. Charset gate: any charset but utf-8 is a 415 with a fixed body. charsetProblem returns a fixed code, never the value, and nothing is logged.
  app.use((req, res, next) => (charsetProblem(req.headers['content-type']) ? res.status(415).json({ error: 'unsupported_charset' }) : next()));

  const api = express.Router();
  // 2. A wrong method on a known route is a 405 with Allow, built from the one route table above (ROUTES), never a 404 that hides the route and never
  //    Express's HTML. A path that is not in the table falls through to the JSON 404. HEAD follows GET.
  api.use((req, res, next) => {
    const miss = methodNotAllowed(METHODS, req.method, `/api${req.path}`);
    return miss ? res.set('Allow', miss.allow.join(', ')).status(405).json({ error: 'method_not_allowed' }) : next();
  });
  api.use(express.json({ limit: '32kb' }));
  api.use('/health', health.router);
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  // 3. The workspace id is checked BEFORE a slot exists: a refused id (credential-looking, see workspaces.js) is a 400 bad_workspace that echoes nothing.
  //    Only the routes that use a workspace take this middleware; the slot itself is created later, by the engine call of a write.
  const workspace = (req, res, next) => { const id = workspaceFrom(req); if (!id) return res.status(400).json({ error: 'bad_workspace' }); req.workspaceId = id; return next(); };
  const bodyOf = (req) => (isObj(req.body) ? req.body : {});

  api.get('/story', (req, res) => { noStore(res); res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => { noStore(res); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  api.get('/info', (_req, res) => { noStore(res); res.json({ mode: defaultMode(), modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });

  api.get('/state', workspace, (req, res) => {
    const id = req.workspaceId;
    noStore(res);
    const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const vertical = verticalOf(req);
    if (mode === 'mock') return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario) });
    return res.json({ mode, vertical, workspace: id, state: liveState(id, workspaces, vertical, castFor(req)) });
  });

  // Read-only: the same checks and routing as a real request, creating nothing. Mock uses a fresh engine, Live the workspace's own.
  api.post('/preview', workspace, (req, res) => {
    const id = req.workspaceId;
    noStore(res);
    if (overBounds(req.body)) return res.status(413).json({ error: 'payload_too_large', detail: TOO_BIG });
    const body = bodyOf(req);
    const mode = modeOf(body.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const e = mode === 'mock' ? new Engine(castFor(req)) : workspaces.engine(id, verticalOf(req), castFor(req));
    return res.json({ workspace: id, mode, preview: e.preview(body.request) });
  });

  // Every write: Live only, strict top-level keys, one trace, hops, and the whole fresh state back.
  const write = (method, route, { op, keys, params }) => {
    api[method](route, workspace, (req, res, next) => {
      const id = req.workspaceId;
      noStore(res);
      try {
        if (!isObj(req.body)) return res.status(400).json({ error: 'bad_request' });
        // A text, a key, a list, an object or a nesting over a bound (bounds.js), in the body or in the path, is refused whole before anything runs.
        if (overBounds(req.body) || overBounds(req.params)) return res.status(413).json({ error: 'payload_too_large', detail: TOO_BIG });
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
  // A path id has a known shape (req-0001, pol-code-write). One that does not is never used or echoed as typed: it becomes the mark, and the engine answers
  // its fixed 404 for an unknown id. (The masker cannot judge a one-character secret in a path; the shape can.)
  const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const idParam = (req) => (typeof req.params.id === 'string' && ID_SHAPE.test(req.params.id) ? req.params.id : '[masked]');
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
  api.post('/reset', workspace, (req, res) => { const id = req.workspaceId; noStore(res); workspaces.reset(id); return res.json({ reset: 'ok', workspace: id }); });
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  // Outside /api only a GET or HEAD can succeed: a write to the page is 405 (Allow) on "/" and a JSON 404 anywhere else.
  const hasShell = fs.existsSync(path.join(webDist, 'index.html'));
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return hasShell && req.path === '/' ? res.set('Allow', 'GET, HEAD').status(405).json({ error: 'method_not_allowed' }) : res.status(404).json({ error: 'not_found' });
  });
  if (hasShell) {
    // express.static answers real files only (dotfiles ignored, no directory index) and falls through otherwise.
app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
    app.use(express.static(webDist, { redirect: false, index: false, dotfiles: 'ignore', fallthrough: true }));
    // 4. The app shell is for PAGE ADDRESSES only (isPageAddress, shared/hygiene.js): a GET or HEAD of a path with no extension, no dot segment, no empty
    //    segment and not under assets/static/api. /assets, /assets/, /assets/x.js, /favicon.ico, /robots.txt, /foo.map, /.env, /% and /%zz are not page
    //    addresses, so a missing asset is a JSON 404, never a 200 HTML page that a script would try to run.
    app.use((req, res, next) => (isPageAddress(req.path) ? res.sendFile(path.join(webDist, 'index.html')) : next()));
  }
  // 5. The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an
  //    HTML stack trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path, no message, no stack, no log.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (res.headersSent) return res.end();
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code });
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status === 415) return res.status(415).json({ error: 'unsupported_charset' });
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
