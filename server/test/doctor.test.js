import test from 'node:test';
import assert from 'node:assert/strict';
import { allPassed, runChecks } from '../src/doctor.js';
import { MOCK_TABLE } from '../src/mockTable.js';

test('every doctor check passes on a clean default environment', async () => {
  const c = await runChecks({ env: { HOME: '/nonexistent' } });
  assert.ok(allPassed(c), JSON.stringify(c.filter((x) => x.level === 'fail')));
  for (const id of ['node', 'mode', 'bind', 'port-range', 'settings-file', 'policies', 'catalog', 'scenarios', 'mock-table', 'receipts', 'story-tokens', 'verticals', 'story-hosts', 'story-keys', 'masking', 'diagrams', 'netguard', 'tenant']) assert.ok(c.some((x) => x.id === id), id);
});

test('a port outside 7250-7299 fails, and a wildcard bind needs the opt-in', async () => {
  for (const p of ['5010', '7200', '7249', '7300']) assert.equal((await runChecks({ env: { PORT: p } })).find((c) => c.id === 'port-range').level, 'fail', p);
  assert.equal((await runChecks({ env: { PORT: '7259' } })).find((c) => c.id === 'port-range').level, 'pass');
  assert.equal((await runChecks({ env: { PORT: '7259', SALAB_BIND: '0.0.0.0' } })).find((c) => c.id === 'bind').level, 'pass');
});

test('the mode must be mock or live; mock is the default; a bare MODE (another app\'s) is ignored', async () => {
  assert.equal((await runChecks({ env: { SAL_LAB_MODE: 'prod' } })).find((c) => c.id === 'mode').level, 'fail');
  assert.equal((await runChecks({ env: { SAL_LAB_MODE: 'live' } })).find((c) => c.id === 'mode').level, 'pass');
  const { modeFrom } = await import('../src/config.js');
  assert.equal(modeFrom({}), 'mock'); assert.equal(modeFrom({ MODE: 'live' }), 'mock'); assert.equal(modeFrom({ SAL_LAB_MODE: 'live' }), 'live');
  assert.throws(() => modeFrom({ SAL_LAB_MODE: 'prod' }), /not available/);
});

test('a drifting Mock table fails the doctor and says how to fix it', async () => {
  const bad = JSON.parse(JSON.stringify(MOCK_TABLE)); bad.verticals.finance.scenarios[0].state.grants[0].status = 'active';
  const c = (await runChecks({ table: bad })).find((x) => x.id === 'mock-table');
  assert.equal(c.level, 'fail'); assert.match(c.detail, /npm run mock-table/);
});

test('the settings file: absent is fine, a world-readable one is flagged, its values are never printed', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-env-'));
  const f = path.join(dir, '.env'); fs.writeFileSync(f, 'SECRET_THING=hunter2hunter2\n', { mode: 0o644 });
  try {
    const c = (await runChecks({ env: { STANDALONE_ENV: f } })).find((x) => x.id === 'settings-file');
    assert.equal(c.level, 'info'); assert.ok(!JSON.stringify(c).includes('hunter2'));
    fs.chmodSync(f, 0o600);
    assert.equal((await runChecks({ env: { STANDALONE_ENV: f } })).find((x) => x.id === 'settings-file').level, 'pass');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('story-keys fails when ANY vertical\'s story holds a credential-shaped value (the response mask would change it)', async () => {
  const { VERTICALS } = await import('../src/cast.js');
  const keep = VERTICALS.health.castBrand;
  try {
    VERTICALS.health.castBrand = `Contoso ${['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('')}`;
    const c = (await runChecks({ env: { HOME: '/nonexistent' } })).find((x) => x.id === 'story-keys');
    assert.equal(c.level, 'fail'); assert.match(c.detail, /credential-shaped/);
  } finally { VERTICALS.health.castBrand = keep; }
  assert.equal((await runChecks({ env: { HOME: '/nonexistent' } })).find((x) => x.id === 'story-keys').level, 'pass');
});
