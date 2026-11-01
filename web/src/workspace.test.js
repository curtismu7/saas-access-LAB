// The page's workspace id: always valid, always has a letter, never a credential-looking value kept from storage, and one retry (never a loop) when the server
// refuses an id with 400 bad_workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetWorkspace, freshId, validWorkspaceId, workspaceFetch, workspaceId } from "./workspace";

const KEY = "sal.workspace";
const PROBE = "hunter2xyz";
const REFUSED_ID = ["abcdefghijklmnop", "qrstuv12"].join(""); // 24 characters: passes the page's rule, the server's masker refuses it
beforeEach(() => { forgetWorkspace(); window.sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("workspace ids", () => {
  it("a made id is w- and 16 hex characters: 18 characters, always a letter, never 24 hex in a row, always valid (500 draws)", () => {
    for (let i = 0; i < 500; i += 1) {
      const id = freshId();
      expect(id).toMatch(/^w-[0-9a-f]{16}$/); expect(id.length).toBe(18); expect(/[a-z]/.test(id)).toBe(true); expect(validWorkspaceId(id)).toBe(true);
    }
  });

  it("the page's rule on a table (scripts/workspace-rule.test.mjs compares it with the server's)", () => {
    for (const id of ["default", "w-0123456789abcdef", "ws-a", "a", "passing-review", "tokens-x"]) expect(validWorkspaceId(id), id).toBe(true);
    for (const id of [`pw-${PROBE}`, "sk-abcdefghijklmnop1234", "a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097", "token-x", "password", "x".repeat(41), "", "A", "a_b", 5, null]) expect(validWorkspaceId(id), String(id)).toBe(false);
  });

  it("a stored id that is refused by the rule is replaced, not used (a stored refused id must not brick the tab)", () => {
    window.sessionStorage.setItem(KEY, `pw-${PROBE}`);
    const id = workspaceId();
    expect(id).not.toContain(PROBE); expect(validWorkspaceId(id)).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBe(id);
    forgetWorkspace();
    window.sessionStorage.setItem(KEY, "ws-kept"); expect(workspaceId()).toBe("ws-kept");
  });

  it("storage that throws still gives a valid per-load id", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const id = workspaceId(); expect(validWorkspaceId(id)).toBe(true); expect(workspaceId()).toBe(id);
  });
});

const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("workspaceFetch", () => {
  it("on 400 bad_workspace it makes a new id and asks exactly once more; the second answer is returned", async () => {
    window.sessionStorage.setItem(KEY, REFUSED_ID); // passes the page's rule, the server's masker refuses it
    const sent = [];
    vi.stubGlobal("fetch", vi.fn(async (_u, init) => { sent.push(init.headers["x-workspace"]); return sent.length === 1 ? answer(400, { error: "bad_workspace" }) : answer(200, { ok: true }); }));
    const r = await workspaceFetch("/api/state");
    expect(r.status).toBe(200); expect(sent.length).toBe(2);
    expect(sent[0]).toBe(REFUSED_ID); expect(sent[1]).not.toBe(sent[0]); expect(validWorkspaceId(sent[1])).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBe(sent[1]); // the new id is kept for the next call
    vi.unstubAllGlobals();
  });

  it("never a loop: a second refusal is returned as it is (2 calls, not 3)", async () => {
    const f = vi.fn(async () => answer(400, { error: "bad_workspace" }));
    vi.stubGlobal("fetch", f);
    const r = await workspaceFetch("/api/state");
    expect(r.status).toBe(400); expect(f).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("any other 400, and any other status, is returned at once (1 call)", async () => {
    for (const a of [() => answer(400, { error: "bad_mode" }), () => answer(400, {}), () => new Response("not json", { status: 400 }), () => answer(404, { error: "not_found" }), () => answer(200, { ok: true })]) {
      const f = vi.fn(async () => a()); vi.stubGlobal("fetch", f);
      await workspaceFetch("/api/state"); expect(f).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it("the id goes out as x-workspace on every call, with the JSON content type", async () => {
    const f = vi.fn(async () => answer(200, {})); vi.stubGlobal("fetch", f);
    await workspaceFetch("/api/x", { method: "POST", body: "{}" });
    const h = f.mock.calls[0][1].headers; expect(h["x-workspace"]).toBe(workspaceId()); expect(h["content-type"]).toBe("application/json");
    vi.unstubAllGlobals();
  });
});
