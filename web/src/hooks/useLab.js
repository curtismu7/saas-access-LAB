import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "../api";

// The lab's state, from either source: Mock reads a generated table (read-only), Live reads the workspace's engine. Both give the same shape, so every
// tab renders one thing. Every load and every action carries a sequence number: an answer that is no longer the latest is dropped.
export default function useLab({ mode, vertical, scenario }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const seq = useRef(0);       // loads
  const actSeq = useRef(0);    // writes
  const inflight = useRef(0);
  const ctx = useRef("");
  ctx.current = `${mode}|${vertical}`;

  const load = useCallback(() => {
    if (!mode) return Promise.resolve();
    const mine = ++seq.current;
    const q = `mode=${mode}&vertical=${encodeURIComponent(vertical)}${mode === "mock" && scenario ? `&scenario=${encodeURIComponent(scenario)}` : ""}`;
    return getJson(`/api/state?${q}`).then((j) => { if (mine === seq.current) { setData(j); setError(null); } }, (e) => { if (mine === seq.current) setError(e.message); });
  }, [mode, vertical, scenario]);
  // Switching mode or vertical clears the page; switching only the scenario keeps the old one on screen until the new one arrives.
  useEffect(() => { setData(null); setLast(null); }, [mode, vertical]);
  useEffect(() => { load(); }, [load]);

  // act(method, route, extra): one write. The state in the answer replaces the page's state, unless a newer load or write has started.
  const act = useCallback(async (method, route, extra = {}) => {
    const mine = ++actSeq.current; const key = `${mode}|${vertical}`;
    inflight.current += 1; setBusy(true);
    try {
      const raw = await sendJson(method, route, { mode, vertical, refusalsAs200: true, ...extra });
      // A write is a success ONLY when the body says `ok: true`. A refusal comes back as data (200 with ok: false), and a 200 whose body lacks `ok` is
      // never rendered as a success.
      const r = { ...raw, ok: raw.ok && raw.body?.ok === true }
      // A newer write, or a switch of mode or vertical, makes this answer stale: it is returned to the caller but not shown.
      if (mine === actSeq.current && key === ctx.current) {
        seq.current += 1; // a load that started before this write must not overwrite its newer state
        if (r.body?.state) setData((d) => ({ ...(d || {}), mode, vertical, state: r.body.state }));
        setLast({ ok: r.ok, status: r.status, error: r.body?.error, detail: r.body?.detail, errors: r.body?.errors, result: r.body?.result, hops: r.body?.hops || [], traceId: r.body?.traceId, truncated: r.body?.hopsTruncated, route: `${method} ${route}`, at: Date.now() });
      }
      return r;
    } finally { inflight.current -= 1; if (inflight.current === 0) setBusy(false); }
  }, [mode, vertical]);

  return { data, state: data?.state || null, scenario: data?.scenario || null, scenarios: data?.scenarios || [], error, busy, last, act, reload: load, readOnly: mode !== "live" };
}
