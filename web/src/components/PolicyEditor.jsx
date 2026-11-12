import { useEffect, useState } from "react";
import { SourceTag } from "./Bits";

const FIELDS = ["maxLevel", "maxDurationMin", "chain", "requireDistinctApprovers", "requestTtlMin", "channel", "autoApprove"];
const pick = (p) => structuredClone(Object.fromEntries(FIELDS.map((k) => [k, p[k]])));

// Every editable policy field. Self-approval is not one of them: it is always refused (deck slide 51). Changes apply to NEW requests only;
// a request already waiting keeps the chain it was created with.
export default function PolicyEditor({ policy, levels, roles, readOnly, busy, onSave, onRetire, errors }) {
  const [draft, setDraft] = useState(() => pick(policy));
  useEffect(() => { setDraft(pick(policy)); }, [policy]);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (v) => (v === "" ? "" : Number(v));
  const setChain = (i, patch) => set("chain", draft.chain.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const off = readOnly || busy || policy.retired;
  return (
    <details className="panel" data-testid="policy-editor">
      <summary>Edit the policy: {policy.name} <SourceTag source="invented" /></summary>
      <p className="muted">{readOnly ? "Mock is read-only: switch to Live to edit." : "An edit applies to new requests. A request already waiting keeps its approval chain and its chat channel, but its level and window are checked against the policy again when the last level approves: if the policy was narrowed in the meantime, that last approval is refused. Self-approval is not a setting: it is always refused."}</p>
      <div className="filters">
        <label>Highest level it may grant
          <select value={draft.maxLevel} disabled={off} onChange={(e) => set("maxLevel", e.target.value)} data-testid="pe-maxlevel">{levels.map((l) => <option key={l}>{l}</option>)}</select>
        </label>
        <label>Longest window (minutes)
          <input type="number" min="1" value={draft.maxDurationMin} disabled={off} onChange={(e) => set("maxDurationMin", num(e.target.value))} data-testid="pe-maxduration" />
        </label>
        <label>Approval window (minutes)
          <input type="number" min="5" value={draft.requestTtlMin} disabled={off} onChange={(e) => set("requestTtlMin", num(e.target.value))} data-testid="pe-ttl" />
        </label>
        <label>Approvers act from
          <select value={draft.channel} disabled={off} onChange={(e) => set("channel", e.target.value)} data-testid="pe-channel"><option>slack</option><option>mattermost</option></select>
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={draft.requireDistinctApprovers} disabled={off} onChange={(e) => set("requireDistinctApprovers", e.target.checked)} data-testid="pe-distinct" /> A different person at every level</label>
      <fieldset className="fieldset"><legend>Approval chain ({draft.chain.length} of 3 levels)</legend>
        {draft.chain.map((c, i) => (
          <div className="filters" key={i}>
            <label>Level {i + 1} approver
              <select value={c.role} disabled={off} onChange={(e) => setChain(i, { role: e.target.value })} data-testid={`pe-role-${i}`}>{roles.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select>
            </label>
            <label>Approvals required
              <select value={c.required} disabled={off} onChange={(e) => setChain(i, { required: Number(e.target.value) })} data-testid={`pe-required-${i}`}><option value={1}>1</option><option value={2}>2</option></select>
            </label>
            <button type="button" disabled={off || draft.chain.length <= 1} onClick={() => set("chain", draft.chain.filter((_, j) => j !== i))} data-testid={`pe-remove-${i}`}>Remove level {i + 1}</button>
          </div>
        ))}
        <button type="button" disabled={off || draft.chain.length >= 3} onClick={() => set("chain", [...draft.chain, { role: "security", required: 1 }])} data-testid="pe-add">Add a level</button>
      </fieldset>
      <fieldset className="fieldset"><legend>Auto-approve by policy</legend>
        <label className="check"><input type="checkbox" checked={draft.autoApprove.enabled} disabled={off} onChange={(e) => set("autoApprove", { ...draft.autoApprove, enabled: e.target.checked })} data-testid="pe-auto" /> Approve automatically when the request fits</label>
        <div className="filters">
          <label>Up to level
            <select value={draft.autoApprove.maxLevel} disabled={off} onChange={(e) => set("autoApprove", { ...draft.autoApprove, maxLevel: e.target.value })} data-testid="pe-auto-level">{levels.map((l) => <option key={l}>{l}</option>)}</select>
          </label>
          <label>Up to (minutes)
            <input type="number" min="0" value={draft.autoApprove.maxDurationMin} disabled={off} onChange={(e) => set("autoApprove", { ...draft.autoApprove, maxDurationMin: num(e.target.value) })} data-testid="pe-auto-duration" />
          </label>
        </div>
      </fieldset>
      {errors?.length > 0 && <div className="field-error" role="alert" data-testid="pe-errors">{errors.join("; ")}</div>}
      <div className="seg">
        <button type="button" disabled={off} onClick={() => onSave(draft)} data-testid="pe-save">Save policy</button>
        <button type="button" disabled={off} onClick={onRetire} data-testid="pe-retire">Retire this policy (releases the grants it issued)</button>
      </div>
    </details>
  );
}
