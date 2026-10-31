import { visible } from "../safeText";
import { ClaimTag, FieldSources, SourceTag } from "./Bits";

const SYNC = ["databricks", "salesforce", "snowflake"];

export default function PlatformsTab({ story, mode, lab }) {
  const state = lab.state;
  if (!state) return <p className="muted">Loading...</p>;
  const off = mode !== "live" || lab.busy;
  const setSync = (platform, sync) => lab.act("POST", "/api/platforms/sync", { change: { platform, sync } });
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel__title">Six platforms <ClaimTag /></h2>
        <p className="muted">What each grants and how Privilege signs in to it is the deck's list (slide 51). The lab shows the auth METHOD NAME only: it holds no credential for any platform, never shows or stores one, and credential-shaped values typed anywhere are masked (a heuristic: not every secret has a recognisable shape). The state below is each platform's own, held in this lab.</p>
      </section>
      <div className="cols">
        {story.platforms.map((p) => {
          const view = state.platforms.find((x) => x.id === p.id);
          return (
            <section className="panel" key={p.id} data-testid={`platform-${p.id}`}>
              <h3 className="panel__sub">{p.name}</h3>
              <p><strong>Grants:</strong> {p.grants}</p>
              <p><strong>Auth method:</strong> <span data-testid="auth-method">{p.authMethod}</span> <span className="muted">(name only; no credential is held, shown or stored)</span></p>
              {p.variants && <p className="muted">{p.variants} (named by the deck; not modelled separately).</p>}
              <p className="muted">Modelled: {p.modelled.join("; ")}.{p.notModelled.length > 0 && ` Not modelled: ${p.notModelled.join("; ")}.`}</p>
              {SYNC.includes(p.id) && (
                <label className="check"><input type="checkbox" checked={state.sync[p.id]} disabled={off} onChange={(e) => setSync(p.id, e.target.checked)} data-testid={`sync-${p.id}`} /> Sync (the reconcile reads this platform) <SourceTag source="reading" /></label>
              )}
              <h4 className="hops__title">The platform's own state: {p.id === "github" ? "collaborators and team members" : p.id === "gitlab" ? "group and project members" : p.id === "salesforce" ? "permission set assignments" : p.id === "snowflake" ? "role members" : p.id === "databricks" ? "privilege holders" : "admin role assignees"}</h4>
              <div className="scroll"><table className="tbl">
                <tbody>{view.groups.map((g) => (
                  <tr key={g.resource} data-testid="platform-group"><th>{visible(g.name)}<div className="muted">{g.kind}</div></th>
                    <td data-testid="platform-members">{g.members.length === 0 ? <span className="muted">no one</span> : g.members.map((m) => <span key={`${m.subjectKind}:${m.id}`} className="tag" data-state={m.origin === "privilege" ? "ok" : "bad"}>{m.id} ({m.level}){m.origin === "privilege" ? "" : " by hand"}</span>)}</td></tr>
                ))}</tbody>
              </table></div>
              {view.log.length > 0 && (
                <details><summary>The platform's own log ({view.log.length})</summary>
                  <ul className="plain">{view.log.map((l, i) => <li key={i}>{l.at.slice(0, 16).replace("T", " ")} {l.op} {l.level} for {l.subject.id} by {visible(l.actor)}</li>)}</ul>
                </details>
              )}
            </section>
          );
        })}
      </div>
      <FieldSources fields={story.fieldSources} />
    </div>
  );
}
