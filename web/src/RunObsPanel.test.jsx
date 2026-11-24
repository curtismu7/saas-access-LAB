// Rule 27: the page's run panel. Each answer shape gets an alert, never the empty state; a late answer for an older request never paints over a newer one;
// and the panel gets the page's mode as its source. Queries are re-run inside waitFor (no node captured before a swap).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import RunObsPanel from "./components/RunObsPanel.jsx";

const record = (over = {}) => ({
  runId: "mock-finance-self-approval", window: { from: "2026-11-24T10:00:00.000Z", to: "2026-11-24T10:05:00.000Z" }, source: "mock", excerpt: true, truncated: false,
  rows: [{ id: "r-1", at: "2026-11-24T10:00:00.000Z", atExact: "2026-11-24T10:00:00.000Z", layer: "privilege", product: "lab mock", outcome: "blocked", message: "The lab stopped a self-approval", origin: "simulated" }],
  coverage: { person: "not-logged", agent: "not-logged", authorize: "not-logged", privilege: "simulated", gateway: "not-logged", resource: "not-logged" },
  reasons: { person: "no sign-in", agent: "no token", authorize: "no authorize", privilege: "", gateway: "no gateway", resource: "no platform log" },
  partial: {}, summary: { allowed: 0, refused: 0, blocked: 1, info: 0, unverified: 0 },
  ...over,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let handler;
beforeEach(() => { handler = null; vi.stubGlobal("fetch", vi.fn((url) => handler(String(url)))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the run panel", () => {
  it("shows the record from the server, with the page mode as its source", async () => {
    handler = () => Promise.resolve(json({ mode: "mock", vertical: "finance", scenario: "self-approval", record: record() }));
    render(<RunObsPanel mode="mock" vertical="finance" scenario="self-approval" stamp={{}} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis")).toBeTruthy());
    expect(screen.getByText(/The lab stopped a self-approval/)).toBeTruthy();
    const note = screen.getByTestId("run-obs-note").textContent;
    expect(note).toMatch(/not by a Ping product/);
    expect(note).toMatch(/Each row is one event/);
    expect(note).toMatch(/Only policy points are decisions/);
    expect(note).not.toMatch(/Each row is one decision/);
  });

  it("an empty answer (no run yet) is the panel's empty state, not an alert", async () => {
    handler = () => Promise.resolve(json({ mode: "live", vertical: "finance", record: null }));
    render(<RunObsPanel mode="mock" vertical="finance" scenario="x" stamp={{}} />);
    await waitFor(() => expect(screen.queryByTestId("run-obs-loading")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  for (const [name, res] of [
    ["an HTML page with status 200", () => new Response("<!doctype html><html>not json</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["JSON null", () => json(null)],
    ["an empty body", () => new Response("", { status: 200 })],
    ["an array", () => json([])],
    ["a JSON string", () => json("ok")],
    ["an object with no record", () => json({})],
  ]) {
    it(`${name} on the head answer is an alert, never a stuck note and never the empty state`, async () => {
      handler = () => Promise.resolve(res());
      render(<RunObsPanel mode="live" vertical="finance" stamp={{}} />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.queryByTestId("run-obs-loading")).toBeNull();
      expect(screen.queryByText(/Reading this run/)).toBeNull();
    });
  }

  it("a late answer for the previous scenario never paints over the one asked for after it", async () => {
    const slow = { resolve: null };
    handler = (url) => {
      if (url.includes("scenario=drift")) return new Promise((r) => { slow.resolve = () => r(json({ mode: "mock", vertical: "finance", scenario: "drift", record: record({ runId: "mock-finance-drift", rows: [{ id: "r-d", at: "2026-11-24T11:00:00.000Z", atExact: "2026-11-24T11:00:00.000Z", layer: "privilege", product: "lab mock", outcome: "info", message: "OLD-DRIFT-ROW", origin: "simulated" }] }) })); });
      return Promise.resolve(json({ mode: "mock", vertical: "finance", scenario: "overlap", record: record({ runId: "mock-finance-overlap", rows: [{ id: "r-o", at: "2026-11-24T10:00:00.000Z", atExact: "2026-11-24T10:00:00.000Z", layer: "privilege", product: "lab mock", outcome: "info", message: "NEW-OVERLAP-ROW", origin: "simulated" }] }) }));
    };
    const { rerender } = render(<RunObsPanel mode="mock" vertical="finance" scenario="drift" stamp={{}} />);
    rerender(<RunObsPanel mode="mock" vertical="finance" scenario="overlap" stamp={{}} />);
    await waitFor(() => expect(screen.getByText(/NEW-OVERLAP-ROW/)).toBeTruthy());
    slow.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/OLD-DRIFT-ROW/)).toBeNull();
    expect(screen.getByText(/NEW-OVERLAP-ROW/)).toBeTruthy();
  });

  it("while a new request loads, the previous record is not shown", async () => {
    handler = (url) => (url.includes("scenario=drift")
      ? Promise.resolve(json({ mode: "mock", vertical: "finance", scenario: "drift", record: record({ rows: [{ id: "r-d", at: "2026-11-24T11:00:00.000Z", atExact: "2026-11-24T11:00:00.000Z", layer: "privilege", product: "lab mock", outcome: "info", message: "FIRST-ROW", origin: "simulated" }] }) }))
      : new Promise(() => {}));
    const { rerender } = render(<RunObsPanel mode="mock" vertical="finance" scenario="drift" stamp={{}} />);
    await waitFor(() => expect(screen.getByText(/FIRST-ROW/)).toBeTruthy());
    rerender(<RunObsPanel mode="mock" vertical="finance" scenario="overlap" stamp={{}} />);
    await waitFor(() => expect(screen.getByTestId("run-obs-loading")).toBeTruthy());
    expect(screen.queryByText(/FIRST-ROW/)).toBeNull();
  });
});
