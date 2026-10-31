import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_CAST, VERTICALS } from '../src/cast.js';
import { buildStory, renderTalkTrackMarkdown } from '../src/story.js';
import { BANNER, CLAIM_LABEL, FIELD_SOURCES, TALK_TRACK, WHY } from '../src/data.js';
import { maskDeep } from '../src/mask.js';
import { DIAGRAM_NAMES, buildDiagram, loadDiagram, rawDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';

test('the banner says it is simulated and a Ping claim UNVERIFIED on our tenant, and names its mode', () => {
  for (const [mode, re] of [['mock', /MOCK mode/], ['live', /LIVE mode/]]) {
    assert.match(BANNER[mode], /SIMULATED/); assert.match(BANNER[mode], re); assert.match(BANNER[mode], /UNVERIFIED on our tenant/);
  }
  assert.equal(CLAIM_LABEL, 'Ping release claim, UNVERIFIED on our tenant');
});

test('every field is tagged: console swagger name (schema only), lab reading or lab-invented', () => {
  assert.ok(FIELD_SOURCES.length >= 12);
  for (const f of FIELD_SOURCES) { assert.ok(['swagger', 'reading', 'invented'].includes(f.source), f.field); assert.ok(f.note.length > 30); }
  const sw = FIELD_SOURCES.filter((f) => f.source === 'swagger').map((f) => f.field).join(' ');
  for (const name of ['Sync', 'Hitl', 'ApproverNotifications', 'RetiredAt', 'WorkspaceID', 'EnableSSO', 'SSOUrl', 'TokenOwner', 'ParentTeamId', 'NotificationSetting', 'ExpiresAt']) assert.ok(sw.includes(name), name);
  const story = buildStory(DEFAULT_CAST, 'finance');
  assert.ok(story.fieldSources.every((f) => f.sourceLabel));
  assert.ok(story.fieldSources.some((f) => f.sourceLabel === 'console swagger name (schema only)'));
});

test('the story is the deck\'s claims and never says "door"; the platforms and their auth METHOD names are the deck\'s', () => {
  const s = buildStory(DEFAULT_CAST, 'finance');
  assert.deepEqual(s.platforms.map((p) => p.name), ['GitHub', 'GitLab', 'Salesforce', 'Snowflake', 'Databricks', 'Google Workspace']);
  assert.deepEqual(s.platforms.map((p) => p.authMethod), ['personal access token', 'administrator token', 'OAuth JWT bearer with a connected app', 'key-pair authentication', 'OAuth service principal', 'service account with domain-wide delegation']);
  assert.ok(!/\bdoor\b/i.test(JSON.stringify(s)));
  assert.ok(s.claims.every((c) => c.slide === 51 || c.slide === 35));
  assert.ok(s.notDemonstrated.some((n) => /team-to-repository/i.test(n) && /profile/i.test(n)));
});

test('the talk track has the Why it matters entry (challenge, technical, business), marked as Ping claims', () => {
  const t = TALK_TRACK.find((x) => x.id === 'why-saas-access');
  for (const part of ['Challenge:', 'Technical:', 'Business:']) assert.match(t.say, new RegExp(part));
  assert.match(t.say, /Ping claims, unverified on our tenant/);
  assert.match(WHY.technical, /six platforms/); assert.match(WHY.challenge, /who still holds what/);
});

test('docs/talk-track.md is exactly what the generator makes (no drift)', () => {
  const file = new URL('../../docs/talk-track.md', import.meta.url);
  assert.equal(fs.readFileSync(file, 'utf8'), renderTalkTrackMarkdown(DEFAULT_CAST));
  assert.ok(!/\{\{/.test(fs.readFileSync(file, 'utf8')));
});

test('the response mask leaves every vertical\'s story untouched (it must only change credential-shaped values)', () => {
  for (const [v, c] of Object.entries(VERTICALS)) { const s = buildStory(c, v); assert.deepEqual(maskDeep(s), s, v); }
});

test('the diagrams are diagram-studio/1 data, valid, loaded by name, with no overlapping node positions', () => {
  assert.deepEqual(DIAGRAM_NAMES, ['request-to-removal', 'drift-and-reconcile']);
  for (const n of DIAGRAM_NAMES) {
    assert.deepEqual(validateDiagram(loadDiagram(n)), []);
    const d = rawDiagram(n);
    assert.equal(d.schema, 'diagram-studio/1');
    const boxes = d.nodes.map((x) => ({ x: x.x, y: x.y })); // a box is about 230 by 100
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(Math.abs(boxes[i].x - boxes[j].x) >= 260 || Math.abs(boxes[i].y - boxes[j].y) >= 130, `${n}: ${d.nodes[i].id} and ${d.nodes[j].id} overlap`);
    assert.equal(d.steps.length, d.edges.length, 'every edge is a step');
    const b = buildDiagram(DEFAULT_CAST, n);
    assert.ok(b.steps.every((s) => s.label.length <= 24), 'edge labels are short enough not to collide');
    assert.ok(!/\{\{/.test(JSON.stringify(b)));
  }
  assert.equal(buildDiagram(DEFAULT_CAST, 'nope').name, 'request-to-removal', 'an unknown name falls back');
  assert.ok(validateDiagram({ ...rawDiagram('request-to-removal'), schema: 'x' }).length > 0);
});

test('the diagram says P1 Privilege Agent App where it names the gateway app (never "door")', () => {
  for (const n of DIAGRAM_NAMES) assert.ok(!/\bdoor\b/i.test(JSON.stringify(rawDiagram(n))));
});
