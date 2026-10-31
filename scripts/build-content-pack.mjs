// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
// The pack uses .invalid placeholders and no documentation URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const UNV = 'Ping release claim, UNVERIFIED on our tenant.';

export function buildPack() {
  const story = buildStory(DEFAULT_CAST, 'finance');
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = {
    'warehouse-role': ['jit-access', 'approval-chain', 'reaper'], 'self-approval': ['self-approval', 'approval-chain'], 'auto-approve': ['auto-approval', 'jit-access', 'reaper'],
    overlap: ['reference-count', 'receipt', 'reaper'], 'agent-and-human': ['one-model', 'receipt'], drift: ['drift', 'reaper', 'receipt'],
  };
  const why = (id) => story.talkTrack.find((t) => t.id === id).say;
  return {
    schema: 'demo-content-pack/1',
    id: 'saas-access-lab',
    title: 'SaaS Access LAB',
    version,
    demo: { id: 'saas-access-lab', name: 'SaaS Access LAB', catalog: 'D104', baseUrl: 'http://localhost:7250', doctor: '/api/health', tags: ['saas-access', 'jit', 'time-bound', 'approval', 'reaper', 'drift', 'receipts', 'simulated'] },
    glossary: [
      { id: 'jit-access', term: 'Just-in-time, time-bound access', definition: `Access to the systems engineers use (GitHub, GitLab, Salesforce, Snowflake, Databricks, Google Workspace) that is requested, approved, time-bound and removed automatically, with a receipt for every grant. ${UNV}`, aliases: ['JIT access', 'SaaS Access Management'] },
      { id: 'approval-chain', term: 'Approval chain and routing', definition: `A policy has one to three approval levels; each level is a role (the manager, the resource owner, the security group, the data owner) routed to automatically. Approvers act directly from Slack or Mattermost; Teams, Jira and ServiceNow only receive notifications and tickets. The roles, the depth limit and how each resolves to a person are the lab's own reading. ${UNV}`, aliases: ['routing'] },
      { id: 'self-approval', term: 'Self-approval blocked', definition: `The person who made a request cannot approve it, an agent cannot approve anything, and an expired request cannot be approved. In the lab self-approval is not a setting: no policy edit can switch it off. ${UNV}`, aliases: ['approver cannot approve their own request'] },
      { id: 'auto-approval', term: 'Auto-approval by policy', definition: `A policy can approve a request by itself when its level and window fit a rule (enabled, up to a level, up to a number of minutes). The decision is recorded as made by the policy. The rule's shape is lab-invented. ${UNV}`, aliases: [] },
      { id: 'reaper', term: 'The reaper', definition: `Every grant carries an expiry. A reaper reconciles continuously and removes access from the platform when the window closes, even if the original grant workflow is long finished. In the lab it wakes every 5 lab minutes and at the end of every clock move (lab-invented). ${UNV}`, aliases: ['expiry', 'removal at expiry'] },
      { id: 'receipt', term: 'Receipt', definition: `Every grant is recorded. The lab chains its receipts (each hashes its own fields and the hash of the one before, and a count and head hash are kept beside them) so editing, reordering or dropping receipts is detected; without a key or an external anchor, someone who can rewrite both can forge the chain. The product's receipt format is not public, so all of this is LAB-INVENTED. ${UNV}`, aliases: ['grant record'] },
      { id: 'reference-count', term: 'Reference counting', definition: `When several policies grant the same access to the same subject, the grants are reference-counted: the platform keeps the access, at the highest level any of them gives, until the last one ends. Removing one policy must not remove access another still grants. ${UNV}`, aliases: ['overlapping policies'] },
      { id: 'drift', term: 'Drift detection', definition: `Every grant is reconciled against the platform nightly to surface access granted outside Privilege. The lab flags four kinds (unrecorded, elevated, missing, reduced); the kinds, the 02:00 lab-clock time and the remediation are lab-invented. ${UNV}`, aliases: ['nightly reconcile', 'out-of-band access'] },
      { id: 'one-model', term: 'One model for people and agents', definition: `An engineer asking for a warehouse role and an agent asking for a peer's capability are the same request, approval, expiry and revoke cycle, recorded the same way in one audit trail: the difference is only the subject. ${UNV}`, aliases: ['human and agent'] },
      { id: 'lab-clock', term: 'The lab clock', definition: 'A clock the visitor advances (+15 minutes, +1 hour, +1 day) so expiry, the reaper and the nightly reconcile can be seen. It only moves forward. Lab-invented.', aliases: [] },
      { id: 'hitl-flag', term: 'Hitl and the approver-facing integrations', definition: `The console schema (2026-10-31, schema only) gives Hitl to the Slack integration, the Jira project and the ServiceNow table, and Sync to the Databricks, Salesforce and Snowflake account objects. The lab uses them as switches (where approval requests go; whether the reconcile reads a platform): how they behave in the product is not known. ${UNV}`, aliases: ['Sync', 'ApproverNotifications', 'RetiredAt'] },
    ],
    sources: [
      { id: 'deck-slides', title: 'Ping ID4AI Workforce H2 2026 deck, slides 35 and 51', url: 'https://example.invalid/ping-id4ai-workforce-h2-2026-deck', kind: 'deck', use: 'The SaaS Access Management release claims.', status: 'read', checked: '2026-10-31' },
      { id: 'console-swagger', title: 'Privilege console swagger, 2026-10-31 (schema only)', url: 'https://example.invalid/privilege-console-swagger', kind: 'schema', use: 'Field names for Sync, Hitl, ApproverNotifications, RetiredAt and the approval fields. It proves names exist, not behaviour.', status: 'read', checked: '2026-10-31' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.say, group: 'try-it', action: { type: 'route', href: '/#request' }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'try-approvals', label: 'Approve as the wrong person', description: 'Act as the requester, an agent or someone not routed to the level: the lab refuses and says why.', group: 'try-it', action: { type: 'route', href: '/#approvals' }, terms: ['self-approval', 'approval-chain'] },
      { id: 'try-clock', label: 'Move the lab clock', description: 'Advance +15 minutes, +1 hour or +1 day and watch the reaper remove the access and the receipts chain.', group: 'try-it', action: { type: 'route', href: '/#timeline' }, terms: ['reaper', 'receipt', 'lab-clock'] },
      { id: 'try-drift', label: 'Change a platform by hand', description: 'Grant access outside Privilege, then reconcile: the finding names the platform, the person and the level.', group: 'try-it', action: { type: 'route', href: '/#drift' }, terms: ['drift'] },
      { id: 'concept-why-saas-access', label: 'Why it matters: SaaS Access Management (slide 51)', description: why('why-saas-access'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['jit-access', 'reaper', 'drift', 'one-model'] },
      { id: 'concept-platforms', label: 'Six platforms', description: 'What each grants and its auth method name (never a credential).', group: 'concept', action: { type: 'route', href: '/#platforms' }, terms: ['jit-access', 'hitl-flag'] },
      { id: 'concept-diagram', label: 'Diagrams', description: 'Two diagrams: request to removal; and drift and reconcile.', group: 'concept', action: { type: 'route', href: '/#diagram' }, terms: ['reaper', 'drift'] },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.say })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
  console.log('wrote content-pack.json');
}
