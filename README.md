# SaaS Access LAB

A simulation of Ping's SaaS Access Management release claims: just-in-time, time-bound access to GitHub, GitLab, Salesforce, Snowflake, Databricks and Google Workspace, requested, approved, removed automatically when the window closes, with a receipt for every grant and nightly drift detection, the same for people and for agents.

Tier: Demo
Repo: https://github.com/ping-sandbox/saas-access-LAB
Catalog: none assigned yet (the content pack carries the placeholder D0)

**Tier: Demo.** Source: the Ping ID4AI Workforce H2 2026 deck, slide 51 (and 35), release 2026-11-02. **Every product claim is a Ping release claim, UNVERIFIED on our tenant.** Nothing here calls a real platform, chat tool, ticket system, gateway, identity provider or tenant, and nothing leaves your machine.

## What is simulated

**Mock mode (default).** Everything runs offline in one process and is read-only. Six scripted scenarios (a warehouse role with two approval levels, self-approval refused, auto-approval by policy, two policies granting the same access, an agent and an engineer under one model, access granted outside Privilege) were run through the lab's own engine, and the tables the pages show are generated from that run (`server/src/mockTable.json`; a doctor check and a test fail if it drifts). Every write is refused with 409.

**Live mode (owner-run, still local).** The same engine acts on your own requests. Each of the six platforms holds real state in this process (repository collaborators and team members, group and project members, permission set assignments, role members, Unity Catalog privilege holders, admin role assignees). You move a **lab clock** (+15 minutes, +1 hour, +1 day), so expiry and the reaper run for real. The banner says which mode you are in. Live never leaves loopback and never touches a platform or a tenant.

What it shows:

1. **Request.** Pick a platform, a resource, a level, a duration, a subject (human or agent), who is asking, a policy and a reason. The approval chain is shown before anything is created: who is routed to at each level and who is not allowed to act. A request with no expiry cannot be made. The policy is editable (level, window, approval window, chat channel, a different person at every level, the chain of one to three levels, auto-approval) and retirable.
2. **Approvals.** The inbox, with who is allowed. Act as any person (the lab has no sign-in) and try the wrong one: the requester, an agent, someone not routed to the level, or a notify-only channel. Slack and Mattermost carry Approve and Deny; Teams, Jira and ServiceNow only receive notifications and tickets (simulated outbox, never sent). Hitl switches decide where approvers are told.
3. **Timeline.** The lab clock, the grants with their receipts and reference counts, the live holdings, and the audit trail with a reaper-and-drift filter. The clock only moves forward.
4. **Drift.** Platform state against receipts. "Someone changes the platform by hand" grants or removes access outside Privilege; the reconcile (nightly at 02:00 lab time, or by the button) flags unrecorded, elevated and missing access, and an unrecorded or elevated finding can be revoked on the platform.
5. **Platforms.** The six platforms: what each grants, its auth METHOD name (never a credential: the lab holds none) and the platform's own state. A Sync switch for Databricks, Salesforce and Snowflake.
6. **Diagram.** ReactFlow, drawn from diagram-studio/1 data loaded by name: movable boxes, Simulate, speed, Reset (restores box positions). Two diagrams: request to removal; drift and reconcile.
7. **Talk track,** with a "Why it matters" entry (challenge, technical and business lines, marked as Ping claims). Also in `docs/talk-track.md`. Three vertical packs (finance, health, retail) change every name.

### What is lab-invented

The deck gives claims; the console swagger of 2026-10-31 (schema only) gives field names. Everything else here is the lab's own, and each field is tagged in the app as "console swagger name (schema only)", "lab reading" or "lab-invented" (a swagger name proves a field exists, not how it behaves):

- **Swagger names used as a lab reading.** `Sync` (the schema gives it to the Databricks, Salesforce and Snowflake account objects; the lab reads it as "the reconcile reads this platform"), `Hitl` (Slack integration, Jira project, ServiceNow table; the lab uses it as where approval requests go), `ApproverNotifications`, `WorkspaceID`, `RetiredAt` and the approval fields (`RequiredApprovals`, `RequireDistinctApprovers`, `Approvers`, `ExpiresAt`, `NotifiedLevel`, `ApprovedBy`, `DeniedBy`, `DecidedAt`, `GrantID`, `JiraTicketID`, `ServiceNowTableRecordId`, `MsTeamsChannelMsgID` and others). They belong to agent approvals and to integration objects; reusing them for SaaS access requests is the lab's reading. `EnableSSO`, `SSOUrl`, `TokenOwner`, `Error`, `ParentTeamId` and `NotificationSetting` exist in the schema and are not modelled.
- **Everything about requests, grants, receipts, policies, drift findings and the audit trail.** The request and grant shapes, the three-state grant, the four approver roles, the 1 to 3 level chain, the auto-approval rule, the 7 day cap, the approval window, the highest-level and restore-to-what-it-was rules for reference counting, the reaper's 5 lab minute wake-up, the 02:00 nightly reconcile, the three finding kinds and the remediation.
- **The receipt hash chain.** Each receipt carries the sha256 of the one before it, so a change to any of them is detectable (verified from the receipts, not stored). The product's receipt format is not public.
- **The platform call shapes** (a GitHub collaborator PUT, a Snowflake GRANT, a Unity Catalog PATCH and so on) on `.example` hosts. Illustrations of typical public API shapes; never sent. Authentication shows the method name only.
- **The roster, the verticals, the lab clock and who may ask** (the subject, or the subject's manager or an agent's custodian).

### Known limits of the model

- The deck lists team-to-repository (GitHub) and profiles (Salesforce); the lab does not model them (the first has a team as its subject, the second is single-valued and needs a swap-and-restore). GitHub Enterprise Server and self-managed GitLab are named, not modelled separately.
- A request is for at least 1 minute and at most the policy maximum (itself at most 10080 minutes, 7 days). A reason is at most 300 characters and a comment 200; credential-shaped text is masked. A workspace keeps at most 200 requests, 200 grants, 500 audit entries, 300 outbox entries and 400 platform entries: a full workspace refuses new work (Reset) instead of dropping anything. The clock moves forward only, at most 7 days per move. One answer shows at most 40 hops.
- The reaper wakes every 5 lab minutes and at the end of every move, so a removal inside a long move is stamped at the next wake-up (the lag is shown). The nightly reconcile runs once per night the clock crosses 02:00. Findings change only when a reconcile runs; the live diff does not wait.
- A grant starts when the last level approves. A policy edit applies to new requests only; a waiting request keeps the chain it was created with.
- A chain that asks the same person at two levels under "a different person at every level" is created and later expires; the lab does not detect that deadlock up front.
- Self-approval is never a setting. The lab has no sign-in: you choose who acts, so you can try the wrong person.

## Run from a clone

Prerequisites: Node 26 or newer. Docker only if you use the Docker form. Mock mode works with no setup at all: no tenant, no credentials, no settings file.

```
git clone https://github.com/ping-sandbox/saas-access-LAB.git
cd saas-access-LAB
npm ci
npm run build
npm start
```

Open http://localhost:7250/. Or in one step: `./scripts/run.sh` (installs and builds if needed, runs the doctor, starts).

## Settings file

All standalone apps read one settings file, `~/Development/.env`, which must be mode 600. `STANDALONE_ENV` overrides its path. This lab needs none of it. It parses the file (`util.parseEnv`) and takes exactly one optional key; no other key from the file ever enters the server's environment:

- `SAL_LAB_MODE` (optional): `mock` (default) or `live`, the mode the page opens in. The header toggle switches per visit. A bare `MODE` in the shared file is ignored, because it may belong to another app.

The shared file holds no `PORT`: the lab keeps its port default in code. Admin or worker credentials never belong in that file (they live in `~/.config/demo-kit/provisioning.json`), and this lab uses none. It holds no credential for any platform either. The doctor reports whether the file exists and its mode, and never prints a value.

## Ports, and what to do if the port is taken

```
Ports: saas-access-LAB listens on 7250 (set with PORT, default 7250).
Port range for this app: 7250-7299.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7250 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.
```

Other variables: `VITE_PORT` (Vite dev server, default 7251, `npm run dev -w web`), `HOST_PORT` (Docker host port, default 7250). Keep all of them inside 7250-7299.

## Mock and live modes

The header has a **Mock / Live** toggle on every page, and the banner and the mode chip show the same mode. Mock reads tables generated from the engine (six scripted scenarios per vertical; a scenario picker on the Request tab) and is read-only: every write control is off and the API answers 409. Live drives this workspace's engine (one per vertical), keeps its requests, grants, receipts, platform state, outbox, audit trail and lab clock, and lets you edit the policies and the integrations.

## Health, doctor and reset

```
npm run doctor   # 20 checks, including one real request-approve-expire cycle through the HTTP API; PORT=7259 npm run doctor to use a spare port
npm run reset    # clears the default workspace (requests, grants, receipts, platform state, outbox, audit trail, clock, edited policies); the UI Reset also restores the diagram
```

`GET /api/health` returns `demo-health/1`. The workspace id comes in `X-Workspace`; every hop carries a W3C `traceparent`, and every write answers with the raw hops, including the simulated platform calls and notifications. Presenter mode: press `P` (Esc leaves); the simulation banner stays. `npm run mock-table`, `npm run talk-track` and `npm run content-pack` regenerate the generated files. See `docs/safety.md`.

## Docker (optional)

```
HOST_PORT=7250 docker compose up --build -d
```

The container publishes to 127.0.0.1 only (a test pins it), runs as a non-root user with a read-only file system and no capabilities. Use OrbStack, not Docker Desktop. `SAL_LAB_MODE=live` opens the page in Live mode.

## Tests

```
npm test    # server (node --test), web (vitest, drives the UI against the real server), scripts
```

The shared checks are run by hand, because the scripts are not shipped into this repo's CI: `bash <AI-DEMO-Standalone>/scripts/check-drift.sh .`, `bash <AI-DEMO-Standalone>/scripts/check-css.sh .` and `node <demo-kit-base>/scripts/conformance.mjs . --new`. Conformance reports two rule-18 FAILs on purpose: the deferred SE k8s manifests, and a heuristic that greps for `process.env.MODE` (this lab reads `SAL_LAB_MODE` instead, because the shared settings file is read by every app).

On Node 26: 234 tests pass (179 server, 32 web, 23 scripts).

## Troubleshooting

- **The page says "Could not load the lab".** The server is not running, or it is on another port. Start it (`npm start`) and check `PORT`.
- **Port is taken.** See "Ports, and what to do if the port is taken" above.
- **`npm start` refuses to start.** Run `npm run doctor`; the first failing line says why (Node older than 26, a port outside 7250-7299, a drifting mock table).
- **A button is greyed out.** Mock is read-only. Switch to Live in the header.
- **A request is refused.** The message names the reason (a duration that is not a whole number, a level above the policy, nobody eligible to approve). Nothing is created by a refused request.
- **The mock table is out of date after an engine change.** Run `npm run mock-table`; the doctor and a test tell you when it drifts.

## Ownership

- Owner: the Ping demo family owner (Demo tier).
- License: MIT (see `LICENSE`).
- Found a problem? Open an issue on the repo.

## Not done

No SE k8s build (deferred by the owner, 2026-10-31). No catalog id yet. Every product claim stays UNVERIFIED until it is measured on a tenant that has the release. Team-to-repository and Salesforce profiles are not modelled; the six platforms are in-process models, not the real products.
