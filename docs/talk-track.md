# Talk track

<!-- Generated from server/src/data.js by `npm run talk-track`. Do not edit by hand. -->

> Ping release claim, UNVERIFIED on our tenant: every product claim here comes from the Ping ID4AI Workforce H2 2026 deck, slides 35 and 51 (release 2026-11-02).

## Start with the problem

Standing access accumulates: a repository grant for one incident, a warehouse role for one migration, none of it expires, and nobody can say who still holds what. Audit findings on standing access stall the review. (Ping's challenge text, slide 51. Fabrikam Bank sees this on every platform its engineers use.)

## Request: pick a platform, a level and a window

On the Request tab maya.chen picks GitHub, Snowflake or any of the six platforms, a level, a duration and a reason. The lab shows the approval chain before anything is created: who is routed to at each level, and who is not allowed to act.

## Approve: the right person, never the requester

The request is routed automatically: the manager, the owner of the resource, the security group or the data owner. lee.park cannot approve their own request, an agent cannot approve anything, and an expired request cannot be approved. Approvers act from Slack or Mattermost; Teams, Jira and ServiceNow only receive notifications and tickets.

## Time-bound by construction

Every grant carries an expiry. Move the lab clock: the reaper removes access from the platform when the window closes, even though the workflow that created it finished long ago. A request with no expiry cannot be made.

## A receipt for every grant, reference counted

Every grant has a receipt, chained to the one before it. When two policies grant the same access the platform keeps it until the last one ends: remove one policy and the other still holds the access. Overlap is the case a naive clean-up gets wrong.

## Drift: access granted outside Privilege

Press "someone grants access by hand" and then reconcile. The finding names the platform, the person and the level, and the nightly reconcile finds it again. The reaper cannot remove it, because it was never a grant. After the reaper, drift remains.

## One model for people and agents

An engineer asking for a warehouse role and an agent asking for a peer's capability are the same decision, recorded the same way, in one audit trail. The only difference is the subject. refund-assistant is an agent; omar.reyes is its custodian.

## Why it matters: SaaS Access Management (slide 51)

Challenge: standing access accumulates and nobody can say who still holds what; audit findings on standing access stall the review. Technical: request, approve, expire, revoke as one cycle across six platforms, with a reaper and nightly drift detection. Business: standing-access audit findings close without manual clean-up: lower risk, less compliance effort, and the same JIT model as agents. These are Ping claims, unverified on our tenant.

## What this is not

This is a simulation of Ping's release claims, which are unverified on our tenant. The six platforms are in-process models, nothing is sent anywhere, and every shape that the console schema does not give is the lab's own and tagged so.

## The six scripted scenarios (Mock mode)

1. **An engineer asks for a warehouse role.** Two approval levels route to the data owner and then to the security group; every grant carries an expiry; the reaper removes the role when the window closes.
2. **Self-approval is refused.** lee.park asks for access during a payments settlement incident and tries to approve their own request. The lab refuses, and says why. A colleague in the security group approves.
3. **Low-risk access is approved by policy.** Read access for up to two hours is approved by the policy itself, recorded as such, and still removed on time.
4. **Two policies grant the same access.** A routine write grant and an incident grant overlap on the same repository. When the shorter one ends, the access stays, because the other policy still grants it. It goes only when the last reference does.
5. **An agent and an engineer, one model.** An agent asks for a Unity Catalog privilege and an engineer asks for the same one. Same policy, same approval, same receipt, one audit trail: the only difference is the subject.
6. **Access granted outside Privilege.** Someone grants access by hand on the platform. The reconcile finds it, a nightly run finds it again, and the reaper cannot remove it because it was never a grant.

## Not demonstrated

- Anything about how the real console, a real platform, Slack, Mattermost, Teams, Jira or ServiceNow behaves: nothing here ran against one. The six platforms are the lab's in-process models, and the API calls shown are illustrations of typical public API shapes that are never sent.
- Team-to-repository on GitHub and profiles on Salesforce: the deck lists them; the lab does not model them (the first has a team as its subject, the second is single-valued and needs a swap-and-restore).
- Authentication: the lab holds no credential for any platform. It names each platform's auth method (as the deck lists it) and nothing more; credential-shaped values typed into a field are masked and never kept (a heuristic: not every secret has a recognisable shape, so do not type a real one).
- GitHub Enterprise Server and self-managed GitLab: named by the deck, not modelled separately.
- The product's real reaper schedule, its nightly reconcile time, its receipt format and its approval-window rules: the lab's are lab-invented and labelled so.
- Profile-level SSO and sync behaviour (EnableSSO, SSOUrl, TokenOwner, Error and the team fields ParentTeamId and NotificationSetting exist in the schema; the lab does not model them).
