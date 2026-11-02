// These tests drive the real UI against the real Express app (started on a loopback port inside the test), so a green run means the pieces
// actually work together: the real story data, the real engine, the real Mock table.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { VERTICALS } from "../../server/src/cast.js";
import App, { BANNER_UNKNOWN, TABS } from "./App";
import { labelOffsets } from "./components/PatternDiagram";
import { visible } from "./safeText";
import { forgetWorkspace } from "./workspace";

const C = VERTICALS.finance;
let server; let base; const realFetch = globalThis.fetch; let seen = [];
let delay = () => 0;
let override = () => null; // a test may answer a request itself
let pending = 0;            // requests that have started and not yet answered
beforeAll(async () => {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json" }) }));
  base = base.replace(/\/$/, "");
  globalThis.fetch = async (u, init = {}) => {
    const url = typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u;
    seen.push({ url: String(url), body: typeof init.body === "string" ? init.body : "", ws: init.headers?.["x-workspace"] });
    pending += 1;
    try {
      const own = override(String(url), init); if (own) return own;
      const ms = delay(String(url), init); if (ms) await new Promise((r) => setTimeout(r, ms));
      const r = await realFetch(url, { ...init, headers: { origin: base, ...(init.headers || {}) } });
      await r.clone().text(); // the body has arrived too
      return r;
    } finally { pending -= 1; }
  };
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => { cleanup(); forgetWorkspace(); seen = []; delay = () => 0; override = () => null; pending = 0; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; });

const T = { timeout: 20000 };
const REFUSED_ID = ["abcdefghijklmnop", "qrstuv12"].join(""); // passes the page's own rule; the server's masker refuses it
const mount = async () => { render(<App />); await screen.findByTestId("scenarios", {}, T); };
const tab = (name) => userEvent.click(screen.getByRole("tab", { name }));
const click = (id) => userEvent.click(screen.getByTestId(id));
const live = async () => { await click("mode-live"); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/)); await screen.findByTestId("request-form", {}, T); await waitFor(() => expect(screen.getByTestId("reason")).toBeInTheDocument()); };
const setValue = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } });
const pick = (id, value) => userEvent.selectOptions(screen.getByTestId(id), value);
// Submit the default request (write on the core repository, 60 minutes, routed to the manager and then the owner).
const submitDefault = async () => {
  await waitFor(() => expect(screen.getByTestId("submit-request")).toBeEnabled(), T);
  await click("submit-request");
  await waitFor(() => expect(screen.getByTestId("request-message")).toHaveTextContent(/req-0001 is pending/), T);
};
const approveAs = async (who, testId = "approve") => {
  await tab("Approvals");
  await screen.findByTestId("inbox", {}, T);
  await pick("actor", who);
  await waitFor(() => expect(screen.getByTestId(testId)).toBeEnabled(), T);
  await click(testId);
  await waitFor(() => expect(screen.getByTestId("decision-message")).toBeInTheDocument(), T);
};
// Wait until every request the page has made has been answered and the page has had a turn to show the answer (no fixed sleep).
const settled = async () => { await waitFor(() => expect(pending).toBe(0), { timeout: 20000 }); await new Promise((r) => setTimeout(r, 60)); await waitFor(() => expect(pending).toBe(0), { timeout: 20000 }); };
const wholePageText = () => { const c = document.body.cloneNode(true); c.querySelectorAll("textarea,input").forEach((n) => n.remove()); return c.textContent; };

describe("shell", () => {
  it("says it is simulated and UNVERIFIED on every tab, in presenter mode too, and shows the mode", async () => {
    await mount();
    expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/);
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    for (const t of TABS) {
      await tab(t.label);
      expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED on our tenant/);
      expect((await screen.findAllByTestId("claim-tag", {}, T)).length).toBeGreaterThan(0);
    }
    await tab("Request");
    await userEvent.keyboard("p");
    expect(screen.getByTestId("presenter-say")).toBeInTheDocument();
    expect(screen.getByTestId("banner")).toHaveTextContent(/SIMULATED/);
    expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED on our tenant/);
    expect(screen.getByTestId("presenter")).toHaveTextContent("Exit presenter");
    for (const t of TABS.filter((x) => x.id !== "talk")) { await tab(t.label); expect(screen.getByTestId("presenter-say")).toBeInTheDocument(); expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED/); }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("presenter-say")).toBeNull();
    expect(BANNER_UNKNOWN).toMatch(/UNVERIFIED/);
  });

  it("the banner and the mode chip follow the toggle, in both directions, on every tab", async () => {
    await mount();
    await click("mode-live");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/));
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
    for (const t of TABS) { await tab(t.label); expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/); expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "live"); }
    await click("mode-mock");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/));
  });

  it("the choice of mode is remembered, and a blocked storage never breaks the page", async () => {
    await mount(); await click("mode-live");
    await waitFor(() => expect(window.localStorage.getItem("sal.mode")).toBe("live"));
    cleanup(); render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/), T);
  });

  it("arrow keys move between tabs, and the URL hash follows", async () => {
    await mount();
    screen.getByRole("tab", { name: "Request" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Approvals" })).toHaveAttribute("aria-selected", "true");
    expect(window.location.hash).toBe("#approvals");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Talk track" })).toHaveAttribute("aria-selected", "true");
  });

  it("talks only to its own origin", async () => {
    await mount(); await live();
    for (const t of TABS) await tab(t.label);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((s) => s.url.startsWith(base))).toBe(true);
  });
});

describe("Mock mode: six scripted scenarios, read-only", () => {
  it("shows a scenario and its steps; switching scenario changes the state every tab shows", async () => {
    await mount();
    expect(screen.getByTestId("scenario-steps").querySelectorAll("li").length).toBe(5);
    await click("scenario-self-approval");
    await waitFor(() => expect(screen.getByTestId("scenario-steps")).toHaveTextContent(/self_approval_refused/), T);
    expect(screen.getByTestId("scenario-steps")).toHaveTextContent(/the approver made this request/);
    await tab("Timeline");
    expect(await screen.findByTestId("grants")).toBeInTheDocument();
    await tab("Request"); await click("scenario-overlap"); await tab("Timeline");
    await waitFor(() => expect(within(screen.getByTestId("holdings")).getAllByRole("row").length).toBe(2), T);
    expect(screen.getByTestId("holdings")).toHaveTextContent(/write/);
    await tab("Drift"); await tab("Request"); await click("scenario-drift"); await tab("Drift");
    await waitFor(() => expect(screen.getAllByTestId("finding-row").length).toBe(2), T);
  });

  it("every write control is off in Mock, and a note says to switch to Live", async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toBeInTheDocument(), T);
    expect(screen.getByTestId("submit-request")).toBeDisabled();
    expect(screen.getByTestId("pe-save")).toBeDisabled();
    await tab("Approvals"); expect(screen.getByTestId("ig-slack")).toBeDisabled();
    await tab("Timeline"); for (const id of ["adv-15", "adv-60", "adv-1440", "adv-custom", "adv-back", "reap"]) expect(screen.getByTestId(id)).toBeDisabled();
    await tab("Drift"); expect(screen.getByTestId("oob-go")).toBeDisabled(); expect(screen.getByTestId("reconcile")).toBeDisabled();
    await tab("Platforms"); expect(screen.getByTestId("sync-snowflake")).toBeDisabled();
    expect(seen.filter((s) => /\/api\/(requests|clock|reaper|drift|platforms|policies|integrations)/.test(s.url) && s.body).length).toBe(0);
  });

  it("the chain preview works in Mock without creating anything", async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toHaveTextContent(/Needs 2 approval level/), T);
    expect(screen.getByTestId("preview-chain")).toHaveTextContent(C.castManager);
    expect(screen.getByTestId("preview-chain")).toHaveTextContent(C.castOwner);
  });
});

describe("Request tab (Live)", () => {
  it("shows the approval chain before anything is created, and the policy follows the level and the window", async () => {
    await mount(); await live();
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toHaveTextContent(/Needs 2 approval level/), T);
    expect(screen.getByTestId("policy")).toHaveValue("pol-code-write");
    await pick("level", "read"); setValue("duration", "60");
    await waitFor(() => expect(screen.getByTestId("preview-auto")).toHaveTextContent(/approves this request automatically/), T);
    expect(screen.getByTestId("policy")).toHaveValue("pol-code-read");
    setValue("duration", "500");
    await waitFor(() => expect(screen.getByTestId("preview-error")).toBeInTheDocument(), T);
    expect(screen.getByTestId("submit-request")).toBeDisabled();
  });

  it("platform, resource and level selectors follow each other for all six platforms, and each shows its policy", async () => {
    await mount(); await live();
    for (const [pid, first, level] of [["gitlab", "gl-group-platform", "guest"], ["salesforce", "sf-permset-reader", "assigned"], ["snowflake", "snow-role-analyst", "member"], ["databricks", "dbx-schema-gold", "SELECT"], ["google", "gw-role-helpdesk", "assigned"], ["github", "gh-repo-core", "read"]]) {
      await pick("platform", pid);
      await waitFor(() => expect(screen.getByTestId("resource")).toHaveValue(first), T);
      await waitFor(() => expect(screen.getByTestId("level")).toHaveValue(level), T);
      await waitFor(() => expect(screen.getByTestId("policy").value).toMatch(/^pol-/), T);
    }
    await pick("resource", "gh-team-releases");
    await waitFor(() => expect(screen.getByTestId("level")).toHaveValue("member"), T);
    await waitFor(() => expect(screen.getByTestId("policy")).toHaveValue("pol-release-team"), T);
  });

  it("an agent subject lists only agents and routes to its custodian", async () => {
    await mount(); await live();
    await pick("subject-kind", "agent");
    await waitFor(() => expect(screen.getByTestId("subject")).toHaveValue(C.castAgent), T);
    expect(within(screen.getByTestId("subject")).getAllByRole("option").map((o) => o.value)).toEqual([C.castAgent, C.castAgent2]);
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toHaveTextContent(C.castEngineer2), T);
  });

  it("a request is created and shows up in the approvals inbox with the right approver and the hops", async () => {
    await mount(); await live();
    await submitDefault();
    expect(screen.getByTestId("last-action")).toHaveTextContent(/POST \/api\/requests done/);
    expect(screen.getByTestId("hops")).toHaveTextContent(/traceparent/);
    await tab("Approvals");
    const inbox = await screen.findByTestId("inbox", {}, T);
    expect(within(inbox).getByTestId("pending-level")).toHaveTextContent(new RegExp(`Level 1 of 2: manager.*${C.castManager}`));
    await tab("Request"); // the form is still there
  });

  it("a credential typed as the reason is masked everywhere on the page, in the hops and in the request, and never comes back", async () => {
    await mount(); await live();
    const secret = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    setValue("reason", `use ${secret} please`);
    await submitDefault();
    expect(wholePageText()).not.toContain(secret);
    await tab("Approvals"); await screen.findByTestId("inbox", {}, T);
    expect(wholePageText()).not.toContain(secret);
    expect(wholePageText()).toContain("[masked]");
    await tab("Timeline"); expect(wholePageText()).not.toContain(secret);
    expect(seen.some((s) => s.body.includes(secret))).toBe(true); // the visitor's own request carried it; nothing comes back
  });

  it("a stored workspace id the server refuses (400 bad_workspace) does not brick the tab: the page makes a new id, asks once more, and the lab works", async () => {
    window.sessionStorage.setItem("sal.workspace", REFUSED_ID); // passes the page's own rule; the server's masker refuses it
    await mount(); await live();
    const first = seen.find((s) => s.url.includes("/api/state"));
    expect(first.ws).toBe(REFUSED_ID);
    const later = seen.filter((s) => s.ws && s.ws !== REFUSED_ID);
    expect(later.length).toBeGreaterThan(0); expect(later.every((s) => /^w-[0-9a-f]{16}$/.test(s.ws))).toBe(true);
    expect(window.sessionStorage.getItem("sal.workspace")).toMatch(/^w-[0-9a-f]{16}$/);
    await submitDefault(); // a write works in the new workspace
  });

  it("a stored id that the page's own rule refuses (a credential-looking one) is never sent", async () => {
    window.sessionStorage.setItem("sal.workspace", ["pw", "-hunter2xyz"].join(""));
    await mount();
    expect(seen.every((s) => !(s.ws || "").includes("hunter2xyz"))).toBe(true);
  });

  it("a refused request shows its reason and creates nothing (a duration that is not a whole number)", async () => {
    await mount(); await live();
    setValue("duration", "0");
    await waitFor(() => expect(screen.getByTestId("preview-error")).toHaveTextContent(/expiry/), T);
    expect(screen.getByTestId("submit-request")).toBeDisabled();
  });

  it("a late chain preview for an earlier form never overwrites the newer one (stale-response guard)", async () => {
    await mount(); await live();
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toBeInTheDocument(), T);
    delay = (url, init) => (/preview/.test(url) && /"level":"read"/.test(init.body || "") ? 900 : 0);
    await pick("level", "read");           // slow answer, will arrive last
    await pick("level", "triage");         // fast answer for the newer form
    await waitFor(() => expect(screen.getByTestId("preview-chain")).toHaveTextContent(/Needs 2 approval level/), T);
    expect(seen.some((x) => /preview/.test(x.url) && /"level":"read"/.test(x.body))).toBe(true); // the slow request really was sent
    await settled();                                  // ...and has now been answered
    expect(screen.getByTestId("preview-chain")).toHaveTextContent(/Needs 2 approval level/);
    expect(screen.queryByTestId("preview-auto")).toHaveTextContent(/Needs 2 approval level/);
  });
});

describe("agents, denial and stale answers", () => {
  it("an agent asks for a Unity Catalog privilege and is auto-approved by policy; the grant is shown with its subject kind", async () => {
    await mount(); await live();
    await pick("subject-kind", "agent");
    await waitFor(() => expect(screen.getByTestId("subject")).toHaveValue(C.castAgent), T);
    await pick("platform", "databricks");
    await waitFor(() => expect(screen.getByTestId("level")).toHaveValue("SELECT"), T);
    await waitFor(() => expect(screen.getByTestId("policy")).toHaveValue("pol-lakehouse"), T);
    await waitFor(() => expect(screen.getByTestId("preview-auto")).toHaveTextContent(/approves this request automatically/), T);
    await waitFor(() => expect(screen.getByTestId("submit-request")).toBeEnabled(), T);
    await click("submit-request");
    await waitFor(() => expect(screen.getByTestId("request-message")).toHaveTextContent(/is granted \(grant g-0001\)/), T);
    await tab("Timeline");
    expect((await screen.findByTestId("grant-row", {}, T))).toHaveTextContent(new RegExp(`agent ${C.castAgent}`));
    expect(screen.getByTestId("grants")).toHaveTextContent(/policy:pol-lakehouse/);
    await tab("Platforms");
    await waitFor(() => expect(screen.getByTestId("platform-databricks")).toHaveTextContent(new RegExp(`${C.castAgent} \\(SELECT\\)`)), T);
  });

  it("a denied request leaves the inbox, shows as denied with who denied it, and cannot be approved afterwards", async () => {
    await mount(); await live(); await submitDefault();
    await approveAs(C.castManager, "deny");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toHaveTextContent(/req-0001: denied/), T);
    expect(screen.getByTestId("no-pending")).toBeInTheDocument();
    expect(screen.getByTestId("decided")).toHaveTextContent(new RegExp(`denied.*${C.castManager} \\(denied\\)`));
    expect(screen.getByTestId("decided")).toHaveTextContent(/2026-11-02 09:00/);
  });

  it("a late scenario answer never overwrites the scenario picked after it (stale-response guard on the state)", async () => {
    await mount();
    delay = (url) => (/scenario=overlap/.test(url) ? 1000 : 0);
    await click("scenario-overlap");     // slow
    await click("scenario-drift");       // fast, picked later
    await waitFor(() => expect(screen.getByTestId("scenario-steps")).toHaveTextContent(/administrator raises/), T);
    expect(seen.some((x) => /scenario=overlap/.test(x.url))).toBe(true);
    await settled();
    expect(screen.getByTestId("scenario-steps")).toHaveTextContent(/administrator raises/);
    expect(screen.getByTestId("scenario-drift")).toHaveAttribute("aria-pressed", "true");
    await tab("Drift");
    await waitFor(() => expect(screen.getAllByTestId("finding-row").length).toBe(2), T);
  });

  it("a write answer for a mode the visitor has already left is not shown (stale write guard)", async () => {
    await mount(); await live();
    await waitFor(() => expect(screen.getByTestId("submit-request")).toBeEnabled(), T);
    delay = (url, init) => (/\/api\/requests$/.test(url) && init.method === "POST" ? 800 : 0);
    await click("submit-request");
    await click("mode-mock");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/));
    expect(seen.some((x) => /\/api\/requests$/.test(x.url) && x.body.includes('"mode":"live"'))).toBe(true); // the write really was sent
    await settled();
    expect(screen.queryByTestId("last-action")).toBeNull();
    expect(screen.getByTestId("scenario-steps")).toBeInTheDocument();
  });
});

describe("a write is a success only when the body says so (S7)", () => {
  it("a 200 whose body lacks ok is shown as a refusal, never as a success, and the page does not throw", async () => {
    await mount(); await live(); await submitDefault();
    await tab("Approvals"); await screen.findByTestId("inbox", {}, T);
    override = (url, init) => (/\/decision$/.test(url) && init.method === "POST" ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) : null);
    await waitFor(() => expect(screen.getByTestId("approve")).toBeEnabled(), T);
    await click("approve");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toBeInTheDocument(), T);
    expect(screen.getByTestId("decision-message")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("decision-message")).toHaveTextContent(/refused/);
    expect(screen.getByTestId("decision-message")).not.toHaveTextContent(/pending|granted/);
    expect(screen.getByTestId("inbox")).toBeInTheDocument();
  });

  it("a 200 with ok false (a refusal as data) is shown as a refusal with its reason; ok true is the only success", async () => {
    await mount(); await live(); await submitDefault();
    await approveAs(C.castEngineer);
    expect(screen.getByTestId("decision-message")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("decision-message")).toHaveTextContent(/self_approval_refused/);
    expect(seen.some((x) => x.body.includes('"refusalsAs200":true'))).toBe(true);
    for (const body of ["null", "[]", '{"ok":"true"}', '{"ok":1}', '{"result":{"status":"granted"}}']) {
      override = (url, init) => (/\/clock$/.test(url) && init.method === "POST" ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : null);
      await tab("Timeline"); await waitFor(() => expect(screen.getByTestId("adv-60")).toBeEnabled(), T);
      await click("adv-60");
      await waitFor(() => expect(screen.getByTestId("clock-message")).toHaveAttribute("role", "alert"), T);
      expect(screen.getByTestId("clock-message")).not.toHaveTextContent(/The clock moved/);
    }
  });
});

describe("explanations the reviewer asked for", () => {
  it("S4: a request whose levels share their only approver is refused up front in the form, with the reason in words, and cannot be submitted", async () => {
    await mount(); await live();
    await pick("subject-kind", "agent");
    await pick("subject", C.castAgent2);
    await waitFor(() => expect(screen.getByTestId("preview-error")).toHaveTextContent(/different person at every level/), T);
    expect(screen.getByTestId("submit-request")).toBeDisabled();
  });

  it("S5: the policy editor says that a waiting request keeps its chain and channel but is checked against the policy again at the last approval", async () => {
    await mount(); await live();
    await userEvent.click(screen.getByText(/Edit the policy/));
    expect(screen.getByTestId("policy-editor")).toHaveTextContent(/keeps its approval chain and its chat channel/);
    expect(screen.getByTestId("policy-editor")).toHaveTextContent(/checked against the policy again when the last level approves/);
  });

  it("S1/S8: the wording does not overclaim masking, and Sync and Hitl are tagged as the lab's reading beside the behaviour", async () => {
    await mount(); await live(); await tab("Platforms");
    await waitFor(() => expect(screen.getByTestId("platform-snowflake")).toBeInTheDocument(), T);
    expect(wholePageText()).toMatch(/not every secret has a recognisable shape/);
    expect(wholePageText()).not.toMatch(/a token or key typed anywhere is masked/);
    expect(screen.getByTestId("sync-snowflake").closest("label")).toHaveTextContent(/lab reading/);
    expect(screen.getByTestId("sync-snowflake").closest("label")).not.toHaveTextContent(/console swagger/);
    await tab("Approvals");
    expect(screen.getByTestId("integrations")).toHaveTextContent(/lab reading/);
    expect(screen.getByTestId("integrations")).not.toHaveTextContent(/console swagger name \(schema only\)/);
  });
});

describe("policy editor (Live)", () => {
  it("saves an edit that changes the next preview; a refused edit lists every reason; Retire removes the policy from the list", async () => {
    await mount(); await live();
    await userEvent.click(screen.getByText(/Edit the policy/));
    await waitFor(() => expect(screen.getByTestId("pe-maxduration")).toBeEnabled(), T);
    setValue("pe-maxduration", "30");
    await click("pe-save");
    await waitFor(() => expect(screen.getByTestId("pe-maxduration")).toHaveValue(30), T);
    await pick("policy", "pol-code-write"); setValue("duration", "60");
    await waitFor(() => expect(screen.getByTestId("preview-error")).toHaveTextContent(/longer than the policy allows/), T);
    setValue("pe-maxduration", "0"); await click("pe-remove-1");
    await waitFor(() => expect(screen.getByTestId("pe-remove-0")).toBeDisabled(), T);
    await click("pe-save");
    await waitFor(() => expect(screen.getByTestId("pe-errors")).toHaveTextContent(/maxDurationMin must be a whole number/), T);
    await click("pe-retire");
    await waitFor(() => expect(within(screen.getByTestId("policy")).queryByText("Write access to code")).toBeNull(), T);
  });

  it("every editable field is on the form: level, window, approval window, channel, distinct approvers, chain, auto-approve", async () => {
    await mount(); await live();
    await userEvent.click(screen.getByText(/Edit the policy/));
    for (const id of ["pe-maxlevel", "pe-maxduration", "pe-ttl", "pe-channel", "pe-distinct", "pe-role-0", "pe-required-0", "pe-add", "pe-auto", "pe-auto-level", "pe-auto-duration", "pe-save", "pe-retire"]) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.getByTestId("policy-editor")).not.toHaveTextContent(/self-approval.*(allow|permit)/i);
    expect(screen.getByTestId("policy-editor")).toHaveTextContent(/always refused/);
  });
});

describe("the whole cycle, in the UI: request, approve, refuse the wrong person, move the clock, reaped, then drift", () => {
  it("does it end to end", async () => {
    await mount(); await live();
    await submitDefault();
    // the requester cannot approve their own request
    await approveAs(C.castEngineer);
    expect(screen.getByTestId("decision-message")).toHaveTextContent(/refused \(self_approval_refused\)/);
    expect(screen.getByTestId("decision-message")).toHaveTextContent(/approver made this request/);
    // an agent cannot
    await pick("actor", C.castAgent); await click("approve");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toHaveTextContent(/approver_not_human/), T);
    // a notify-only channel cannot
    await pick("actor", C.castManager); await pick("via", "jira");
    await waitFor(() => expect(screen.getByTestId("approve")).toBeEnabled(), T);
    await click("approve");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toHaveTextContent(/channel_notify_only/), T);
    // level 1 and level 2, in the right order, in Slack
    await pick("via", "slack");
    await click("approve");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toHaveTextContent(/now at level 2/), T);
    await waitFor(() => expect(screen.getByTestId("pending-level")).toHaveTextContent(new RegExp(`Level 2 of 2: resource-owner.*${C.castOwner}`)), T);
    await pick("actor", C.castOwner);
    await waitFor(() => expect(screen.getByTestId("approve")).toBeEnabled(), T);
    await click("approve");
    await waitFor(() => expect(screen.getByTestId("decision-message")).toHaveTextContent(/req-0001: granted/), T);
    expect(screen.getByTestId("no-pending")).toBeInTheDocument();
    expect(screen.getByTestId("outbox")).toHaveTextContent(/pulled|none \(notify only\)/);
    // the grant, with its expiry, and the reference count
    await tab("Timeline");
    const row = await screen.findByTestId("grant-row", {}, T);
    expect(row).toHaveTextContent(/active/); expect(screen.getByTestId("refcount")).toHaveTextContent("1");
    expect(screen.getByTestId("receipt-chain")).toHaveTextContent(/verified \(1 receipts/);
    expect(screen.getByTestId("receipt-head")).toHaveTextContent(/Head [0-9a-f]{16}\.\.\. of 1 receipt/);
    expect(screen.getByTestId("receipt-head")).toHaveTextContent(/can forge the chain/);
    expect(screen.getByTestId("holdings")).toHaveTextContent(C.castEngineer);
    // going back is refused
    await waitFor(() => expect(screen.getByTestId("adv-back")).toBeEnabled(), T);
    await click("adv-back");
    await waitFor(() => expect(screen.getByTestId("clock-message")).toHaveTextContent(/clock_backwards/), T);
    expect(screen.getByTestId("clock")).toHaveTextContent("2026-11-02 09:00");
    // an hour on: the reaper removes it
    await click("adv-60");
    await waitFor(() => expect(screen.getByTestId("clock-message")).toHaveTextContent(/Reaped: 1 grant/), T);
    expect(screen.getByTestId("clock")).toHaveTextContent("2026-11-02 10:00");
    expect(within(screen.getByTestId("grants")).getByTestId("grant-row")).toHaveTextContent(/expired/);
    expect(screen.queryByTestId("holdings")).toBeNull();
    expect(wholePageText()).toContain("No live grants");
    await click("audit-reaper");
    expect(screen.getByTestId("audit")).toHaveTextContent(/grant\.reaped/);
    // nothing on the platform, so no drift
    await tab("Platforms");
    await waitFor(() => expect(screen.getByTestId("platform-github")).toHaveTextContent(/no one/), T);
    await tab("Drift");
    expect(screen.getByTestId("no-entries")).toBeInTheDocument();
    // someone grants access by hand
    await waitFor(() => expect(screen.getByTestId("oob-go")).toBeEnabled(), T);
    await click("oob-go");
    await waitFor(() => expect(screen.getByTestId("drift-message")).toHaveTextContent(/Done on the platform by hand/), T);
    expect(screen.getByTestId("diff")).toHaveTextContent(/unrecorded/);
    expect(screen.getByTestId("no-findings")).toBeInTheDocument(); // findings change only when a reconcile runs
    await click("reconcile");
    await waitFor(() => expect(screen.getByTestId("finding-row")).toHaveTextContent(/unrecorded/), T);
    await click("remediate");
    await waitFor(() => expect(screen.getByTestId("no-findings")).toBeInTheDocument(), T);
    expect(screen.getByTestId("no-entries")).toBeInTheDocument();
    await tab("Platforms");
    await waitFor(() => expect(screen.getByTestId("platform-github")).toHaveTextContent(/no one/), T);
  }, 120000);
});

describe("the other tabs", () => {
  it("Platforms shows the six platforms with their auth METHOD names and no credential field", async () => {
    await mount(); await tab("Platforms");
    await waitFor(() => expect(screen.getAllByTestId("auth-method").length).toBe(6), T);
    expect(screen.getAllByTestId("auth-method").map((n) => n.textContent)).toEqual(["personal access token", "administrator token", "OAuth JWT bearer with a connected app", "key-pair authentication", "OAuth service principal", "service account with domain-wide delegation"]);
    expect(document.querySelectorAll("input[type=password]").length).toBe(0);
    expect(screen.getByTestId("platform-salesforce")).toHaveTextContent(/Not modelled: profile/);
    expect(screen.getByTestId("platform-github")).toHaveTextContent(/team-to-repository/);
    expect(screen.getByTestId("field-sources")).toBeInTheDocument();
    expect((await screen.findAllByTestId("source-tag")).length).toBeGreaterThan(1);
  });

  it("the Sync switch works in Live and changes whether the reconcile reads the platform", async () => {
    await mount(); await live(); await tab("Drift");
    await waitFor(() => expect(screen.getByTestId("oob-go")).toBeEnabled(), T);
    await pick("oob-platform", "snowflake"); await pick("oob-resource", "snow-role-writer");
    await click("oob-go"); await waitFor(() => expect(screen.getByTestId("drift-message")).toBeInTheDocument(), T);
    expect(screen.getByTestId("diff")).toHaveTextContent(/unrecorded/);
    await tab("Platforms");
    await waitFor(() => expect(screen.getByTestId("sync-snowflake")).toBeEnabled(), T);
    await click("sync-snowflake");
    await waitFor(() => expect(screen.getByTestId("sync-snowflake")).not.toBeChecked(), T);
    await tab("Drift"); expect(screen.getByTestId("no-entries")).toBeInTheDocument();
  });

  it("Integrations: the Hitl switches change who is told (no Slack message, a Jira ticket)", async () => {
    await mount(); await live(); await tab("Approvals");
    await waitFor(() => expect(screen.getByTestId("ig-slack")).toBeEnabled(), T);
    await click("ig-slack");
    await waitFor(() => expect(screen.getByTestId("ig-slack")).not.toBeChecked(), T);
    await tab("Request"); await submitDefault(); await tab("Approvals");
    await screen.findByTestId("outbox", {}, T);
    expect(screen.getByTestId("outbox")).not.toHaveTextContent(/slack/);
    expect(screen.getByTestId("outbox")).toHaveTextContent(/jira/);
  });

  it("Diagram: both diagrams load from data, Simulate walks the arrows, Reset restores", async () => {
    await mount(); await tab("Diagram");
    await screen.findByTestId("pattern-canvas", {}, T);
    expect(screen.getByRole("heading", { name: /Request, approve, expire, remove/ })).toBeInTheDocument();
    expect(screen.getByTestId("pattern-step-bar")).toHaveTextContent(/Simulate walks the 8 arrows/);
    await click("simulate");
    await waitFor(() => expect(screen.getByTestId("pattern-now")).toBeInTheDocument(), T);
    await click("pattern-reset");
    await waitFor(() => expect(screen.queryByTestId("pattern-now")).toBeNull(), T);
    await click("dg-drift-and-reconcile");
    await waitFor(() => expect(screen.getByRole("heading", { name: /Drift: access granted outside Privilege/ })).toBeInTheDocument(), T);
    await waitFor(() => expect(screen.getByTestId("pattern-step-bar")).toHaveTextContent(/Simulate walks the 5 arrows/), T);
    expect(screen.getByTestId("speed")).toBeInTheDocument();
  });

  it("the edge-label offsets nudge a reply apart from the arrow it answers", () => {
    expect(labelOffsets([{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "c" }])).toEqual([-16, 16, 0]);
  });

  it("Talk track has the Why it matters entry marked as Ping claims", async () => {
    await mount(); await tab("Talk track");
    const t = await screen.findByTestId("talk-track");
    expect(t).toHaveTextContent(/Why it matters: SaaS Access Management/);
    expect(t).toHaveTextContent(/Ping claims, unverified on our tenant/);
    expect(t).toHaveTextContent(/Challenge:.*Technical:.*Business:/);
  });

  it("the vertical switch reloads the cast: names change in the story, the roster and the form", async () => {
    await mount(); await live();
    await userEvent.selectOptions(screen.getByTestId("vertical"), "health");
    await waitFor(() => expect(screen.getByTestId("subject")).toHaveValue(VERTICALS.health.castEngineer), T);
    await tab("Talk track");
    await waitFor(() => expect(wholePageText()).toContain("Contoso Health"), T);
  });
});

describe("Reset", () => {
  it("clears requests, grants and the clock in Live and the page reloads; another workspace is not touched", async () => {
    await mount(); await live(); await submitDefault();
    await tab("Timeline"); await waitFor(() => expect(screen.getByTestId("adv-60")).toBeEnabled(), T); await click("adv-60");
    await waitFor(() => expect(screen.getByTestId("clock")).toHaveTextContent("10:00"), T);
    await click("reset");
    await waitFor(() => expect(screen.getByTestId("clock")).toHaveTextContent("2026-11-02 09:00"), T);
    await tab("Approvals"); expect(await screen.findByTestId("no-pending")).toBeInTheDocument();
    await tab("Timeline"); expect(screen.getByTestId("no-grants")).toBeInTheDocument();
    expect(seen.some((s) => /\/api\/reset/.test(s.url))).toBe(true);
  });

  it("Reset also restores the diagram box positions", async () => {
    await mount(); await tab("Diagram");
    await screen.findByTestId("pattern-canvas", {}, T);
    expect(screen.getByText(/Moved: 0 box/)).toBeInTheDocument();
    await click("reset");
    await waitFor(() => expect(screen.getByText(/Moved: 0 box/)).toBeInTheDocument());
  });
});

describe("hostile text is shown inert", () => {
  it("control and bidi characters become visible escapes, markup stays text", () => {
    expect(visible("a‮b\u0000c")).toBe("a\\u202eb\\u0000c");
    expect(visible("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});
