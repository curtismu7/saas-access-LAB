// Access policies. A policy covers one platform and a list of its resources (all sharing one level scale), and says: the highest level it
// may grant, the longest window, the approval chain (1 to 3 levels, each a ROLE and a number of required approvals), whether the same person
// may satisfy two levels, the approval window, the chat channel approvers act from, and an optional auto-approve rule.
// Self-approval is NOT a field: it is always refused (deck slide 51). Every field here is LAB-INVENTED except where the story tags it otherwise.
import { RESOURCES, ROLES, rankOf } from './catalog.js';

export const LIMITS = { chainMin: 1, chainMax: 3, requiredMax: 2, durationMax: 10080, ttlMin: 5, ttlMax: 2880 };
export const CHANNELS = ['slack', 'mattermost'];

const A = (enabled, maxLevel, maxDurationMin) => ({ enabled, maxLevel, maxDurationMin });
const L = (role, required = 1) => ({ role, required });
export function defaultPolicies() {
  const P = (id, name, platform, resources, o) => ({ id, name, platform, resources, retired: false, requireDistinctApprovers: true, requestTtlMin: 120, channel: 'slack', autoApprove: A(false, resources.length ? RESOURCES[resources[0]].levels[0] : '', 0), ...o });
  return [
    P('pol-code-read', 'Read access to code', 'github', ['gh-repo-core', 'gh-repo-infra'], { maxLevel: 'read', maxDurationMin: 480, chain: [L('resource-owner')], autoApprove: A(true, 'read', 120) }),
    P('pol-code-write', 'Write access to code', 'github', ['gh-repo-core', 'gh-repo-infra'], { maxLevel: 'write', maxDurationMin: 480, chain: [L('manager'), L('resource-owner')] }),
    P('pol-incident', 'Incident response on code', 'github', ['gh-repo-core', 'gh-repo-infra'], { maxLevel: 'write', maxDurationMin: 240, chain: [L('security')], requestTtlMin: 30 }),
    P('pol-release-team', 'Release team membership', 'github', ['gh-team-releases'], { maxLevel: 'maintainer', maxDurationMin: 240, chain: [L('manager')], channel: 'mattermost' }),
    P('pol-gitlab', 'GitLab group and project access', 'gitlab', ['gl-group-platform', 'gl-project-service'], { maxLevel: 'maintainer', maxDurationMin: 480, chain: [L('manager')], autoApprove: A(true, 'reporter', 60) }),
    P('pol-salesforce', 'Salesforce permission sets', 'salesforce', ['sf-permset-reader', 'sf-permsetgroup-ops'], { maxLevel: 'assigned', maxDurationMin: 480, chain: [L('manager'), L('security')] }),
    P('pol-warehouse', 'Warehouse roles', 'snowflake', ['snow-role-analyst', 'snow-role-writer'], { maxLevel: 'member', maxDurationMin: 480, chain: [L('resource-owner'), L('security')] }),
    P('pol-lakehouse', 'Lakehouse: the curated schema', 'databricks', ['dbx-schema-gold'], { maxLevel: 'MODIFY', maxDurationMin: 240, chain: [L('resource-owner')], autoApprove: A(true, 'SELECT', 60) }),
    P('pol-lakehouse-pii', 'Lakehouse: the personal-data schema', 'databricks', ['dbx-schema-pii'], { maxLevel: 'SELECT', maxDurationMin: 120, chain: [L('data-owner'), L('security')] }),
    P('pol-workspace-admin', 'Google Workspace admin roles', 'google', ['gw-role-helpdesk', 'gw-role-groups'], { maxLevel: 'assigned', maxDurationMin: 240, chain: [L('manager'), L('security')] }),
  ];
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const EDITABLE = ['maxLevel', 'maxDurationMin', 'chain', 'requireDistinctApprovers', 'requestTtlMin', 'channel', 'autoApprove'];

// The editable part of a policy. Strict: unknown keys, wrong types and out-of-range numbers are refused (never silently clamped).
// `current` supplies the resource list, so the levels can be checked. Returns { ok, errors, value }.
export function validateEdit(raw, current) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ['the policy must be an object'] };
  // Fixed text: a key name the visitor typed (it may be a credential) is never quoted, not even a slice of it.
  if (Object.keys(raw).some((k) => !EDITABLE.includes(k))) errors.push('the policy carries a field the lab does not take');
  const levels = RESOURCES[current.resources[0]].levels;
  const v = {};
  const level = (x) => typeof x === 'string' && levels.includes(x);
  if (!level(raw.maxLevel)) errors.push(`maxLevel must be one of ${levels.join(', ')}`); else v.maxLevel = raw.maxLevel;
  if (!intIn(raw.maxDurationMin, 1, LIMITS.durationMax)) errors.push(`maxDurationMin must be a whole number from 1 to ${LIMITS.durationMax}`); else v.maxDurationMin = raw.maxDurationMin;
  if (typeof raw.requireDistinctApprovers !== 'boolean') errors.push('requireDistinctApprovers must be true or false'); else v.requireDistinctApprovers = raw.requireDistinctApprovers;
  if (!intIn(raw.requestTtlMin, LIMITS.ttlMin, LIMITS.ttlMax)) errors.push(`requestTtlMin must be a whole number from ${LIMITS.ttlMin} to ${LIMITS.ttlMax}`); else v.requestTtlMin = raw.requestTtlMin;
  if (!CHANNELS.includes(raw.channel)) errors.push(`channel must be one of ${CHANNELS.join(', ')}`); else v.channel = raw.channel;
  if (!Array.isArray(raw.chain) || raw.chain.length < LIMITS.chainMin || raw.chain.length > LIMITS.chainMax) errors.push(`chain must have ${LIMITS.chainMin} to ${LIMITS.chainMax} levels`);
  else {
    const bad = raw.chain.findIndex((c) => !isObj(c) || !ROLES.includes(c.role) || !intIn(c.required, 1, LIMITS.requiredMax) || Object.keys(c).some((k) => k !== 'role' && k !== 'required'));
    if (bad >= 0) errors.push(`chain level ${bad + 1} needs a role (${ROLES.join(', ')}) and required 1 to ${LIMITS.requiredMax}`);
    else v.chain = raw.chain.map((c) => ({ role: c.role, required: c.required }));
  }
  const a = raw.autoApprove;
  if (!isObj(a) || Object.keys(a).some((k) => !['enabled', 'maxLevel', 'maxDurationMin'].includes(k)) || typeof a.enabled !== 'boolean' || !level(a.maxLevel) || !intIn(a.maxDurationMin, 0, LIMITS.durationMax)) errors.push('autoApprove needs enabled (true or false), maxLevel and maxDurationMin (0 to the maximum)');
  else v.autoApprove = { enabled: a.enabled, maxLevel: a.maxLevel, maxDurationMin: a.maxDurationMin };
  if (!errors.length && rankOf(current.resources[0], v.maxLevel) < 0) errors.push('maxLevel is not on the level scale');
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: v };
}

// Structural self-check used by the doctor and tests: every resource in a policy exists, is on the policy's platform and shares one scale.
export function policyProblems(policies) {
  const out = [];
  const ids = new Set();
  for (const p of policies) {
    if (ids.has(p.id)) out.push(`${p.id}: duplicate id`); ids.add(p.id);
    const scales = new Set();
    for (const r of p.resources) {
      if (!Object.hasOwn(RESOURCES, r)) { out.push(`${p.id}: unknown resource`); continue; }
      if (RESOURCES[r].platform !== p.platform) out.push(`${p.id}: ${r} is on another platform`);
      scales.add(RESOURCES[r].levels.join('|'));
    }
    if (scales.size > 1) out.push(`${p.id}: resources share no level scale`);
    const v = validateEdit(Object.fromEntries(EDITABLE.map((k) => [k, p[k]])), p);
    if (!v.ok) out.push(`${p.id}: ${v.errors.join('; ')}`);
  }
  return out;
}
export const EDITABLE_FIELDS = EDITABLE;
