import { Button, CorbitsMark, formatRelativeTime } from "@corbits/react-ui";
import { ArrowLeft, Maximize2, RotateCw, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { send } from "../messages.ts";
import { prKey, type PrRef } from "../pr.ts";
import { onboarded, runStates, views } from "../storage.ts";
import type { TriageView } from "../view.ts";
import { CheckManager } from "./CheckManager.tsx";
import { Home } from "./Home.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { PrView } from "./PrView.tsx";
import { Settings } from "./Settings.tsx";
import { useActivePr } from "./use-active-pr.ts";
import { useStorageItem } from "./use-storage.ts";

type Screen = { kind: "main" } | { kind: "settings" } | { kind: "checks"; repo: string };

const SCREEN_TITLES: Record<Screen["kind"], string | null> = { main: null, settings: "Settings", checks: "Rules" };

/** The full-tab workspace, on the pull request the panel shows. */
async function expand(pr: PrRef | undefined) {
  await browser.tabs.create({ url: browser.runtime.getURL(`/workspace.html${pr ? `#${encodeURIComponent(prKey(pr))}` : ""}`) });
}

function Header({ screen, pr, onBack, onSettings }: { screen: Screen; pr: PrRef | undefined; onBack: () => void; onSettings: () => void }) {
  const sub = SCREEN_TITLES[screen.kind];
  return (
    <header className="panel-header">
      {sub
        ? <Button size="icon" variant="ghost" aria-label="Back" onClick={onBack}><ArrowLeft aria-hidden="true" /></Button>
        : <CorbitsMark decorative className="mark" />}
      {sub ? <h1 className="brand" tabIndex={-1}>{sub}</h1> : <p className="brand">Corbits Triage</p>}
      <Button size="icon" variant="ghost" aria-label="Expand into a full tab" title="Expand into a full tab" onClick={() => expand(pr)}><Maximize2 aria-hidden="true" /></Button>
      {sub ? null : <Button size="icon" variant="ghost" aria-label="Settings" onClick={onSettings}><SettingsIcon aria-hidden="true" /></Button>}
    </header>
  );
}

function Footer({ view, running, onRerun }: { view: TriageView | undefined; running: boolean; onRerun: () => void }) {
  return (
    <footer className="panel-footer">
      <p className="footer-meta">{running ? "Running…" : view ? `Updated ${formatRelativeTime(view.checkedAt ?? view.ranAt)}` : null}</p>
      <Button size="sm" variant="outline" disabled={running} onClick={onRerun}><RotateCw aria-hidden="true" className={running ? "spin" : undefined} />Run again</Button>
    </footer>
  );
}

export function Panel() {
  const active = useActivePr();
  const done = useStorageItem(onboarded);
  const allViews = useStorageItem(views);
  const allStates = useStorageItem(runStates);
  const [screen, setScreen] = useState<Screen>({ kind: "main" });
  const panelRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Screen["kind"] | null>(null);
  const pr = active?.pr;
  const key = pr ? prKey(pr) : undefined;
  const view = key ? allViews?.[key] : undefined;
  const state = key ? allStates?.[key] : undefined;
  const title = view?.title || active?.title.replace(/ · .*$/, "") || "";

  useEffect(function triageActivePr() {
    if (pr) send({ type: "triage", pr, mode: "if-stale" });
  }, [key]);

  // Another pull request brings the panel back to its triage; a page that is none leaves the settings where they were.
  useEffect(function backToMainOnPrChange() {
    if (key) setScreen({ kind: "main" });
  }, [key]);

  // The button that changed the screen goes with it, so focus moves to the new screen's first heading.
  useEffect(function focusScreen() {
    if (shown.current !== null && shown.current !== screen.kind) panelRef.current?.querySelector<HTMLElement>("h1")?.focus();
    shown.current = screen.kind;
  }, [screen.kind]);

  function rerun() {
    if (pr) send({ type: "triage", pr, mode: "refetch" });
  }

  function back() {
    setScreen(screen.kind === "checks" ? { kind: "settings" } : { kind: "main" });
  }

  function openSettings() {
    setScreen({ kind: "settings" });
  }

  function manageChecks(repo: string) {
    setScreen({ kind: "checks", repo });
  }

  if (!active || done === undefined) return null;
  return (
    <div className="panel" ref={panelRef}>
      <Header screen={screen} pr={pr} onBack={back} onSettings={openSettings} />
      <main className="panel-main">
        {screen.kind === "settings" ? <Settings pr={pr} onManageChecks={manageChecks} /> : null}
        {screen.kind === "checks" ? <CheckManager repo={screen.repo} pr={pr} onAddModel={openSettings} /> : null}
        {screen.kind === "main" && pr ? <PrView pr={pr} title={title} tabId={active.tabId} view={view} state={state} /> : null}
        {screen.kind === "main" && !pr ? (done ? <Home /> : <Onboarding />) : null}
      </main>
      {screen.kind === "main" && pr ? <Footer view={view} running={state?.running === true} onRerun={rerun} /> : null}
    </div>
  );
}
