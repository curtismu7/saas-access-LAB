import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createWorkspaces } from '../src/workspaces.js';
import { Engine } from '../src/engine.js';
import { VERTICALS } from '../src/cast.js';

export const C = VERTICALS.finance;
export const newEngine = (cast = C) => new Engine(cast);

export async function withServer(fn, { configFile = '/nonexistent/customer.config.json', workspaces = createWorkspaces() } = {}) {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  await health.ready;
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, configFile, workspaces }) });
  try { await fn(url.replace(/\/$/, ''), { workspaces }); } finally { health.stop(); await new Promise((res) => server.close(res)); }
}

export const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const put = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const get = (url, path, headers = {}) => fetch(`${url}${path}`, { headers });
export const json = async (res) => res.json();

// fetch cannot set Host; node:http can.
export function rawHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

// Request bodies the tests reuse.
export const spec = (o = {}) => ({ requestedBy: C.castEngineer, subjectKind: 'human', subjectId: C.castEngineer, platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 60, policyId: 'pol-code-write', reason: 'work', ...o });
export const dec = (requestId, approver, o = {}) => ({ requestId, approver, decision: 'approve', via: 'console', ...o });
// A write in the pol-code-write policy: manager, then owner. Returns the request id after both approve.
export function grantWrite(e, o = {}) {
  const r = e.createRequest(spec(o));
  e.decide(dec(r.id, C.castManager)); e.decide(dec(r.id, C.castOwner));
  return r;
}
