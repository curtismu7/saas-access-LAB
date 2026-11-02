// False positives the app itself would produce: everything the lab writes (the state, every hop, the outbox, the receipts, the story, the diagrams, the Mock
// table) goes through the response mask, and must come out exactly as written. Replays all 6 scripted scenarios in all 3 verticals through the same code the
// API uses (service.runAction) and checks every step's state and hops; then the constants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERTICALS } from '../src/cast.js';
import { scenarioList } from '../src/scenarios.js';
import { mockState, runAction } from '../src/service.js';
import { createWorkspaces } from '../src/workspaces.js';
import { maskDeep } from '../src/mask.js';
import { buildStory } from '../src/story.js';
import { DIAGRAM_NAMES, buildDiagram } from '../src/diagramData.js';
import { MOCK_TABLE } from '../src/mockTable.js';

const same = (a, b, what) => assert.equal(JSON.stringify(a), JSON.stringify(b), what);

test('the response mask changes nothing the lab writes itself: 18 scenario replays, every step, state and hops', () => {
  let steps = 0; let hops = 0; let replays = 0;
  for (const [vertical, cast] of Object.entries(VERTICALS)) {
    for (const sc of scenarioList(cast)) {
      const workspaces = createWorkspaces(); replays += 1;
      for (const st of sc.steps) {
        const r = runAction({ ws: 'w-own-output', workspaces, vertical, cast, op: st.op, params: st.params, route: { method: 'POST', url: '/api/x' } });
        const answer = { hops: r.hops, traceId: r.traceId, state: r.state, outcome: r.outcome };
        same(maskDeep(answer), answer, `${vertical}/${sc.id} ${st.op}`);
        steps += 1; hops += r.hops.length;
      }
    }
  }
  assert.equal(replays, 18);
  assert.ok(steps > 60 && hops > 150, `${steps} steps, ${hops} hops`);
});

test('the response mask changes nothing in the story, the diagrams or the Mock table, in every vertical', () => {
  for (const [vertical, cast] of Object.entries(VERTICALS)) {
    const story = buildStory(cast, vertical); same(maskDeep(story), story, `story ${vertical}`);
    for (const n of DIAGRAM_NAMES) { const d = buildDiagram(cast, n); same(maskDeep(d), d, `diagram ${vertical}/${n}`); }
  }
  // the Mock answer is {state, scenario, scenarios} (service.mockState): every scenario of every vertical
  let n = 0;
  for (const vertical of Object.keys(VERTICALS)) for (const sc of MOCK_TABLE.verticals[vertical].scenarios) { const m = mockState(MOCK_TABLE, vertical, sc.id); same(maskDeep(m), m, `mock ${vertical}/${sc.id}`); n += 1; }
  assert.equal(n, 18);
});

test('the two path exceptions are exact: state.holdings.N.key and claims.N.claim at the root only', () => {
  const key = 'github|gh-repo-core|human:lee.park'; const claim = 'personal access token; GitHub Enterprise Server supported';
  same(maskDeep({ state: { holdings: [{ key }] } }), { state: { holdings: [{ key }] } }, 'the holdings key at its place');
  same(maskDeep({ claims: [{ claim }] }), { claims: [{ claim }] }, 'the claim at its place');
  // anywhere else the same text is masked (a visitor cannot use the exception: their text is echoed under hops.N.request.body...)
  assert.notEqual(maskDeep({ hops: [{ request: { body: { key } } }] }).hops[0].request.body.key, key);
  assert.notEqual(maskDeep({ hops: [{ request: { body: { claim } } }] }).hops[0].request.body.claim, claim);
  assert.notEqual(maskDeep({ x: { state: { holdings: [{ key }] } } }).x.state.holdings[0].key, key, 'not at the root: not exempt');
  assert.notEqual(maskDeep({ state: { holdings: [{ key }], other: { key } } }).state.other.key, key, 'only state.holdings.N.key');
});
