import { useEffect, useState } from "react";
import { mins, t } from "../fmt";
import { visible } from "../safeText";
import { ClaimTag, SourceTag, StatusTag } from "./Bits";

function Pending({ r, actor, via, comment, onDecide, disabled }) {
  const lvl = r.routing;
  const mine = lvl?.candidates.find((c) => c.id === actor);
  return (
    <li className="panel" data-testid="pending" data-request={r.id}>
      <h3 className="panel__sub">{r.id}: {r.subject.kind} <code>{r.subject.id}</code> asks for <strong>{r.level}</strong> on {visible(r.resourceName)} for {mins(r.durationMin)}</h3>
      <p className="muted">Policy {r.policyId}; asked by <code>{r.requestedBy}</code>; reason: {r.reason ? visible(r.reason) : "none given"}. Approval window closes {t(r.approval.ExpiresAt)} UTC.</p>
      <p data-testid="pending-level">Level {r.currentLevel + 1} of {r.chain.length}: {lvl.role} ({lvl.required} approval{lvl.required > 1 ? "s" : ""} needed; {r.approval.ApprovedBy.filter((a) => a.level === r.currentLevel).length} so far). Routed to:{" "}
        {lvl.candidates.map((c) => <span key={c.id} className="tag" data-state={c.allowed ? "ok" : "bad"}>{c.id}{c.allowed ? " (can approve)" : ` (cannot: ${c.reason})`}</span>)}</p>
      {r.approval.ApprovedBy.length > 0 && <p className="muted">Approved so far: {r.approval.ApprovedBy.map((a) => `${a.id} (level ${a.level + 1}, ${a.via})`).join(", ")}</p>}
      <p className="muted">{mine ? (mine.allowed ? `${actor} is routed to this level and may act.` : `${actor} is routed to this level but is ${mine.reason === "requester" ? "the requester" : mine.reason === "subject" ? "the subject" : "not human"}: the lab will refuse.`) : `${actor} is not routed to this level: the lab will refuse.`}</p>
      <div className="seg">
        <button type="button" className="primary" disabled={disabled} onClick={() => onDecide(r.id, "approve", via, comment)} data-testid="approve">Approve as {actor}</button>
        <button type="button" disabled={disabled} onClick={() => onDecide(r.id, "deny", via, comment)} data-testid="deny">Deny as {actor}</button>
      </div>
    </li>
  );
}

export default function ApprovalsTab({ story, mode, lab }) {
  const state = lab.state;
  const [actor, setActor] = useState(story.cast.castManager);
  const [via, setVia] = useState("console");
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState(null);
  useEffect(() => { setMessage(null); }, [mode]);
  if (!state) return <p className="muted">Loading...</p>;
  const pending = state.requests.filter((r) => r.status === "pending");
  const decided = state.requests.filter((r) => r.status !== "pending");
  const disabled = mode !== "live" || lab.busy;
  const decide = async (id, decision, v, c) => {
    setMessage(null);
    const r = await lab.act("POST", `/api/requests/${id}/decision`, { decision: { approver: actor, decision, via: v, ...(c ? { comment: c } : {}) } });
    setMessage(r.ok ? { ok: true, text: `${id}: ${r.body.result.status}${r.body.result.status === "pending" ? `, now at level ${r.body.result.level}` : ""}.` } : { ok: false, text: `${id}: refused (${r.body?.error}). ${r.body?.detail || ""}` });
  };
  const setHitl = (name, key, value) => lab.act("PUT", "/api/integrations", { integrations: { [name]: { [key]: value } } });
  const ig = state.integrations;
  return (
    <div className="stack">
      <section className="panel" data-testid="approver-controls">
        <h2 className="panel__title">Approvals inbox <ClaimTag /></h2>
        <p className="muted">The lab has no sign-in: you choose who acts (lab-invented). Try the wrong person. A person cannot approve their own request, an agent cannot approve, and a notify-only channel cannot approve.</p>
        <div className="filters">
          <label>Act as
            <select value={actor} onChange={(e) => setActor(e.target.value)} data-testid="actor">{state.roster.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.kind})</option>)}</select>
          </label>
          <label>Decide through
            <select value={via} onChange={(e) => setVia(e.target.value)} data-testid="via">{story.via.map((v) => <option key={v} value={v}>{v}{story.notifyOnly.includes(v) ? " (notify only)" : ""}</option>)}</select>
          </label>
          <label>Comment (optional)
            <input value={comment} maxLength={200} onChange={(e) => setComment(e.target.value)} data-testid="comment" />
          </label>
        </div>
        {message && <p className={message.ok ? "lesson" : "field-error"} role={message.ok ? "status" : "alert"} data-testid="decision-message">{visible(message.text)}</p>}
        {mode !== "live" && <p className="muted">Mock is read-only: the buttons are off. Switch to Live to approve.</p>}
        {pending.length === 0 ? <p className="muted" data-testid="no-pending">Nothing is waiting for approval.</p> : (
          <ul className="plain stack" data-testid="inbox">{pending.map((r) => <Pending key={r.id} r={r} actor={actor} via={via} comment={comment} onDecide={decide} disabled={disabled} />)}</ul>
        )}
      </section>
      <section className="panel">
        <h2 className="panel__title">Decided requests</h2>
        {decided.length === 0 ? <p className="muted">None yet.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="decided">
            <thead><tr><th>Request</th><th>Subject</th><th>Access</th><th>Status</th><th>Decided by</th><th>RetiredAt</th></tr></thead>
            <tbody>{decided.map((r) => (
              <tr key={r.id}><td>{r.id}</td><td>{r.subject.kind} {r.subject.id}</td><td>{r.level} on {visible(r.resourceName)} for {mins(r.durationMin)}</td><td><StatusTag status={r.status} /></td>
                <td>{r.approval.DeniedBy ? `${r.approval.DeniedBy} (denied)` : r.approval.ApprovedBy.map((a) => a.id).join(", ") || "-"}</td><td>{t(r.approval.RetiredAt)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel" data-testid="integrations">
        <h2 className="panel__title">Where approvers are told <SourceTag source="swagger" /></h2>
        <p className="muted">Hitl marks an integration as approver-facing (Slack), or as a tracker that gets a ticket for every approval (Jira project, ServiceNow table). Slack and Mattermost carry Approve and Deny buttons; Teams, Jira and ServiceNow only receive notifications and tickets. Mattermost Hitl and Teams enabled are lab-invented switches.</p>
        <div className="toggles">
          {[["slack", "Hitl", "Slack: approve in chat"], ["mattermost", "Hitl", "Mattermost: approve in chat"], ["msteams", "enabled", "Teams: notify only"], ["jira", "Hitl", "Jira: ticket"], ["servicenow", "Hitl", "ServiceNow: ticket"]].map(([n, k, label]) => (
            <label className="check" key={n}><input type="checkbox" checked={!!ig[n][k]} disabled={disabled} onChange={(e) => setHitl(n, k, e.target.checked)} data-testid={`ig-${n}`} /> {label}</label>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2 className="panel__title">Outbox <SourceTag source="invented" /></h2>
        <p className="muted">Notifications are simulated: written here, never sent. A message with actions can be answered; the buttons are pulled when the request is decided.</p>
        {state.outbox.length === 0 ? <p className="muted">Empty.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="outbox">
            <thead><tr><th>When</th><th>Channel</th><th>To</th><th>Kind</th><th>Actions</th><th>Text</th></tr></thead>
            <tbody>{state.outbox.slice(0, 40).map((m) => (
              <tr key={m.id}><td>{t(m.at)}</td><td>{m.channel}</td><td>{visible(m.to)}</td><td>{m.kind}</td><td>{m.actions.length ? m.actions.join(" / ") : m.pulled ? "pulled" : "none (notify only)"}</td><td>{visible(m.text)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
