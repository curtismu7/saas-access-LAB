import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// POST or PUT JSON. Returns { ok, status, body }: a refusal (400, 403, 409) is data (a code and a detail), not an exception.
export async function sendJson(method, url, payload) {
  const r = await workspaceFetch(url, { method, body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}
export const postJson = (url, payload) => sendJson("POST", url, payload);
export const putJson = (url, payload) => sendJson("PUT", url, payload);

export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);

// Rule 19: the server-side Mock/Real toggle. Returns { ok, status, body } and never throws on 409.
export const getModeInfo = async () => {
  const r = await workspaceFetch("/api/mode", { method: "GET" });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
};
export const setMode = (source) => sendJson("POST", "/api/mode", { source });
