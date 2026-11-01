// The workspace id rule lives twice: on the server (it refuses) and in the page (it chooses and checks what it kept). Both must say the same thing about
// every id the page could hold, so this compares them on a table. (The server also refuses anything its masker would change; the page cannot run
// that, and relies on the server's 400 bad_workspace plus one retry. The table below holds only ids both sides can judge the same way.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validWorkspaceId as server } from '../server/src/workspaces.js';
import { validWorkspaceId as page, freshId } from '../web/src/workspace.js';

const HEX = 'a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097';
const TABLE = [
  ['default', true], ['w-0123456789abcdef', true], ['ws-a', true], ['a', true], ['parity-warehouse-role', true], ['passing-review', true], ['tokens-x', true], ['tab-1', true],
  [`${'a'.repeat(19)}-${'b'.repeat(20)}`, true], ['x'.repeat(19) + '-' + 'y'.repeat(20), true],
  ['pw-hunter2xyz', false], ['sk-abcdefghijklmnop1234', false], ['pass-x', false], ['token-x', false], ['secret-x', false], ['password', false], ['bearer-1', false], ['ghp-abc', false], ['glpat-abc', false],
  ['xoxb-1', false], ['akia-1', false], ['asia-1', false], ['apikey-1', false], ['pwd', false], ['passphrase-a', false], ['a-pk-b', false], ['rk-1', false],
  [HEX, false], [HEX.slice(0, 24), false], ['abcdefabcdefabcdefabcdef', false], ['abcdefabcdefabcdefabcde', true], ['eyjhbgcioijiuzi', false], ['eyhbgcioijiuzi', true], [`w-${HEX}`.slice(0, 40), false], ['eyjhbgcioijiuzi1nij9', false],
  ['x'.repeat(41), false], ['', false], ['A', false], ['a_b', false], ['a b', false], ['a/b', false], ['__proto__', false],
];

test('the page and the server agree on every id in the table', () => {
  for (const [id, ok] of TABLE) {
    assert.equal(page(id), ok, `page: ${id}`);
    assert.equal(server(id), ok, `server: ${id}`);
  }
});

test('every id the page makes is valid for the server, has a letter, and is 18 characters (1000 draws)', () => {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    for (let i = 0; i < 1000; i += 1) { const id = freshId(); assert.ok(server(id) && page(id), id); assert.ok(/[a-z]/.test(id)); assert.equal(id.length, 18); }
  } finally { delete globalThis.window; }
});
