import { useState } from "react";
import { t } from "../fmt";
import { visible } from "../safeText";
import { ClaimTag, SourceTag, StatusTag } from "./Bits";

const MEANING = {
  match: "the platform and the receipts agree",
  unrecorded: "access on the platform with no live grant behind it: granted outside Privilege",
  elevated: "more access on the platform than the receipts justify",
  missing: "a live grant, but the platform no longer has the access",
};

export default function DriftTab({ story, mode, lab }) {
  const state = lab.state;
  const [c, setC] = useState({ op: "grant", platform: "github", resource: "gh-repo-core", subjectKind: "human", subjectId: story.cast.castEngineer, level: "admin" });
  const [message, setMessage] = useState(null);
  if (!state) return <p className="muted">Loading...</p>;
  const platform = story.platforms.find((p) => p.id === c.platform);
  const resource = platform.resources.find((r) => r.id === c.resource) || platform.resources[0];
  const people = state.roster.filter((p) => p.kind === c.subjectKind);
  const off = mode !== "live" || lab.busy;
  const set = (patch) => setC((cur) => ({ ...cur, ...patch }));
  const pickPlatform = (id) => { const p = story.platforms.find((x) => x.id === id); set({ platform: id, resource: p.resources[0].id, level: p.resources[0].levels[p.resources[0].levels.length - 1] }); };
  const pickResource = (id) => { const r = platform.resources.find((x) => x.id === id); set({ resource: id, level: r.levels[r.levels.length - 1] }); };
  const pickKind = (k) => set({ subjectKind: k, subjectId: state.roster.find((p) => p.kind === k).id });
  const say = (r, ok) => setMessage(r.ok ? { ok: true, text: ok } : { ok: false, text: `Refused (${r.body?.error}). ${r.body?.detail || ""}` });
  const byHand = async () => say(await lab.act("POST", "/api/platforms/out-of-band", { change: { op: c.op, platform: c.platform, resource: resource.id, subjectKind: c.subjectKind, subjectId: c.subjectId, ...(c.op === "grant" ? { level: c.level } : {}) } }), c.op === "grant" ? "Done on the platform by hand. Privilege was not asked: reconcile to see it." : "Removed on the platform by hand.");
  const reconcile = async () => { const r = await lab.act("POST", "/api/drift/reconcile", {}); say(r, `Reconciled: ${r.body?.result?.findings} finding(s), ${r.body?.result?.newFindings} new.`); };
  const remediate = async (id) => say(await lab.act("POST", "/api/drift/remediate", { findingId: id }), "Removed from the platform and reconciled again.");
  const rows = state.diff;
  return (
    <div className="stack">
      <section className="panel" data-testid="drift-controls">
        <h2 className="panel__title">Drift: the platform against the receipts <ClaimTag /></h2>
        <p className="muted">Every night (and when you press the button) the reconcile reads each platform and compares it with the receipts. {mode !== "live" && "Mock is read-only: the controls are off. Switch to Live to try it."}</p>
        <div className="filters">
          <label>A platform administrator will
            <select value={c.op} onChange={(e) => set({ op: e.target.value })} data-testid="oob-op"><option value="grant">grant access by hand</option><option value="remove">remove access by hand</option></select>
          </label>
          <label>Platform
            <select value={c.platform} onChange={(e) => pickPlatform(e.target.value)} data-testid="oob-platform">{story.platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label>Resource
            <select value={resource.id} onChange={(e) => pickResource(e.target.value)} data-testid="oob-resource">{platform.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label>Subject is a
            <select value={c.subjectKind} onChange={(e) => pickKind(e.target.value)} data-testid="oob-kind"><option value="human">human</option><option value="agent">agent</option></select>
          </label>
          <label>Subject
            <select value={c.subjectId} onChange={(e) => set({ subjectId: e.target.value })} data-testid="oob-subject">{people.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select>
          </label>
          {c.op === "grant" && (
            <label>Level
              <select value={resource.levels.includes(c.level) ? c.level : resource.levels[0]} onChange={(e) => set({ level: e.target.value })} data-testid="oob-level">{resource.levels.map((l) => <option key={l}>{l}</option>)}</select>
            </label>
          )}
        </div>
        <div className="seg">
          <button type="button" disabled={off} onClick={byHand} data-testid="oob-go">Someone changes the platform by hand</button>
          <button type="button" className="primary" disabled={off} onClick={reconcile} data-testid="reconcile">Run the nightly reconcile now</button>
        </div>
        {message && <p className={message.ok ? "lesson" : "field-error"} role={message.ok ? "status" : "alert"} data-testid="drift-message">{visible(message.text)}</p>}
      </section>
      <section className="panel">
        <h2 className="panel__title">Platform state against receipts (live diff) <SourceTag source="invented" /></h2>
        {rows.length === 0 ? <p className="muted" data-testid="no-entries">No platform holds any access, and no grant is live.</p> : (
          <div className="scroll"><table className="tbl tbl--wide" data-testid="diff">
            <thead><tr><th>Result</th><th>Platform</th><th>Resource</th><th>Subject</th><th>On the platform</th><th>Receipts justify</th><th>Meaning</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} data-testid="diff-row"><td><StatusTag status={r.kind} /></td><td>{r.platform}</td><td>{visible(state.resourceNames[r.resource])}</td><td>{r.subject.kind} {r.subject.id}</td><td>{r.onPlatform ?? "nothing"}</td><td>{r.expected ?? "nothing"}</td><td>{MEANING[r.kind]}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="panel" data-testid="findings">
        <h2 className="panel__title">Findings at the last reconcile</h2>
        <p className="muted">{state.drift.lastRunAt ? `Last run ${t(state.drift.lastRunAt)} UTC.` : "No reconcile has run yet."} Findings change only when a reconcile runs (nightly at 02:00 lab time, or by the button); the diff above is live.</p>
        {state.drift.open.length === 0 ? <p className="muted" data-testid="no-findings">No open findings.</p> : (
          <div className="scroll"><table className="tbl tbl--wide">
            <thead><tr><th>Finding</th><th>Kind</th><th>Where</th><th>Who</th><th>First seen</th><th></th></tr></thead>
            <tbody>{state.drift.open.map((f) => (
              <tr key={f.id} data-testid="finding-row"><td>{f.id}</td><td><StatusTag status={f.kind} /></td><td>{f.platform}: {visible(state.resourceNames[f.resource])} ({f.onPlatform ?? "nothing"})</td><td>{f.subject.kind} {f.subject.id}</td><td>{t(f.firstSeenAt)}</td>
                <td>{f.kind !== "missing" && <button type="button" disabled={off} onClick={() => remediate(f.id)} data-testid="remediate">Revoke on the platform</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {state.drift.runs.length > 0 && (
          <details><summary>Reconcile runs ({state.drift.runs.length})</summary>
            <ul className="plain" data-testid="runs">{[...state.drift.runs].reverse().map((r) => <li key={r.id}>{r.id} at {t(r.at)} ({r.trigger}): {r.entries} platform entries, {r.findings} finding(s), {r.newFindings} new</li>)}</ul>
          </details>
        )}
      </section>
    </div>
  );
}
