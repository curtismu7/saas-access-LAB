// Rule 27: the vendored run-observability panel is byte-for-byte the canonical one (checkPin), and this lab, which reads no log, names no
// RUN_OBS_ variable outside the vendored files. The vendored core (server/src/runObservability.js) is matched by its exact path only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = new Set(['server/src/runObservability.js']);

function filesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the vendored run-observability files match the pin (checkPin returns no problems)', () => {
  assert.deepEqual(checkPin(ROOT), []);
});

test('no RUN_OBS_ name appears in this lab outside the vendored files (the lab reads no logs)', () => {
  const hits = [];
  for (const dir of ['server/src', 'web/src']) {
    for (const file of filesUnder(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (VENDORED.has(rel) || rel.startsWith('web/src/run-observability/')) continue;
      if (fs.readFileSync(file, 'utf8').includes('RUN_OBS_')) hits.push(rel);
    }
  }
  assert.deepEqual(hits, []);
});

test('the lab vendors the core only: no readers file and no file of this lab names a log reader', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'server/src/runObservabilityReaders.js')), false);
  for (const file of filesUnder(path.join(ROOT, 'server/src'))) {
    if (VENDORED.has(path.relative(ROOT, file).split(path.sep).join('/'))) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /runObservabilityReaders|ElasticsearchReader|readersFromEnv/, path.relative(ROOT, file));
  }
});
