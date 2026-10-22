import { Button, CorbitsMark, formatRelativeTime } from "@corbits/react-ui";
import { ArrowLeft, RotateCw, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { send } from "../messages.ts";
import { prKey } from "../pr.ts";
import { runStates, views } from "../storage.ts";
import type { TriageView } from "../view.ts";
import { PrView } from "./PrView.tsx";
import { Settings } from "./Settings.tsx";
import { useActivePr } from "./use-active-pr.ts";
import { useStorageItem } from "./use-storage.ts";

function Header({ settings, onBack, onSettings }: { settings: boolean; onBack: () => void; onSettings: () => void }) {
  return (
    <header className="panel-header">
      {settings
        ? <Button size="icon" variant="ghost" aria-label="Back" onClick={onBack}><ArrowLeft aria-hidden="true" /></Button>
        : <CorbitsMark decorative className="mark" />}
      {settings ? <h1 className="brand" tabIndex={-1}>Settings</h1> : <p className="brand">Corbits Triage</p>}
      {settings ? null : <Button size="icon" variant="ghost" aria-label="Settings" onClick={onSettings}><SettingsIcon aria-hidden="true" /></Button>}
    </header>
  );
}

function Footer({ view, running, onRerun }: { view: TriageView | undefined; running: boolean; onRerun: () => void }) {
  return (
    <footer className="panel-footer">
      <p className="footer-meta">{running ? "Running…" : view ? `Updated ${formatRelativeTime(view.ranAt)}` : null}</p>
      <Button size="sm" variant="outline" disabled={running} onClick={onRerun}><RotateCw aria-hidden="true" className={running ? "spin" : undefined} />Run again</Button>
    </footer>
  );
}

/** The pull request in the active tab, checked against its policy; settings behind the gear. */
export function Panel() {
  const active = useActivePr();
  const allViews = useStorageItem(views);
  const allStates = useStorageItem(runStates);
  const [settings, setSettings] = useState(false);
  const pr = active?.pr;
  const key = pr ? prKey(pr) : undefined;
  const view = key ? allViews?.[key] : undefined;
  const state = key ? allStates?.[key] : undefined;
  const title = active?.title.replace(/ · .*$/, "").replace(/ by [^ ]+$/, "") ?? "";

  useEffect(function triageActivePr() {
    if (pr) send({ type: "triage", pr, mode: "if-stale" });
  }, [key]);

  function rerun() {
    if (pr) send({ type: "triage", pr, mode: "refetch" });
  }

  function back() {
    setSettings(false);
  }

  function openSettings() {
    setSettings(true);
  }

  if (!active) return null;
  const main = settings || !pr;
  return (
    <div className="panel">
      <Header settings={settings} onBack={back} onSettings={openSettings} />
      <main className="panel-main">
        {settings ? <Settings /> : null}
        {!settings && pr ? <PrView pr={pr} title={title} view={view} state={state} /> : null}
        {!settings && !pr ? <p className="hint">Open a pull request on github.com to check it against its repository's policy file.</p> : null}
      </main>
      {main ? null : <Footer view={view} running={state?.running === true} onRerun={rerun} />}
    </div>
  );
}
