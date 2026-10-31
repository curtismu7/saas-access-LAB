// The access engine: an in-process model of six SaaS platforms, each holding REAL state (collaborators, members, role and privilege holders),
// a lab clock the visitor advances, a request and approval workflow, grants with expiry, receipts (a hash chain), a reaper that removes access
// when the last reference expires, and drift detection against the platform. Humans and agents share one model: the subject has a kind.
// One Engine per workspace. No I/O, no randomness, no network: with the same calls it gives the same state (the Mock tables are generated from it).
import { createHash } from 'node:crypto';
import { PLATFORMS, RESOURCES, RESOURCE_IDS, PLATFORM_IDS, ROLES, platformCall, rankOf } from './catalog.js';
import { LIMITS as POLICY_LIMITS, defaultPolicies, validateEdit } from './policies.js';
import { buildRoster, fill } from './cast.js';
import { cleanFree } from './credentials.js';
import { formatTraceparent } from './trace.js';
import { refuse } from './errors.js';

export const CLOCK_START = Date.parse('2026-11-02T09:00:00.000Z');
export const MIN = 60_000;
export const REAPER_TICK_MIN = 5; // lab-invented: how often the reaper wakes
export const NIGHTLY_HOUR_UTC = 2; // lab-invented: when the nightly reconcile runs on the lab clock
export const ADVANCE_MAX_MIN = 10080;
export const LIMITS = { requests: 200, grants: 200, audit: 500, outbox: 300, platformLog: 300, entries: 400, hops: 40, reason: 300, comment: 200, runs: 30, findings: 200 };
export const VIA = ['console', 'slack', 'mattermost', 'msteams', 'jira', 'servicenow'];
export const CHAT = ['slack', 'mattermost'];
export const NOTIFY_ONLY = ['msteams', 'jira', 'servicenow'];
export const SUBJECT_KINDS = ['human', 'agent'];
const TERMINAL = new Set(['granted', 'denied', 'expired', 'cancelled']);

const iso = (ms) => new Date(ms).toISOString();
const pad = (n, w = 4) => String(n).padStart(w, '0');
const isStr = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;
const sha = (s) => createHash('sha256').update(s).digest('hex');

// The console swagger (2026-10-31) gives Sync to the Databricks, Salesforce and Snowflake account objects. The lab READS it as "the reconcile reads this
// platform's state"; that behaviour is a lab reading, not something the schema says.
export const SYNC_PLATFORMS = ['databricks', 'salesforce', 'snowflake'];
const SYNC_DEFAULT = { databricks: true, salesforce: true, snowflake: true };

export function defaultIntegrations() {
  return {
    slack: { Hitl: true, WorkspaceID: 'T-LAB' },
    mattermost: { Hitl: true },
    msteams: { enabled: true },
    jira: { Hitl: true, project: 'ACCESS' },
    servicenow: { Hitl: true, table: 'u_access_request' },
  };
}

export class Engine {
  constructor(cast) {
    this.cast = cast;
    this.people = new Map(buildRoster(cast).map((p) => [p.id, p]));
    this.trace = null; this.hops = []; this.hopsTruncated = false;
    this.s = this.fresh();
  }

  fresh() {
    return {
      clock: CLOCK_START, seq: { req: 0, grant: 0, receipt: 0, msg: 0, ticket: 0, audit: 0, finding: 0, run: 0 },
      policies: Object.fromEntries(defaultPolicies().map((p) => [p.id, p])), integrations: defaultIntegrations(),
      requests: [], grants: [], audit: [], outbox: [], receipts: [], platformLog: [], entries: [], sync: { ...SYNC_DEFAULT },
      drift: { open: [], runs: [], lastNightly: this.nightlyIndex(CLOCK_START), lastRunAt: null },
    };
  }
  reset() { this.s = this.fresh(); this.hops = []; }

  // ---------- helpers -------------------------------------------------------------------------------------------------------------------------
  get now() { return this.s.clock; }
  nightlyIndex(ms) { return Math.floor((ms - NIGHTLY_HOUR_UTC * 3600_000) / 86_400_000); }
  person(id) { return isStr(id) ? this.people.get(id) : undefined; }
  resourceName(id) { return fill(RESOURCES[id].name, this.cast); }
  policy(id) { return isStr(id) && Object.hasOwn(this.s.policies, id) ? this.s.policies[id] : null; }
  nextId(kind, prefix, w = 4) { return `${prefix}-${pad(++this.s.seq[kind], w)}`; }
  hop(label, request, response) {
    if (!this.trace) return;
    if (this.hops.length >= LIMITS.hops) { this.hopsTruncated = true; return; }
    this.hops.push({ n: this.hops.length + 1, label, request: { ...request, headers: { traceparent: formatTraceparent(this.trace.traceId, this.trace.span()), ...(request.headers || {}) } }, response });
  }
  audit(kind, actor, data = {}) {
    const a = { ...data, n: ++this.s.seq.audit, at: iso(this.now), kind, actor };
    this.s.audit.push(a); if (this.s.audit.length > LIMITS.audit) this.s.audit.shift();
    return a;
  }
  holdingMatch(g, platform, resource, subject) { return g.platform === platform && g.resource === resource && g.subject.kind === subject.kind && g.subject.id === subject.id; }
  liveGrants(platform, resource, subject) { return this.s.grants.filter((g) => g.status === 'active' && this.holdingMatch(g, platform, resource, subject)); }
  maxLevel(resource, grants) { return grants.reduce((m, g) => (m === null || rankOf(resource, g.level) > rankOf(resource, m) ? g.level : m), null); }
  entry(platform, resource, subject) { return this.s.entries.find((e) => e.platform === platform && e.resource === resource && e.subjectKind === subject.kind && e.subjectId === subject.id); }

  // ---------- routing ---------------------------------------------------------------------------------------------------------------------------
  resolveRole(role, subject, resource) {
    if (role === 'manager') { const p = this.people.get(subject.id); return p ? [p.kind === 'human' ? p.manager : p.custodian] : []; }
    if (role === 'resource-owner') return [this.cast[RESOURCES[resource].ownerSlot]];
    if (role === 'security' || role === 'data-owner') return [...this.people.values()].filter((p) => p.groups.includes(role)).map((p) => p.id);
    return [];
  }
  // For each chain level: who is routed to, and who among them is allowed to act (never the requester, never the subject, never an agent).
  routing(chain, { subject, resource, requestedBy }) {
    return chain.map((lv, i) => {
      const ids = [...new Set(this.resolveRole(lv.role, subject, resource))];
      const candidates = ids.map((id) => {
        const p = this.people.get(id);
        const reason = id === requestedBy ? 'requester' : id === subject.id ? 'subject' : !p || p.kind !== 'human' ? 'not-human' : null;
        return { id, allowed: reason === null, reason };
      });
      return { level: i, role: lv.role, required: lv.required, candidates };
    });
  }

  // ---------- requests --------------------------------------------------------------------------------------------------------------------------
  // Validates the whole input (types first: a missing or wrong-typed argument is a violation) and returns the normalised request spec, or throws.
  normalise(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const need = (cond, code, msg, status = 400) => { if (!cond) throw refuse(code, msg, status); };
    need(isStr(i.requestedBy) && this.people.has(i.requestedBy), 'bad_requester', 'requestedBy must be someone in the roster');
    need(SUBJECT_KINDS.includes(i.subjectKind), 'bad_subject_kind', `subjectKind must be ${SUBJECT_KINDS.join(' or ')}`);
    need(isStr(i.subjectId) && this.people.has(i.subjectId) && this.people.get(i.subjectId).kind === i.subjectKind, 'bad_subject', 'the subject must be someone in the roster of that kind');
    need(isStr(i.platform) && Object.hasOwn(PLATFORMS, i.platform), 'bad_platform', 'unknown platform');
    need(isStr(i.resource) && Object.hasOwn(RESOURCES, i.resource) && RESOURCES[i.resource].platform === i.platform, 'bad_resource', 'unknown resource for that platform');
    need(isStr(i.level) && RESOURCES[i.resource].levels.includes(i.level), 'bad_level', 'that level is not on the resource scale');
    need(typeof i.durationMin === 'number' && Number.isInteger(i.durationMin) && i.durationMin >= 1, 'bad_duration', 'durationMin must be a whole number of minutes, at least 1: every grant carries an expiry');
    const policy = this.policy(i.policyId);
    need(policy, 'bad_policy', 'policyId must name a policy', 400);
    need(!policy.retired, 'policy_retired', 'that policy is retired', 409);
    need(policy.platform === i.platform && policy.resources.includes(i.resource), 'policy_does_not_cover', 'that policy does not cover this resource', 400);
    need(rankOf(i.resource, i.level) <= rankOf(i.resource, policy.maxLevel), 'level_above_policy', 'the level is above what the policy may grant', 400);
    need(i.durationMin <= policy.maxDurationMin, 'duration_above_policy', 'the duration is longer than the policy allows', 400);
    need(i.reason === undefined || typeof i.reason === 'string', 'bad_reason', 'reason must be text');
    const subject = { kind: i.subjectKind, id: i.subjectId };
    const sp = this.people.get(i.subjectId);
    need(i.requestedBy === i.subjectId || i.requestedBy === (sp.kind === 'human' ? sp.manager : sp.custodian), 'requester_not_allowed', 'a request is made by the subject or by the subject\'s manager (an agent\'s custodian)', 403);
    return { requestedBy: i.requestedBy, subject, platform: i.platform, resource: i.resource, level: i.level, durationMin: i.durationMin, policy, reason: cleanFree(i.reason, LIMITS.reason) };
  }

  autoApproves(policy, spec) {
    const a = policy.autoApprove;
    return a.enabled && rankOf(spec.resource, spec.level) <= rankOf(spec.resource, a.maxLevel) && spec.durationMin <= a.maxDurationMin;
  }

  // Preview: the same checks and routing as a real request, without creating anything. Returns { ok, errors, routing, autoApprove }.
  preview(input) {
    try {
      const spec = this.normalise(input);
      const chain = spec.policy.chain;
      const routing = this.routing(chain, spec);
      const auto = this.autoApproves(spec.policy, spec);
      const stuck = auto ? null : routing.find((r) => r.candidates.filter((c) => c.allowed).length < r.required);
      return { ok: !stuck, error: stuck ? { code: 'no_eligible_approver', detail: `nobody can approve level ${stuck.level + 1} (${stuck.role}): the people routed to are the requester, the subject or not human` } : null, routing, autoApprove: auto, policyId: spec.policy.id, chain, windowMin: spec.policy.requestTtlMin, expiresIfApprovedNow: iso(this.now + spec.durationMin * MIN) };
    } catch (e) { if (!e.code) throw e; return { ok: false, error: { code: e.code, detail: e.message }, routing: [], autoApprove: false }; }
  }

  createRequest(input) {
    if (this.s.requests.length >= LIMITS.requests) throw refuse('limit_reached', `a workspace holds at most ${LIMITS.requests} requests: Reset to start again`, 409);
    const spec = this.normalise(input);
    const chain = spec.policy.chain.map((c) => ({ ...c }));
    const routing = this.routing(chain, spec);
    const auto = this.autoApproves(spec.policy, spec);
    const stuck = auto ? null : routing.find((r) => r.candidates.filter((c) => c.allowed).length < r.required);
    if (stuck) throw refuse('no_eligible_approver', `nobody can approve level ${stuck.level + 1} (${stuck.role}): the people routed to are the requester, the subject or not human`, 409);
    const req = {
      id: this.nextId('req', 'req'), status: 'pending', createdAt: iso(this.now), policyId: spec.policy.id, platform: spec.platform, resource: spec.resource, level: spec.level,
      durationMin: spec.durationMin, subject: spec.subject, requestedBy: spec.requestedBy, reason: spec.reason, currentLevel: 0, chain,
      approval: {
        RequiredApprovals: chain[0].required, RequireDistinctApprovers: spec.policy.requireDistinctApprovers, Approvers: [], ExpiresAt: iso(this.now + spec.policy.requestTtlMin * MIN),
        NotifiedLevel: 0, ApproverNotifications: [], ApprovedBy: [], ApprovalCount: 0, DistinctApprovers: 0, DeniedBy: null, DenialReason: null, DecidedAt: null, ExpiredAt: null,
        GrantID: null, RetiredAt: null, Events: [], JiraTicketID: null, ServiceNowTableRecordId: null, MsTeamsChannelMsgID: null,
      },
    };
    this.s.requests.unshift(req);
    this.audit('request.created', spec.requestedBy, { requestId: req.id, subject: spec.subject, platform: spec.platform, resource: spec.resource, level: spec.level, durationMin: spec.durationMin, policyId: spec.policy.id });
    this.event(req, `created by ${spec.requestedBy} for ${spec.subject.kind} ${spec.subject.id}`);
    this.hop('policy engine (in process)', { method: 'ROUTE', url: `policy://${spec.policy.id}`, body: { chain, subject: spec.subject, resource: spec.resource } }, { status: 200, body: { levels: routing.map((r) => ({ role: r.role, routedTo: r.candidates.map((c) => c.id), allowed: r.candidates.filter((c) => c.allowed).map((c) => c.id) })) } });
    if (auto) {
      this.audit('request.auto_approved', `policy:${spec.policy.id}`, { requestId: req.id });
      this.event(req, `auto-approved by policy ${spec.policy.id}`);
      this.finalise(req, [{ id: `policy:${spec.policy.id}`, via: 'policy', level: 0, at: iso(this.now) }]);
    } else {
      this.setLevel(req);
      this.notify(req, 'created');
    }
    return req;
  }

  event(req, text) { req.approval.Events.push(`${iso(this.now)} ${text}`); if (req.approval.Events.length > 40) req.approval.Events.shift(); }

  setLevel(req) {
    const r = this.routing(req.chain, { subject: req.subject, resource: req.resource, requestedBy: req.requestedBy })[req.currentLevel];
    req.approval.RequiredApprovals = r.required;
    req.approval.Approvers = r.candidates.filter((c) => c.allowed).map((c) => c.id);
    req.approval.NotifiedLevel = req.currentLevel + 1;
  }

  // ---------- decisions -------------------------------------------------------------------------------------------------------------------------
  decide(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const need = (cond, code, msg, status = 400) => { if (!cond) throw refuse(code, msg, status); };
    need(isStr(i.requestId, 20) && /^req-\d{4,}$/.test(i.requestId), 'bad_request_id', 'requestId is not valid');
    const req = this.s.requests.find((r) => r.id === i.requestId);
    need(req, 'not_found', 'no such request', 404);
    need(isStr(i.approver) && this.people.has(i.approver), 'approver_unknown', 'the approver is not in the roster', 403);
    need(i.decision === 'approve' || i.decision === 'deny', 'bad_decision', 'decision must be approve or deny');
    need(i.via === undefined || VIA.includes(i.via), 'bad_channel', `via must be one of ${VIA.join(', ')}`);
    need(i.comment === undefined || typeof i.comment === 'string', 'bad_comment', 'comment must be text');
    const via = i.via ?? 'console';
    const approver = this.people.get(i.approver);
    // A request already past its approval window is expired first, so an approval that arrives late is refused for the right reason.
    if (req.status === 'pending' && this.now >= Date.parse(req.approval.ExpiresAt)) this.expireRequest(req);
    need(req.status !== 'expired', 'request_expired', 'the approval window closed: an expired request cannot be approved', 409);
    need(req.status === 'pending', 'already_decided', `the request is already ${req.status}`, 409);
    need(approver.kind === 'human', 'approver_not_human', 'an agent cannot approve: approvers are people', 403);
    need(i.approver !== req.requestedBy && i.approver !== req.subject.id, 'self_approval_refused', i.approver === req.requestedBy ? 'self-approval is refused: the approver made this request' : 'self-approval is refused: the approver is the subject of this request', 403);
    const level = this.routing(req.chain, { subject: req.subject, resource: req.resource, requestedBy: req.requestedBy })[req.currentLevel];
    need(level.candidates.some((c) => c.id === i.approver && c.allowed), 'not_an_approver', `not an approver for level ${req.currentLevel + 1} (${level.role}) of this request`, 403);
    need(!NOTIFY_ONLY.includes(via), 'channel_notify_only', `${via} only receives notifications and tickets: approve from the console, Slack or Mattermost`, 400);
    if (CHAT.includes(via)) need(this.s.outbox.some((m) => m.requestId === req.id && m.to === i.approver && m.channel === via && m.kind === 'approval_request' && m.level === req.currentLevel && m.actions.length), 'no_chat_action', `no ${via} message with Approve and Deny buttons was sent to this approver for this level`, 403);
    const comment = cleanFree(i.comment, LIMITS.comment);
    if (i.decision === 'deny') {
      req.status = 'denied'; req.approval.DeniedBy = i.approver; req.approval.DenialReason = comment || 'denied'; req.approval.DecidedAt = iso(this.now);
      this.audit('request.denied', i.approver, { requestId: req.id, via });
      this.event(req, `denied by ${i.approver} via ${via}`);
      this.hop(`${via === 'console' ? 'console' : via} decision`, { method: 'POST', url: `lab://requests/${req.id}/decision`, body: { approver: i.approver, decision: 'deny', via, comment } }, { status: 200, body: { status: 'denied' } });
      this.notifyTerminal(req);
      return req;
    }
    need(!req.approval.ApprovedBy.some((a) => a.id === i.approver && a.level === req.currentLevel), 'already_approved', 'this approver already approved this level', 409);
    need(!(req.approval.RequireDistinctApprovers && req.approval.ApprovedBy.some((a) => a.id === i.approver)), 'distinct_approver_required', 'this policy needs a different person at every level', 403);
    req.approval.ApprovedBy.push({ id: i.approver, via, level: req.currentLevel, at: iso(this.now) });
    req.approval.ApprovalCount += 1; req.approval.DistinctApprovers = new Set(req.approval.ApprovedBy.map((a) => a.id)).size;
    this.audit('approval.recorded', i.approver, { requestId: req.id, level: req.currentLevel + 1, via });
    this.event(req, `approved by ${i.approver} via ${via} (level ${req.currentLevel + 1})`);
    this.hop(`${via === 'console' ? 'console' : via} decision`, { method: 'POST', url: `lab://requests/${req.id}/decision`, body: { approver: i.approver, decision: 'approve', via, comment } }, { status: 200, body: { level: req.currentLevel + 1, approvalsAtLevel: req.approval.ApprovedBy.filter((a) => a.level === req.currentLevel).length, required: level.required } });
    if (req.approval.ApprovedBy.filter((a) => a.level === req.currentLevel).length < level.required) return req;
    if (req.currentLevel + 1 < req.chain.length) {
      req.currentLevel += 1; this.setLevel(req); this.notify(req, 'level');
      return req;
    }
    this.finalise(req, req.approval.ApprovedBy);
    return req;
  }

  cancel(input) {
    const i = input && typeof input === 'object' ? input : {};
    const req = isStr(i.requestId, 20) ? this.s.requests.find((r) => r.id === i.requestId) : null;
    if (!req) throw refuse('not_found', 'no such request', 404);
    if (!isStr(i.by) || !this.people.has(i.by)) throw refuse('bad_requester', 'by must be someone in the roster');
    if (req.status !== 'pending') throw refuse('already_decided', `the request is already ${req.status}`, 409);
    if (i.by !== req.requestedBy && i.by !== req.subject.id) throw refuse('not_yours', 'only the requester or the subject can cancel a request', 403);
    req.status = 'cancelled'; req.approval.DecidedAt = iso(this.now);
    this.audit('request.cancelled', i.by, { requestId: req.id });
    this.event(req, `cancelled by ${i.by}`);
    this.notifyTerminal(req);
    return req;
  }

  expireRequest(req) {
    req.status = 'expired'; req.approval.ExpiredAt = iso(this.now);
    this.audit('request.expired', 'reaper', { requestId: req.id });
    this.event(req, 'the approval window closed');
    this.notifyTerminal(req);
  }

  // ---------- grants and receipts ---------------------------------------------------------------------------------------------------------------
  finalise(req, approvedBy) {
    const g = this.makeGrant(req, approvedBy);
    req.status = 'granted'; req.approval.GrantID = g.id; req.approval.DecidedAt = iso(this.now);
    this.event(req, `granted as ${g.id} until ${g.expiresAt}`);
    this.notifyTerminal(req);
  }

  makeGrant(req, approvedBy) {
    // Every grant carries an expiry: refuse to create one without a future, bounded expiry (the cap is the policy's own maximum).
    const durationMin = req.durationMin;
    if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > POLICY_LIMITS.durationMax) throw refuse('bad_duration', 'every grant carries an expiry', 400);
    if (this.s.grants.length >= LIMITS.grants) throw refuse('limit_reached', `a workspace holds at most ${LIMITS.grants} grants: Reset to start again`, 409);
    const expiresMs = this.now + durationMin * MIN;
    if (!Number.isFinite(expiresMs) || expiresMs <= this.now) throw refuse('no_expiry', 'every grant carries an expiry', 400);
    const g = {
      id: this.nextId('grant', 'g'), requestId: req.id, policyId: req.policyId, platform: req.platform, resource: req.resource, level: req.level, subject: { ...req.subject },
      requestedBy: req.requestedBy, approvedBy: approvedBy.map((a) => ({ id: a.id, via: a.via, level: a.level })), grantedAt: iso(this.now), expiresAt: iso(expiresMs), durationMin,
      status: 'active', removedAt: null, removalReason: null, receiptId: null, removalReceiptId: null,
    };
    this.s.grants.unshift(g);
    g.receiptId = this.addReceipt('grant', g);
    this.audit('grant.created', 'privilege', { grantId: g.id, requestId: req.id, subject: g.subject, platform: g.platform, resource: g.resource, level: g.level, expiresAt: g.expiresAt, refCount: this.liveGrants(g.platform, g.resource, g.subject).length });
    this.recompute(g.platform, g.resource, g.subject, 'grant');
    return g;
  }

  addReceipt(kind, g) {
    const prev = this.s.receipts.length ? this.s.receipts[this.s.receipts.length - 1].hash : '0'.repeat(64);
    const body = { kind, grantId: g.id, requestId: g.requestId, policyId: g.policyId, platform: g.platform, resource: g.resource, level: g.level, subject: g.subject, approvedBy: g.approvedBy.map((a) => a.id), grantedAt: g.grantedAt, expiresAt: g.expiresAt, refCount: this.liveGrants(g.platform, g.resource, g.subject).length, at: iso(this.now), removalReason: g.removalReason };
    const r = { id: this.nextId('receipt', 'r'), kind, at: body.at, grantId: g.id, body, prevHash: prev, hash: sha(`${prev}|${JSON.stringify(body)}`) };
    this.s.receipts.push(r);
    return r.id;
  }
  verifyReceipts() {
    let prev = '0'.repeat(64);
    for (const r of this.s.receipts) { if (r.prevHash !== prev || r.hash !== sha(`${prev}|${JSON.stringify(r.body)}`)) return { ok: false, at: r.id }; prev = r.hash; }
    return { ok: true, count: this.s.receipts.length, head: prev };
  }

  // Bring the platform's entry for one holding in line with the live grants (the heart of reference counting): the entry holds the HIGHEST live
  // level; with no live grant left it is removed, or put back to what it was before the lab touched it.
  recompute(platform, resource, subject, why) {
    const live = this.liveGrants(platform, resource, subject);
    const expected = this.maxLevel(resource, live);
    let e = this.entry(platform, resource, subject);
    const rn = this.resourceName(resource); const kind = RESOURCES[resource].kind;
    const call = (op, level, previous) => {
      const c = platformCall(platform, op, { resourceName: rn, resourceKind: kind, level, subject: subject.id, previous });
      this.hop(`${PLATFORMS[platform].name} (simulated API call, ${op})`, { ...c.request }, c.response);
    };
    const log = (op, level, actor = 'privilege') => { this.s.platformLog.push({ at: iso(this.now), platform, actor, op, resource, subject, level }); if (this.s.platformLog.length > LIMITS.platformLog) this.s.platformLog.shift(); };
    if (expected === null) {
      if (!e) return;
      if (e.prior) { const was = e.level; e.level = e.prior; e.origin = 'out-of-band'; e.prior = null; if (was !== e.level) { call('update', e.level, was); log('set', e.level); } return; }
      call('revoke', e.level); log('remove', e.level);
      this.s.entries.splice(this.s.entries.indexOf(e), 1);
      return;
    }
    if (!e) {
      if (this.s.entries.length >= LIMITS.entries) throw refuse('limit_reached', 'the platform holds too many entries: Reset', 409);
      e = { platform, resource, subjectKind: subject.kind, subjectId: subject.id, level: expected, origin: 'privilege', prior: null, since: iso(this.now) };
      this.s.entries.push(e); call('grant', expected); log('add', expected); return;
    }
    if (e.origin === 'out-of-band') { e.prior = e.level; e.origin = 'privilege'; }
    const target = e.prior && rankOf(resource, e.prior) > rankOf(resource, expected) ? e.prior : expected;
    if (e.level !== target) { const was = e.level; e.level = target; call('update', target, was); log('set', target); }
  }

  removeGrant(g, reason, actor) {
    g.status = reason === 'expired' ? 'expired' : 'revoked'; g.removedAt = iso(this.now); g.removalReason = reason;
    g.removalReceiptId = this.addReceipt('removal', g);
    const lagMin = Math.round((this.now - Date.parse(g.expiresAt)) / MIN);
    this.audit(reason === 'expired' ? 'grant.reaped' : 'grant.revoked', actor, { grantId: g.id, subject: g.subject, platform: g.platform, resource: g.resource, level: g.level, reason, lagMin: reason === 'expired' ? lagMin : null, refsLeft: this.liveGrants(g.platform, g.resource, g.subject).length });
    this.recompute(g.platform, g.resource, g.subject, reason);
  }

  // ---------- the reaper and the clock -----------------------------------------------------------------------------------------------------------
  // Reconciles continuously: it looks only at the grants and the platform, never at the request that created them, so a long-finished workflow
  // changes nothing. Idempotent: a second pass at the same time does nothing.
  reap() {
    const out = { reaped: [], requestsExpired: [] };
    for (const r of this.s.requests) if (r.status === 'pending' && this.now >= Date.parse(r.approval.ExpiresAt)) { this.expireRequest(r); out.requestsExpired.push(r.id); }
    for (const g of [...this.s.grants]) if (g.status === 'active' && this.now >= Date.parse(g.expiresAt)) { this.removeGrant(g, 'expired', 'reaper'); out.reaped.push(g.id); }
    return out;
  }

  advance(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    let target;
    if (i.to !== undefined) {
      if (typeof i.to !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(i.to) || Number.isNaN(Date.parse(i.to))) throw refuse('bad_time', 'to must be an ISO time ending in Z');
      target = Date.parse(i.to);
    } else {
      if (typeof i.minutes !== 'number' || !Number.isInteger(i.minutes)) throw refuse('bad_minutes', 'minutes must be a whole number');
      target = this.now + i.minutes * MIN;
    }
    if (!(target > this.now)) throw refuse('clock_backwards', 'the lab clock only moves forward', 409);
    if (target - this.now > ADVANCE_MAX_MIN * MIN) throw refuse('advance_too_far', `advance at most ${ADVANCE_MAX_MIN} minutes (7 days) at a time`, 400);
    const from = this.now; const result = { reaped: [], requestsExpired: [], nightly: 0 };
    const pass = () => {
      const r = this.reap(); result.reaped.push(...r.reaped); result.requestsExpired.push(...r.requestsExpired);
      const idx = this.nightlyIndex(this.now);
      if (idx > this.s.drift.lastNightly) { this.s.drift.lastNightly = idx; this.reconcile('nightly'); result.nightly += 1; }
    };
    const tick = REAPER_TICK_MIN * MIN;
    for (let t = (Math.floor(this.now / tick) + 1) * tick; t < target; t += tick) { this.s.clock = t; pass(); }
    this.s.clock = target; pass();
    this.audit('clock.advanced', 'visitor', { from: iso(from), to: iso(target), minutes: Math.round((target - from) / MIN) });
    return result;
  }

  // ---------- platform changes made by hand, drift -----------------------------------------------------------------------------------------------
  outOfBand(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const need = (cond, code, msg) => { if (!cond) throw refuse(code, msg, 400); };
    need(i.op === 'grant' || i.op === 'remove', 'bad_op', 'op must be grant or remove');
    need(isStr(i.platform) && Object.hasOwn(PLATFORMS, i.platform), 'bad_platform', 'unknown platform');
    need(isStr(i.resource) && Object.hasOwn(RESOURCES, i.resource) && RESOURCES[i.resource].platform === i.platform, 'bad_resource', 'unknown resource for that platform');
    need(SUBJECT_KINDS.includes(i.subjectKind) && isStr(i.subjectId) && this.people.get(i.subjectId)?.kind === i.subjectKind, 'bad_subject', 'the subject must be someone in the roster of that kind');
    const subject = { kind: i.subjectKind, id: i.subjectId };
    const rn = this.resourceName(i.resource); const kind = RESOURCES[i.resource].kind;
    let e = this.entry(i.platform, i.resource, subject);
    const log = (op, level) => { this.s.platformLog.push({ at: iso(this.now), platform: i.platform, actor: 'an administrator on the platform (not Privilege)', op, resource: i.resource, subject, level }); if (this.s.platformLog.length > LIMITS.platformLog) this.s.platformLog.shift(); };
    if (i.op === 'remove') {
      if (!e) throw refuse('nothing_there', 'the platform has no such entry', 409);
      const c = platformCall(i.platform, 'revoke', { resourceName: rn, resourceKind: kind, level: e.level, subject: subject.id });
      this.hop(`${PLATFORMS[i.platform].name} (by hand, simulated)`, { ...c.request }, c.response);
      log('remove', e.level); this.s.entries.splice(this.s.entries.indexOf(e), 1);
      return { op: 'remove' };
    }
    need(isStr(i.level) && RESOURCES[i.resource].levels.includes(i.level), 'bad_level', 'that level is not on the resource scale');
    if (e) {
      if (rankOf(i.resource, i.level) <= rankOf(i.resource, e.level)) throw refuse('nothing_to_change', 'the platform already gives that much access', 409);
      if (e.origin === 'privilege') e.prior = i.level; // the hand-made level becomes the floor the platform returns to when the last grant ends
      e.level = i.level;
    } else {
      if (this.s.entries.length >= LIMITS.entries) throw refuse('limit_reached', 'the platform holds too many entries: Reset', 409);
      e = { platform: i.platform, resource: i.resource, subjectKind: subject.kind, subjectId: subject.id, level: i.level, origin: 'out-of-band', prior: null, since: iso(this.now) };
      this.s.entries.push(e);
    }
    const c = platformCall(i.platform, 'grant', { resourceName: rn, resourceKind: kind, level: i.level, subject: subject.id });
    this.hop(`${PLATFORMS[i.platform].name} (by hand, simulated)`, { ...c.request }, c.response);
    log('add', i.level);
    return { op: 'grant' };
  }

  // The diff of the platform against the receipts. Pure: it changes nothing.
  diff() {
    const rows = []; const seen = new Set();
    const synced = (p) => this.s.sync[p] !== false;
    for (const e of this.s.entries.filter((x) => synced(x.platform))) {
      const subj = { kind: e.subjectKind, id: e.subjectId };
      const live = this.liveGrants(e.platform, e.resource, subj); const expected = this.maxLevel(e.resource, live);
      seen.add(`${e.platform}|${e.resource}|${e.subjectKind}:${e.subjectId}`);
      const kind = expected === null ? 'unrecorded' : rankOf(e.resource, e.level) > rankOf(e.resource, expected) ? 'elevated' : null;
      rows.push({ kind: kind || 'match', platform: e.platform, resource: e.resource, subject: subj, onPlatform: e.level, expected, grants: live.map((g) => g.id), origin: e.origin });
    }
    for (const g of this.s.grants.filter((x) => x.status === 'active' && synced(x.platform))) {
      const k = `${g.platform}|${g.resource}|${g.subject.kind}:${g.subject.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ kind: 'missing', platform: g.platform, resource: g.resource, subject: g.subject, onPlatform: null, expected: this.maxLevel(g.resource, this.liveGrants(g.platform, g.resource, g.subject)), grants: [g.id], origin: null });
    }
    return rows;
  }

  reconcile(trigger) {
    const rows = this.diff().filter((r) => r.kind !== 'match');
    const prev = new Map(this.s.drift.open.map((f) => [`${f.kind}|${f.platform}|${f.resource}|${f.subject.kind}:${f.subject.id}`, f]));
    const open = []; let fresh = 0;
    for (const r of rows.slice(0, LIMITS.findings)) {
      const key = `${r.kind}|${r.platform}|${r.resource}|${r.subject.kind}:${r.subject.id}`;
      const old = prev.get(key); prev.delete(key);
      const f = { id: old ? old.id : this.nextId('finding', 'd'), ...r, firstSeenAt: old ? old.firstSeenAt : iso(this.now), lastSeenAt: iso(this.now) };
      if (!old) { fresh += 1; this.audit('drift.found', trigger === 'nightly' ? 'nightly reconcile' : `reconcile (${trigger})`, { findingId: f.id, findingKind: f.kind, platform: f.platform, resource: f.resource, subject: f.subject }); }
      open.push(f);
    }
    for (const gone of prev.values()) this.audit('drift.cleared', `reconcile (${trigger})`, { findingId: gone.id, findingKind: gone.kind, platform: gone.platform, resource: gone.resource, subject: gone.subject });
    this.s.drift.open = open; this.s.drift.lastRunAt = iso(this.now);
    const run = { id: this.nextId('run', 'run'), at: iso(this.now), trigger, entries: this.s.entries.length, findings: open.length, newFindings: fresh };
    this.s.drift.runs.push(run); if (this.s.drift.runs.length > LIMITS.runs) this.s.drift.runs.shift();
    this.hop('reconcile (platform state against receipts, simulated read of every platform)', { method: 'GET', url: 'lab://platforms/*/entitlements' }, { status: 200, body: { entries: this.s.entries.length, findings: open.length } });
    return run;
  }

  remediate(input) {
    const i = input && typeof input === 'object' ? input : {};
    const f = isStr(i.findingId, 20) ? this.s.drift.open.find((x) => x.id === i.findingId) : null;
    if (!f) throw refuse('not_found', 'no such finding', 404);
    if (f.kind === 'missing') throw refuse('nothing_to_revoke', 'the platform already lacks this access: there is nothing to remove', 409);
    const e = this.entry(f.platform, f.resource, f.subject);
    if (!e) throw refuse('nothing_to_revoke', 'the platform no longer has this entry', 409);
    const rn = this.resourceName(f.resource); const kind = RESOURCES[f.resource].kind;
    const live = this.liveGrants(f.platform, f.resource, f.subject); const expected = this.maxLevel(f.resource, live);
    const log = (op, level) => this.s.platformLog.push({ at: iso(this.now), platform: f.platform, actor: 'privilege (drift remediation)', op, resource: f.resource, subject: f.subject, level });
    if (expected === null) {
      const c = platformCall(f.platform, 'revoke', { resourceName: rn, resourceKind: kind, level: e.level, subject: f.subject.id });
      this.hop(`${PLATFORMS[f.platform].name} (simulated API call, revoke)`, { ...c.request }, c.response);
      this.s.entries.splice(this.s.entries.indexOf(e), 1); log('remove', e.level);
    } else {
      const c = platformCall(f.platform, 'update', { resourceName: rn, resourceKind: kind, level: expected, subject: f.subject.id, previous: e.level });
      this.hop(`${PLATFORMS[f.platform].name} (simulated API call, update)`, { ...c.request }, c.response);
      e.level = expected; e.prior = null; log('set', expected);
    }
    this.audit('drift.remediated', 'visitor', { findingId: f.id, findingKind: f.kind, platform: f.platform, resource: f.resource, subject: f.subject });
    return this.reconcile('remediation');
  }

  setSync(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!isStr(i.platform) || !SYNC_PLATFORMS.includes(i.platform)) throw refuse('bad_platform', 'only Databricks, Salesforce and Snowflake have a Sync switch');
    if (typeof i.sync !== 'boolean') throw refuse('bad_sync', 'sync must be true or false');
    this.s.sync[i.platform] = i.sync; this.audit('platform.sync', 'visitor', { platform: i.platform, sync: i.sync });
    return { platform: i.platform, sync: i.sync };
  }

  // ---------- policies and integrations ---------------------------------------------------------------------------------------------------------
  updatePolicy(id, raw) {
    const p = this.policy(id);
    if (!p) throw refuse('not_found', 'no such policy', 404);
    if (p.retired) throw refuse('policy_retired', 'that policy is retired', 409);
    const v = validateEdit(raw, p);
    if (!v.ok) { const e = refuse('bad_policy', 'the policy was refused', 400); e.errors = v.errors; throw e; }
    Object.assign(p, v.value);
    this.audit('policy.updated', 'visitor', { policyId: id });
    return p;
  }

  // Retiring a policy releases every grant issued under it. A grant issued under ANOTHER policy for the same holding keeps the access:
  // the platform entry only goes when the last reference does.
  retirePolicy(id) {
    const p = this.policy(id);
    if (!p) throw refuse('not_found', 'no such policy', 404);
    if (p.retired) throw refuse('policy_retired', 'that policy is already retired', 409);
    p.retired = true;
    this.audit('policy.retired', 'visitor', { policyId: id });
    const out = { revoked: [], cancelled: [] };
    for (const r of this.s.requests) if (r.status === 'pending' && r.policyId === id) { r.status = 'cancelled'; r.approval.DecidedAt = iso(this.now); this.event(r, 'cancelled: the policy was retired'); this.audit('request.cancelled', 'policy retirement', { requestId: r.id }); this.notifyTerminal(r); out.cancelled.push(r.id); }
    for (const g of [...this.s.grants]) if (g.status === 'active' && g.policyId === id) { this.removeGrant(g, 'policy-retired', 'policy retirement'); out.revoked.push(g.id); }
    return out;
  }

  updateIntegrations(raw) {
    const cur = this.s.integrations; const shape = defaultIntegrations();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refuse('bad_integrations', 'integrations must be an object');
    const next = JSON.parse(JSON.stringify(cur));
    for (const [name, v] of Object.entries(raw)) {
      if (!Object.hasOwn(shape, name) || !v || typeof v !== 'object' || Array.isArray(v)) throw refuse('bad_integrations', 'unknown integration');
      for (const [k, x] of Object.entries(v)) {
        if (!['Hitl', 'enabled'].includes(k) || !Object.hasOwn(shape[name], k) || typeof x !== 'boolean') throw refuse('bad_integrations', 'only the true or false switches Hitl (and enabled for Teams) can be changed');
        next[name][k] = x;
      }
    }
    this.s.integrations = next; this.audit('integrations.updated', 'visitor', {});
    return next;
  }

  // ---------- notifications (simulated outbox: never a network call) ----------------------------------------------------------------------------
  push(m) {
    const e = { id: this.nextId('msg', 'msg'), at: iso(this.now), ...m };
    this.s.outbox.push(e); if (this.s.outbox.length > LIMITS.outbox) this.s.outbox.shift();
    this.hop(`${m.channel} (simulated: written to the outbox, never sent)`, { method: 'POST', url: `https://${m.channel}.example/outbox`, body: { to: m.to, kind: m.kind, text: m.text, actions: m.actions } }, { status: 200, body: { id: e.id } });
    return e;
  }
  describe(req) { return `${req.subject.kind} ${req.subject.id} asks for ${req.level} on ${this.resourceName(req.resource)} (${PLATFORMS[req.platform].name}) for ${req.durationMin} min. Reason: ${req.reason || 'none given'}`; }
  notify(req, why) {
    const pol = this.s.policies[req.policyId]; const ig = this.s.integrations; const a = req.approval;
    const lvl = req.currentLevel;
    if (ig[pol.channel]?.Hitl) {
      for (const id of a.Approvers) {
        const m = this.push({ channel: pol.channel, to: id, kind: 'approval_request', requestId: req.id, level: lvl, actions: ['approve', 'deny'], text: `Approve or deny, level ${lvl + 1} (${req.chain[lvl].role}): ${this.describe(req)}` });
        a.ApproverNotifications.push({ ApproverUserID: id, IntegrationType: pol.channel, ChannelID: `dm-${id}`, MessageID: m.id, WorkspaceID: ig[pol.channel].WorkspaceID || 'lab-workspace' });
      }
    }
    if (why !== 'created') return;
    if (ig.msteams.enabled) { const m = this.push({ channel: 'msteams', to: 'channel: access-requests', kind: 'notification', requestId: req.id, level: lvl, actions: [], text: `New access request ${req.id}: ${this.describe(req)}` }); a.MsTeamsChannelMsgID = m.id; }
    if (ig.jira.Hitl) { const t = `${ig.jira.project}-${++this.s.seq.ticket}`; a.JiraTicketID = t; this.push({ channel: 'jira', to: `project ${ig.jira.project}`, kind: 'ticket', requestId: req.id, level: lvl, actions: [], ticket: t, text: `Ticket ${t} opened: ${this.describe(req)}` }); }
    if (ig.servicenow.Hitl) { const t = `TASK${pad(++this.s.seq.ticket, 5)}`; a.ServiceNowTableRecordId = t; this.push({ channel: 'servicenow', to: `table ${ig.servicenow.table}`, kind: 'ticket', requestId: req.id, level: lvl, actions: [], ticket: t, text: `Task ${t} created: ${this.describe(req)}` }); }
  }
  // The first terminal delivery pulls the Approve and Deny buttons and sends the outcome once; RetiredAt stamps it, so a redelivered terminal
  // event cannot duplicate the outcome mail, the Jira comment or the ServiceNow close (swagger: RetiredAt).
  notifyTerminal(req) {
    const a = req.approval;
    if (a.RetiredAt) return false;
    a.RetiredAt = iso(this.now);
    for (const m of this.s.outbox) if (m.requestId === req.id && m.kind === 'approval_request' && m.actions.length) { m.actions = []; m.pulled = true; }
    const ig = this.s.integrations; const outcome = `Request ${req.id} is ${req.status}.`;
    if (ig.msteams.enabled) this.push({ channel: 'msteams', to: 'channel: access-requests', kind: 'outcome', requestId: req.id, level: req.currentLevel, actions: [], text: outcome });
    if (a.JiraTicketID) this.push({ channel: 'jira', to: a.JiraTicketID, kind: 'ticket-update', requestId: req.id, level: req.currentLevel, actions: [], text: `${outcome} Ticket transitioned and commented.` });
    if (a.ServiceNowTableRecordId) this.push({ channel: 'servicenow', to: a.ServiceNowTableRecordId, kind: 'ticket-update', requestId: req.id, level: req.currentLevel, actions: [], text: `${outcome} Task closed.` });
    const pol = this.s.policies[req.policyId];
    if (ig[pol.channel]?.Hitl) this.push({ channel: pol.channel, to: req.requestedBy, kind: 'outcome', requestId: req.id, level: req.currentLevel, actions: [], text: outcome });
    return true;
  }
  // Test and doctor hook: a terminal event delivered a second time.
  redeliverTerminal(requestId) { const r = this.s.requests.find((x) => x.id === requestId); return r && TERMINAL.has(r.status) ? this.notifyTerminal(r) : false; }

  // ---------- the view ----------------------------------------------------------------------------------------------------------------------------
  platformView() {
    return PLATFORM_IDS.map((pid) => {
      const groups = RESOURCE_IDS.filter((r) => RESOURCES[r].platform === pid).map((r) => ({
        resource: r, name: this.resourceName(r), kind: RESOURCES[r].kind, levels: RESOURCES[r].levels,
        members: this.s.entries.filter((e) => e.platform === pid && e.resource === r).map((e) => ({ subjectKind: e.subjectKind, id: e.subjectId, level: e.level, origin: e.origin, prior: e.prior, since: e.since })),
      }));
      return { id: pid, groups, log: this.s.platformLog.filter((l) => l.platform === pid).slice(-12) };
    });
  }
  holdings() {
    const m = new Map();
    for (const g of this.s.grants) if (g.status === 'active') { const k = `${g.platform}|${g.resource}|${g.subject.kind}:${g.subject.id}`; if (!m.has(k)) m.set(k, { key: k, platform: g.platform, resource: g.resource, subject: g.subject, grants: [] }); m.get(k).grants.push(g.id); }
    return [...m.values()].map((h) => { const e = this.entry(h.platform, h.resource, h.subject); return { ...h, refCount: h.grants.length, onPlatform: e ? e.level : null }; });
  }
  snapshot() {
    const s = this.s;
    return {
      clock: iso(s.clock), clockStart: iso(CLOCK_START), reaperTickMin: REAPER_TICK_MIN, nightlyHourUtc: NIGHTLY_HOUR_UTC,
      roster: [...this.people.values()], policies: Object.values(s.policies), integrations: s.integrations, sync: { ...s.sync },
      requests: s.requests.map((r) => ({ ...r, resourceName: this.resourceName(r.resource), routing: r.status === 'pending' ? this.routing(r.chain, { subject: r.subject, resource: r.resource, requestedBy: r.requestedBy })[r.currentLevel] : null })),
      grants: s.grants.map((g) => ({ ...g, resourceName: this.resourceName(g.resource), refCount: g.status === 'active' ? this.liveGrants(g.platform, g.resource, g.subject).length : null })),
      holdings: this.holdings(), receipts: { verify: this.verifyReceipts(), items: s.receipts.slice(-60).map((r) => ({ id: r.id, kind: r.kind, at: r.at, grantId: r.grantId, hash: r.hash, prevHash: r.prevHash })) },
      platforms: this.platformView(), diff: this.diff(), drift: { open: s.drift.open, runs: s.drift.runs, lastRunAt: s.drift.lastRunAt },
      audit: [...s.audit].reverse(), outbox: [...s.outbox].reverse(),
      resourceNames: Object.fromEntries(RESOURCE_IDS.map((r) => [r, this.resourceName(r)])),
      limits: { ...LIMITS, advanceMaxMin: ADVANCE_MAX_MIN },
    };
  }
}
export { ROLES };
