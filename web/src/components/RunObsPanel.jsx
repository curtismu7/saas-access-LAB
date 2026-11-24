import { useEffect, useMemo, useState } from "react";
import RunObservability from "../run-observability/RunObservability.jsx";
import { getJson } from "../api";

// Rule 27: the page's wrapper of the vendored panel. It asks the server for the record of the mode and scenario on screen, and it never shows a record
// that answers another request: each request is keyed by its own object, so a late answer for an older request is dropped.
const STREAMS = [{
  product: "saas-access-lab",
  lives: "The lab's container stdout: one timestamped line for each Live decision (step, actor, result, run). Mock rows are not written to any log.",
  streams: "Not shipped today: shared/ping-log-collector/vector.yaml does not list this lab's container. No log is read by this lab.",
}];

// The answer must be a run record or null (no run yet). Anything else, a page, a list, a string, an object with no record, is an alert.
const answerOk = (body) => body !== null && typeof body === "object" && !Array.isArray(body) && "record" in body
  && (body.record === null || (typeof body.record === "object" && !Array.isArray(body.record) && Array.isArray(body.record.rows)));

export default function RunObsPanel({ mode, vertical, scenario, stamp }) {
  const want = useMemo(() => ({ mode, vertical, scenario: mode === "mock" ? scenario || "" : "" }), [mode, vertical, scenario, stamp]);
  const [got, setGot] = useState(null);

  useEffect(() => {
    let current = true;
    const q = `mode=${want.mode}&vertical=${encodeURIComponent(want.vertical)}${want.scenario ? `&scenario=${encodeURIComponent(want.scenario)}` : ""}`;
    getJson(`/api/run-observability?${q}`)
      .then((body) => {
        if (!current) return;
        if (!answerOk(body)) return setGot({ want, error: "the server did not answer with a run record" });
        setGot({ want, record: body.record });
      })
      .catch((e) => { if (current) setGot({ want, error: String(e?.message || "unknown error") }); });
    return () => { current = false; };
  }, [want]);

  const shown = got && got.want === want ? got : null;
  return (
    <section className="run-obs-wrap" aria-label="Run observability for this page">
      {!shown && <p className="muted" role="status" data-testid="run-obs-loading">Reading this run...</p>}
      {shown?.error && <p className="app-error" role="alert" data-testid="run-obs-error">The run could not be read ({shown.error}). Change the mode or the scenario to try again.</p>}
      {shown && !shown.error && <RunObservability record={shown.record} source={want.mode === "live" ? "real" : "mock"} streams={STREAMS} />}
      <p className="muted run-obs-note" data-testid="run-obs-note">
        Each row is one event of this lab's own policy engine, not by a Ping product. Only policy points are decisions (allowed, refused or blocked); other rows are info. Configuration changes (policies, integrations, sync) leave no row.
        Mock rows are what the mock computed when its table was built. Live rows are the lab's own answers, each also one stdout line. No product is called and no log is read.
      </p>
    </section>
  );
}
