// The header "Shelf" button needs GET /api/shelf to be reachable, here with no web build (withServer uses no webDist).
import test from 'node:test';
import assert from 'node:assert/strict';
import { get, post, withServer } from './helpers.js';

test('GET /api/shelf returns SHELF_URL with the trailing slash trimmed, and a POST is refused', async () => {
  const saved = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  try {
    await withServer(async (url) => {
      const r = await get(url, '/api/shelf');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
      assert.notEqual((await post(url, '/api/shelf', {})).status, 200);
    });
  } finally {
    if (saved === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = saved;
  }
});
