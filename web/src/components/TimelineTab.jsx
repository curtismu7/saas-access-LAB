import { useState } from "react";
import { t } from "../fmt";
import { visible } from "../safeText";
import { ClaimTag, SourceTag, StatusTag } from "./Bits";

const FILTERS = { all: () => true, reaper: (a) => /^(grant\.reaped|request\.expired|clock\.advanced|drift\.)/.test(a.kind), approvals: (a) => /^(request\.|approval\.)/.test(a.kind) };
const brief = (a) => {
  const { n, at, kind, actor, ...rest } = a;
  return Object.entries(rest).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${typeof v === "object" ? (v.kind ? `${v.kind} ${v.id}` : JSON.stringify(v)) : v}`).join(", ");
};

export default function TimelineTab({ story, mode, lab }) {
  const state = lab.state;
  const [filter, setFilter] = useState("all");
  const [custom, setCustom] = useState("30");
  const [message, setMessage] = useState(null);
  if (!state) return <p className="muted">Loading...</p>;
  const off = mode !== "live" || lab.busy;
  const move = async (body) => {
    setMessage(null);
    const r = await lab.act("POST", "/api/clock", { clock: body });
    setMessage(r.ok ? { ok: true, text: `The clock moved. Reaped: ${(r.body?.result?.reaped?.length ?? 0)} grant(s); requests expired: ${(r.body?.result?.requestsExpired?.length ?? 0)}; nightly reconcile runs: ${(r.body?.result?.nightly ?? 0)}.` } : { ok: false, text: `Refused (${r.body?.error}). ${r.body?.detail || ""}` });
  };
  const reap = async () => { setMessage(null); const r = await lab.act("POST", "/api/reaper/run", {}); setMessage(r.ok ? { ok: true, text: `Reaper pass: ${(r.body?.result?.reaped?.length ?? 0)} grant(s) removed, ${(r.body?.result?.requestsExpired?.length ?? 0)} request(s) expired.` } : { ok: false, text: r.body?.detail || r.body?.error }); };
  const rows = state.audit.filter(FILTERS[filter]).slice(0, 80);
  const v = state.receipts.verify;
  return (
    <div className="stack">
      <section className="panel" data-testid="clock-panel">
        <h2 className="panel__title">The lab clock <ClaimTag /></h2>
        <p className="lesson" data-testid="clock">Lab time: <strong>{t(state.clock)} UTC</strong> (started {t(state.clockStart)}). The reaper wakes every {state.reaperTickMin} lab minutes and at the end of every move; the nightly reconcile runs at {String(state.nightlyHourUtc).padStart(2, "0")}:00 <SourceTag source="invented" /></p>
        <div className="seg">
          <button type="button" disabled={off} onClick={() => move({ minutes: 15 })} data-testid="adv-15">+15 min</button>
          <button type="button" disabled={off} onClick={() => move({ minutes: 60 })} data-testid="adv-60">+1 h</button>
          <button type="button" disabled={off} onClick={() => move({ minutes: 1440 })} data-testid="adv-1440">+1 day</button>
          <label className="inline">Minutes <input type="number" min="1" value={custom} onChange={(e) => setCustom(e.target.value)} data-testid="adv-custom-minutes" /></label>
          <button type="button" disabled={off} onClick={() => move({ minutes: Number(custom) })} data-testid="adv-custom">Advance</button>
          <button type="button" disabled={off} onClick={() => move({ minutes: -15 })} data-testid="adv-back">Try going back 15 min (refused)</button>
          <button type="button" disabled={off} onClick={reap} data-testid="reap">Run the reaper now</button>
        </div>
        {mode !== "live" && <p className="muted">Mock is read-only: the buttons are off. Switch to Live to move the clock.</p>}
        {message && <p className={message.ok ? "lesson" : "field-error"} role={message.ok ? "status" : "alert"} data-testid="clock-message">{visible(message.text)}</p>}
      </section>
      <section className="panel">
        <h2 className="panel__title">Grants and receipts</h2>
        <p className="muted" data-testid="receipt-chain">Receipt chain: {v.ok ? `verified (${v.count} receipts, computed now from the receipts themselves)` : `BROKEN at ${v.at}`} <SourceTag source="invented" /></p>
        <p className="muted" data-testid="receipt-head">Head {state.receipts.commitment.head.slice(0, 16)}... of {state.receipts.commitment.count} receipt(s), kept beside the receipts: editing, reordering or dropping receipts is detected against it. Without a key or an anchor held elsewhere, someone who can rewrite both can forge the chain, so write the head down if it matters.</p>
        {state.grants.length === 0 ? <p className="muted" data-testid="no-grants">No grants yet.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="grants">
            <thead><tr><th>Grant</th><th>Subject</th><th>Access</th><th>Granted</th><th>Expires</th><th>Status</th><th>References</th><th>Approved by</th><th>Receipt</th></tr></thead>
            <tbody>{state.grants.map((g) => (
              <tr key={g.id} data-testid="grant-row"><td>{g.id}<div className="muted">{g.policyId}</div></td><td>{g.subject.kind} {g.subject.id}</td><td>{g.level} on {visible(g.resourceName)} ({g.platform})</td><td>{t(g.grantedAt)}</td><td>{t(g.expiresAt)}</td>
                <td><StatusTag status={g.status} />{g.removedAt && <div className="muted">removed {t(g.removedAt)} ({g.removalReason})</div>}</td><td data-testid="refcount">{g.refCount ?? "-"}</td><td>{g.approvedBy.map((a) => a.id).join(", ")}</td><td>{g.receiptId}{g.removalReceiptId ? `, ${g.removalReceiptId}` : ""}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel">
        <h2 className="panel__title">Live access and reference counts <SourceTag source="reading" /></h2>
        <p className="muted">The platform keeps an entry until the last grant that holds it ends, at the highest level any of them gives.</p>
        {state.holdings.length === 0 ? <p className="muted">No live grants.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="holdings">
            <thead><tr><th>Subject</th><th>Resource</th><th>Grants holding it</th><th>References</th><th>On the platform</th></tr></thead>
            <tbody>{state.holdings.map((h) => <tr key={h.key}><td>{h.subject.kind} {h.subject.id}</td><td>{visible(state.resourceNames[h.resource])} ({h.platform})</td><td>{h.grants.join(", ")}</td><td>{h.refCount}</td><td>{h.onPlatform ?? "nothing"}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel">
        <h2 className="panel__title">Audit trail and reaper log <SourceTag source="invented" /></h2>
        <p className="muted">One trail for people and agents: the same events, the same way.</p>
        <div className="seg" role="group" aria-label="Filter">
          {[["all", "Everything"], ["reaper", "Reaper and drift log"], ["approvals", "Requests and approvals"]].map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} data-testid={`audit-${k}`}>{l}</button>)}
        </div>
        {rows.length === 0 ? <p className="muted">Nothing recorded.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="audit">
            <thead><tr><th>Lab time</th><th>Event</th><th>By</th><th>Detail</th></tr></thead>
            <tbody>{rows.map((a) => <tr key={a.n}><td>{t(a.at)}</td><td><code>{a.kind}</code></td><td>{visible(a.actor)}</td><td>{visible(brief(a))}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
