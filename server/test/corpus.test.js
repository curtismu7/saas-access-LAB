// The shared-masker corpora (copied from shared-masker 9bc664a, test/corpus/) run through THIS app's adapter (credentials.js / mask.js, with the lab's
// own plain mark and opaque exceptions): every probe in leaks.json must come out without its secret, in every position the app uses (stored text, response
// value, response key), and every string in ordinary.json must come out unchanged. Probes are stored as short fragments (gitleaks) and joined here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cleanFree, looksLikeCredential, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');
const leaks = JSON.parse(readFileSync(path.join(dir, 'leaks.json'), 'utf8'));
const ordinary = JSON.parse(readFileSync(path.join(dir, 'ordinary.json'), 'utf8'));
const join = (a) => a.join('');
const expand = (row) => `${row.fillBefore ? `${'a'.repeat(row.fillBefore)} ` : ''}${join(row.input)}${row.fillAfter ? ` ${'a'.repeat(row.fillAfter)}` : ''}`;
const plainLeaks = leaks.filter((r) => r.api !== 'deep');
const deepLeaks = leaks.filter((r) => r.api === 'deep');

test('corpus sizes are the shared ones: 3754 leak probes (3 deep... see below) and 1926 ordinary strings', () => {
  assert.equal(leaks.length, 3754);
  assert.equal(ordinary.length, 1926);
  assert.ok(deepLeaks.length >= 60, `${deepLeaks.length} structured probes`);
});

test('leaks.json: the secret never survives the adapter (maskText and cleanFree, the stored form)', () => {
  const failures = [];
  for (const row of plainLeaks) {
    const input = expand(row); const secret = join(row.secret);
    const out = maskText(input);
    if (out.includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} maskText`);
    else if (!looksLikeCredential(input)) failures.push(`${row.id} ${row.family}/${row.enc} looksLikeCredential false`);
    if (cleanFree(input).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} cleanFree`);
    if (out.includes('[masked') === false) failures.push(`${row.id} no mark`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${plainLeaks.length}:\n${failures.slice(0, 30).join('\n')}`);
});

test('leaks.json: structured probes lose the secret through the response mask', () => {
  const failures = [];
  for (const row of deepLeaks) {
    const value = JSON.parse(join(row.input)); const secret = join(row.secret);
    if (JSON.stringify(maskDeep(value)).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc}`);
  }
  assert.deepEqual(failures, [], failures.slice(0, 30).join('\n'));
});

test('leaks.json: the secret never survives as a response value or as a response key either', () => {
  const failures = [];
  for (const row of plainLeaks) {
    const input = expand(row);
    if (input.length > 5000) continue;
    const secret = join(row.secret);
    if (JSON.stringify(maskDeep({ note: input, list: [input] })).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} as a value`);
    if (JSON.stringify(maskDeep({ [input]: 1 })).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} as a key`);
  }
  assert.deepEqual(failures, [], `${failures.length}:\n${failures.slice(0, 30).join('\n')}`);
});

test('ordinary.json: every string stays unchanged through the adapter (maskText and the response mask)', () => {
  const changed = [];
  for (const row of ordinary) {
    const input = join(row.input);
    if (row.api === 'deep') { const value = JSON.parse(input); assert.deepEqual(maskDeep(value), value, `${row.id} ${input}`); continue; }
    if (maskText(input) !== input) changed.push(`${row.id} ${JSON.stringify(input)} -> ${JSON.stringify(maskText(input))}`);
    if (looksLikeCredential(input)) changed.push(`${row.id} looksLikeCredential true for ${JSON.stringify(input)}`);
    const viaDeep = maskDeep({ note: input }).note;
    if (viaDeep !== input) changed.push(`${row.id} response mask ${JSON.stringify(input)} -> ${JSON.stringify(viaDeep)}`);
  }
  assert.deepEqual(changed, [], `${changed.length} of ${ordinary.length} changed:\n${changed.slice(0, 30).join('\n')}`);
});
