// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import App from "./App";
import { setJsonView } from "./components/JsonPane";
import { forgetWorkspace } from "./workspace";

let server; let base; const realFetch = globalThis.fetch; let shelf = null; let shelfCalls = [];
beforeAll(async () => {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json" }) }));
  base = base.replace(/\/$/, "");
  globalThis.fetch = async (u, init = {}) => {
    if (u === "/api/shelf" && shelf) { shelfCalls.push(init); return new Response(JSON.stringify(shelf), { headers: { "content-type": "application/json" } }); }
    const url = typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u;
    return realFetch(url, { ...init, headers: { origin: base, ...(init.headers || {}) } });
  };
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => { cleanup(); setJsonView("form"); forgetWorkspace(); shelf = null; shelfCalls = []; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; });

const T = { timeout: 20000 };
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    shelf = { shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "saas-access-lab", verification: mark("verified", "Verified", { note: "All six platforms run on the mock" }) }] };
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu", {}, T));
    expect(await bar.findByText("Verified", {}, T)).toBeInTheDocument();
    expect(bar.getByRole("link", { name: /Shelf/ })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify").length).toBe(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("All six platforms run on the mock"));
    // like the Shelf link, the badge's request carries the page's workspace id
    expect(shelfCalls.length).toBeGreaterThanOrEqual(2);
    expect(shelfCalls.every((c) => typeof c.headers?.["x-workspace"] === "string" && c.headers["x-workspace"].length > 0)).toBe(true);
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "saas-access-lab", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "saas-access-lab", verification: mark("none", "") }] }]) {
      shelf = payload; shelfCalls = [];
      const { unmount } = render(<App />);
      const bar = within(await screen.findByTestId("top-menu", {}, T));
      expect(await bar.findByRole("link", { name: /Shelf/ }, T)).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
