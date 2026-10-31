// Scripted scenarios: data (with names from the cast) run through the real engine. The Mock tables are generated from this by
// `npm run mock-table`, so Mock cannot show anything the engine would not do (a doctor check and a test fail on drift).
import { Engine } from './engine.js';
import { VERTICALS } from './cast.js';
import { perform } from './actions.js';

const req = (c, o) => ({ op: 'request', params: { requestedBy: c.castEngineer, subjectKind: 'human', subjectId: c.castEngineer, ...o } });
const ok = (approver, requestId, via = 'console') => ({ op: 'decide', params: { requestId, approver, decision: 'approve', via } });

export function scenarioList(c) {
  return [
    {
      id: 'warehouse-role', title: 'An engineer asks for a warehouse role',
      say: 'Two approval levels route to the data owner and then to the security group; every grant carries an expiry; the reaper removes the role when the window closes.',
      steps: [
        { say: `${c.castEngineer} asks for ${c.castRole2} on Snowflake for 4 hours to run ${c.castWarehouse}.`, ...req(c, { platform: 'snowflake', resource: 'snow-role-writer', level: 'member', durationMin: 240, policyId: 'pol-warehouse', reason: `Run ${c.castWarehouse}` }) },
        { say: `Level 1 is routed to ${c.castDataOwner}, the owner of the role. ${c.castDataOwner} approves in Slack.`, ...ok(c.castDataOwner, 'req-0001', 'slack') },
        { say: `Level 2 is routed to the security group. ${c.castSecLead} approves in the console. The grant and its receipt are written and the role is granted on the platform.`, ...ok(c.castSecLead, 'req-0001') },
        { say: 'Four hours and a bit later the lab clock moves on. The reaper removes the role on the platform even though the request workflow finished hours ago.', op: 'advance', params: { minutes: 245 } },
        { say: 'The nightly reconcile compares the platform with the receipts: no drift.', op: 'reconcile', params: {} },
      ],
    },
    {
      id: 'self-approval', title: 'Self-approval is refused',
      say: `${c.castSecLead} asks for access during ${c.castIncident} and tries to approve their own request. The lab refuses, and says why. A colleague in the security group approves.`,
      steps: [
        { say: `${c.castSecLead} asks for write on ${c.castRepo} for 2 hours under the incident policy.`, op: 'request', params: { requestedBy: c.castSecLead, subjectKind: 'human', subjectId: c.castSecLead, platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 120, policyId: 'pol-incident', reason: `Fix for ${c.castIncident}` } },
        { say: `${c.castSecLead} is in the security group, so the request was routed to them, and tries to approve it.`, op: 'decide', params: { requestId: 'req-0001', approver: c.castSecLead, decision: 'approve', via: 'console' } },
        { say: 'An agent tries to approve it too. Approvers are people.', op: 'decide', params: { requestId: 'req-0001', approver: c.castAgent, decision: 'approve', via: 'console' } },
        { say: `Someone who is not routed to this level (${c.castEngineer}) tries.`, op: 'decide', params: { requestId: 'req-0001', approver: c.castEngineer, decision: 'approve', via: 'console' } },
        { say: `${c.castSecLead2}, the other member of the security group, approves from Slack.`, ...ok(c.castSecLead2, 'req-0001', 'slack') },
        { say: 'The same approval again is refused: the request is already decided.', ...ok(c.castSecLead2, 'req-0001') },
      ],
    },
    {
      id: 'auto-approve', title: 'Low-risk access is approved by policy',
      say: 'Read access for up to two hours is approved by the policy itself, recorded as such, and still removed on time.',
      steps: [
        { say: `${c.castEngineer} asks for read on ${c.castRepo} for one hour. The policy auto-approves it: the decision is recorded as made by the policy.`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'read', durationMin: 60, policyId: 'pol-code-read', reason: 'Read the code before the review' }) },
        { say: `The same person asks for write under the read policy: refused, the level is above what the policy may grant.`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 60, policyId: 'pol-code-read', reason: 'Edit the code' }) },
        { say: `A request without an expiry (a string for the duration) is refused: every grant carries one.`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'read', durationMin: '60', policyId: 'pol-code-read' }) },
        { say: 'An hour later the reaper removes the access.', op: 'advance', params: { minutes: 61 } },
      ],
    },
    {
      id: 'overlap', title: 'Two policies grant the same access',
      say: 'A routine write grant and an incident grant overlap on the same repository. When the shorter one ends, the access stays, because the other policy still grants it. It goes only when the last reference does.',
      steps: [
        { say: `${c.castEngineer} asks for write on ${c.castRepo} for 8 hours under the routine write policy (manager, then owner).`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 480, policyId: 'pol-code-write', reason: 'Feature work' }) },
        { say: `${c.castManager} approves level 1.`, ...ok(c.castManager, 'req-0001') },
        { say: `${c.castOwner} approves level 2. Write is granted (1 reference).`, ...ok(c.castOwner, 'req-0001') },
        { say: `${c.castIncident} starts. ${c.castEngineer} asks for write under the incident policy for one hour.`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'write', durationMin: 60, policyId: 'pol-incident', reason: `Fix for ${c.castIncident}` }) },
        { say: `${c.castSecLead} approves from Slack. The same access now has 2 references.`, ...ok(c.castSecLead, 'req-0002', 'slack') },
        { say: 'An hour later the incident grant ends. The platform still shows write: the routine grant holds the other reference.', op: 'advance', params: { minutes: 61 } },
      ],
    },
    {
      id: 'agent-and-human', title: 'An agent and an engineer, one model',
      say: 'An agent asks for a Unity Catalog privilege and an engineer asks for the same one. Same policy, same approval, same receipt, one audit trail: the only difference is the subject.',
      steps: [
        { say: `${c.castEngineer} asks for MODIFY on ${c.castSchema} for 2 hours.`, ...req(c, { platform: 'databricks', resource: 'dbx-schema-gold', level: 'MODIFY', durationMin: 120, policyId: 'pol-lakehouse', reason: 'Backfill a table' }) },
        { say: `${c.castAgent} (an agent, custodian ${c.castEngineer2}) asks for the same privilege for 2 hours.`, op: 'request', params: { requestedBy: c.castAgent, subjectKind: 'agent', subjectId: c.castAgent, platform: 'databricks', resource: 'dbx-schema-gold', level: 'MODIFY', durationMin: 120, policyId: 'pol-lakehouse', reason: 'Backfill a table' } },
        { say: `${c.castDataOwner} approves the engineer's request.`, ...ok(c.castDataOwner, 'req-0001') },
        { say: `${c.castDataOwner} approves the agent's request. The decision is recorded the same way.`, ...ok(c.castDataOwner, 'req-0002', 'slack') },
        { say: 'Two hours later both are removed by the same reaper.', op: 'advance', params: { minutes: 125 } },
      ],
    },
    {
      id: 'drift', title: 'Access granted outside Privilege',
      say: 'Someone grants access by hand on the platform. The reconcile finds it, a nightly run finds it again, and the reaper cannot remove it because it was never a grant.',
      steps: [
        { say: `${c.castEngineer} gets read on ${c.castRepo} for two hours by auto-approval.`, ...req(c, { platform: 'github', resource: 'gh-repo-core', level: 'read', durationMin: 120, policyId: 'pol-code-read', reason: 'Review' }) },
        { say: `An administrator raises ${c.castEngineer} to admin on the repository by hand, and gives ${c.castEngineer2} write on ${c.castInfraRepo}. Neither goes through Privilege.`, op: 'outOfBand', params: { op: 'grant', platform: 'github', resource: 'gh-repo-core', subjectKind: 'human', subjectId: c.castEngineer, level: 'admin' } },
        { say: '', op: 'outOfBand', params: { op: 'grant', platform: 'github', resource: 'gh-repo-infra', subjectKind: 'human', subjectId: c.castEngineer2, level: 'write' } },
        { say: 'The reconcile compares the platform with the receipts and flags both.', op: 'reconcile', params: {} },
        { say: 'A day later the nightly reconcile runs by itself. The read grant has expired, but the hand-made admin access stays: after the reaper, drift remains.', op: 'advance', params: { minutes: 1440 } },
      ],
    },
  ];
}
// The result each scripted step must give (a refusal is part of the story). The doctor and a test check this.
export const EXPECTED = {
  'warehouse-role': ['ok', 'ok', 'ok', 'ok', 'ok'],
  'self-approval': ['ok', 'self_approval_refused', 'approver_not_human', 'not_an_approver', 'ok', 'already_decided'],
  'auto-approve': ['ok', 'level_above_policy', 'bad_duration', 'ok'],
  overlap: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  'agent-and-human': ['ok', 'ok', 'ok', 'ok', 'ok'],
  drift: ['ok', 'ok', 'ok', 'ok', 'ok'],
};
export const SCENARIO_IDS = scenarioList(VERTICALS.finance).map((s) => s.id);

export function runScenario(cast, sc) {
  const e = new Engine(cast);
  const steps = sc.steps.map((st) => ({ say: st.say, op: st.op, params: st.params, result: perform(e, st.op, st.params), at: e.snapshot().clock }));
  return { e, steps };
}

const DYNAMIC = ['clock', 'requests', 'grants', 'holdings', 'receipts', 'platforms', 'diff', 'drift', 'audit', 'outbox'];
// The Mock table: per vertical, the static base (roster, policies, names) and per scenario its steps and the state at the end.
export function buildMockTable() {
  const out = { schema: 'saas-access-mock/1', verticals: {} };
  for (const [v, cast] of Object.entries(VERTICALS)) {
    const base = new Engine(cast).snapshot();
    const staticPart = Object.fromEntries(Object.entries(base).filter(([k]) => !DYNAMIC.includes(k)));
    const scenarios = scenarioList(cast).map((sc) => {
      const { e, steps } = runScenario(cast, sc);
      const snap = e.snapshot();
      return { id: sc.id, title: sc.title, say: sc.say, steps, state: Object.fromEntries(DYNAMIC.map((k) => [k, snap[k]])) };
    });
    out.verticals[v] = { base: staticPart, scenarios };
  }
  return JSON.parse(JSON.stringify(out));
}
