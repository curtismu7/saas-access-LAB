import { useCallback, useEffect, useRef, useState } from "react";
import RequestTab from "./components/RequestTab";
import ApprovalsTab from "./components/ApprovalsTab";
import TimelineTab from "./components/TimelineTab";
import DriftTab from "./components/DriftTab";
import PlatformsTab from "./components/PlatformsTab";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import LastAction from "./components/LastAction";
import useLab from "./hooks/useLab";
import { getJson, getModeInfo, resetWorkspace, setMode } from "./api";
import ShelfLink from "./components/ShelfLink.jsx";
import { workspaceId } from "./workspace.js";

export const TABS = [
  { id: "request", label: "Request" },
  { id: "approvals", label: "Approvals" },
  { id: "timeline", label: "Timeline" },
  { id: "drift", label: "Drift" },
  { id: "platforms", label: "Platforms" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims one mode before it knows: until the story answers it says both, honestly.
const TAIL = "Every product claim is a Ping release claim, UNVERIFIED on our tenant (release 2026-11-02). Nothing here calls a real platform, chat tool, gateway or tenant.";
export const BANNER_UNKNOWN = `SIMULATED, MOCK or LIVE mode (loopback only, no outbound network). ${TAIL}`;
const PRESENTER_TALK = { request: ["say-first", "request"], approvals: ["approve"], timeline: ["time-bound", "receipts"], drift: ["drift"], platforms: ["one-model"], diagram: ["why-saas-access"] };
const MODE_KEY = "sal.mode";
const THEME_KEY = "sal.theme";
const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}

const tabFromHash = () => { const h = window.location.hash.replace("#", ""); return TABS.some((t) => t.id === h) ? h : "request"; };
const savedMode = () => { try { const m = window.localStorage.getItem(MODE_KEY); return m === "live" || m === "mock" ? m : null; } catch { return null; } };

export default function App() {
  const [vertical, setVertical] = useState("finance");
  const [story, setStory] = useState(null);
  const [mode, setModeState] = useState(null);
  const [scenarioId, setScenarioId] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(tabFromHash());
  const [presenter, setPresenter] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const tabsRef = useRef(null);
  const lab = useLab({ mode, vertical, scenario: scenarioId });

  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => { getJson("/api/info").then((i) => setModeState((m) => m || savedMode() || i.mode), () => setModeState((m) => m || savedMode() || "mock")); }, []);
  useEffect(() => {
    let live = true; // a late story for a vertical the visitor has already left is dropped
    getJson(`/api/story?vertical=${encodeURIComponent(vertical)}`).then((j) => { if (live) { setStory(j); setError(null); } }, (e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [vertical]);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const setModeLocal = (m) => { setModeState(m); try { window.localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked */ } };
  // Rule 19: the toggle is server-side (POST /api/mode). Real is unavailable here, so its button is off with the
  // server's reason; Mock is the only switch that goes through, and the lab reloads its data after it.
  const [modeInfo, setModeInfo] = useState(null);
  useEffect(() => { getModeInfo().then((r) => setModeInfo(r.ok ? r.body : null)).catch(() => setModeInfo(null)); }, []);
  const switchMode = async (source) => {
    if (source === "real" && modeInfo?.realAvailable === false) return; // aria-disabled: a press does nothing
    const r = await setMode(source);
    if (!r.ok) return; // a 409 is shown by the disabled button's tooltip; nothing else to say
    setModeLocal(r.body?.source === "real" ? "live" : "mock");
    setResetSignal((n) => n + 1);
    await lab.reload();
  };
  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

  // Keep the active tab fully in view in the scrolling tab strip (375px).
  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Reset: the server clears this workspace's engines (requests, grants, receipts, the platforms' own state, outbox, audit and the clock); the diagram goes
  // back in place; the view reloads.
  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    await lab.reload();
    setResetMsg(ok ? "Reset: your workspace's requests, grants, receipts, platform state, outbox, audit trail, policies and the lab clock are back to the start, and the diagram is back in place." : "Reset failed on the server; the view was reloaded.");
  }, [lab.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const banner = story && mode ? story.banner[mode] : BANNER_UNKNOWN;
  const ready = story && mode;
  const props = { story, mode, vertical, lab };
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header>
        <p className="banner" role="status" data-state={mode === "live" ? "live" : "mock"} data-testid="banner">{banner}</p>
        <div className="head">
          <div>
            <h1 className="head__title">SaaS Access LAB</h1>
            {!presenter && story && <p className="head__intro">{story.intro}</p>}
          </div>
          <div className="head__tools">
            <ShelfLink headers={() => ({ "x-workspace": workspaceId() })} />
            <div className="seg mode-toggle" role="group" aria-label="Mode">
              <button type="button" aria-pressed={mode === "mock"} onClick={() => switchMode("mock")} data-testid="mode-mock">Mock</button>
              <button type="button" aria-pressed={mode === "live"} aria-disabled={modeInfo?.realAvailable === false ? "true" : undefined}
                title={modeInfo?.realAvailable === false ? (modeInfo.realReason || undefined) : undefined}
                onClick={() => switchMode("live")} data-testid="mode-live">Live</button>
            </div>
            <span className="chip" data-testid="mode">Mode: {mode || "..."}{mode === "live" ? " (local engine, loopback)" : mode === "mock" ? " (tables)" : ""}</span>
            {!presenter && (
              <label className="inline">Vertical{" "}
                <select value={vertical} onChange={(e) => setVertical(e.target.value)} data-testid="vertical">
                  {(story ? story.verticals : ["finance"]).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            )}
            <label className="shell-theme">Theme
              <select value={theme} onChange={(e) => pickTheme(e.target.value)}>
                {THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <button type="button" onClick={reset} data-testid="reset">Reset</button>
            <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
          </div>
        </div>
      </header>
      <main>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div role="tablist" aria-label="Lab sections" className="tabs" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {error || lab.error ? <p className="app-error" role="alert">Could not load the lab ({error || lab.error}). Is the server running?</p> : !ready ? <p className="muted">Loading...</p> : (
            <>
              {mode === "mock" && lab.scenario && ["approvals", "timeline", "drift", "platforms"].includes(tab) && (
                <p className="muted" data-testid="scenario-note">Showing the end of the scripted scenario "{lab.scenario.title}". Pick another on the Request tab, or switch to Live to act yourself.</p>
              )}
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (PRESENTER_TALK[tab] || []).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "request" && <RequestTab {...props} scenarioId={scenarioId} setScenarioId={setScenarioId} />}
              {tab === "approvals" && <ApprovalsTab {...props} />}
              {tab === "timeline" && <TimelineTab {...props} />}
              {tab === "drift" && <DriftTab key={vertical} {...props} />}
              {tab === "platforms" && <PlatformsTab {...props} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
              {mode === "live" && ["request", "approvals", "timeline", "drift", "platforms"].includes(tab) && <LastAction last={lab.last} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
