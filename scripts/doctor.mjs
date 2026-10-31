// Preflight: the same checks GET /api/health reports from, plus whether the port is free, plus one real run of the engine through the HTTP API
// (a request, two approvals, the lab clock, the reaper) on a throwaway port. Prints only pass/fail lines, never a setting's value. Exit 1 on failure.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)));
const { installNetguard } = await load('server/src/netguard.js');
installNetguard();
const { applySharedSettings } = await load('server/src/settings.js');
applySharedSettings();

const { runChecks } = await load('server/src/doctor.js');
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };
for (const c of await runChecks()) report(c.level, c.id, c.detail);

// A real cycle through the HTTP layer, in this process, on an ephemeral loopback port.
try {
  const { createApp, startHttpServer } = await load('server/src/app.js');
  const { createHealth } = await load('server/src/health.js');
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health }) });
  try {
    const base = url.replace(/\/$/, ''); const h = { 'content-type': 'application/json', origin: base, 'x-workspace': 'doctor' };
    const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'live', vertical: 'finance', ...b }) })).json();
    const cast = (await (await fetch(`${base}/api/story?vertical=finance`)).json()).cast;
    const r = await post('/api/requests', { request: { requestedBy: cast.castEngineer, subjectKind: 'human', subjectId: cast.castEngineer, platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 30, policyId: 'pol-code-write', reason: 'doctor' } });
    await post(`/api/requests/${r.result.requestId}/decision`, { decision: { approver: cast.castManager, decision: 'approve' } });
    const g = await post(`/api/requests/${r.result.requestId}/decision`, { decision: { approver: cast.castOwner, decision: 'approve' } });
    const self = await post(`/api/requests/${r.result.requestId}/decision`, { decision: { approver: cast.castEngineer, decision: 'approve' } });
    const adv = await post('/api/clock', { clock: { minutes: 31 } });
    const members = adv.state.platforms[0].groups[0].members.length;
    const ok = g.result?.status === 'granted' && self.error === 'already_decided' && adv.result.reaped.length === 1 && members === 0 && adv.state.receipts.verify.ok;
    report(ok ? 'pass' : 'fail', 'engine-cycle', ok ? 'a request, two approvals, a grant on the platform, then the reaper removed it when the lab clock passed the expiry; the receipt chain verifies' : 'the request, approve, expire, reap cycle did not complete');
  } finally { health.stop(); await new Promise((res) => server.close(res)); }
} catch { report('fail', 'engine-cycle', 'the HTTP cycle could not run'); }

const port = Number(process.env.PORT) || 7250;
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => { report('fail', 'port-free', `${port} is not free (${e.code}). Set PORT to a free port in 7250-7299`); resolve(); });
  s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${port} is free`); resolve(); }));
});
process.exit(failed ? 1 : 0);
