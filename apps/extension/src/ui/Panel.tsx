import { Button, CorbitsMark } from "@corbits/react-ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CheckManager } from "./CheckManager.tsx";
import { Settings } from "./Settings.tsx";
import { useActivePr } from "./use-active-pr.ts";

type Screen = { kind: "settings" } | { kind: "rules"; repo: string };

/** The extension's settings and the rules saved in this browser; a pull request's result shows on its own page. */
export function Panel() {
  const active = useActivePr();
  const [screen, setScreen] = useState<Screen>({ kind: "settings" });
  const panelRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Screen["kind"] | null>(null);

  // The button that changed the screen goes with it, so focus moves to the new screen's heading.
  useEffect(function focusScreen() {
    if (shown.current !== null && shown.current !== screen.kind) panelRef.current?.querySelector<HTMLElement>("h1")?.focus();
    shown.current = screen.kind;
  }, [screen.kind]);

  function back() {
    setScreen({ kind: "settings" });
  }

  function manageRules(repo: string) {
    setScreen({ kind: "rules", repo });
  }

  function openSettings() {
    setScreen({ kind: "settings" });
  }

  if (!active) return null;
  return (
    <div className="panel" ref={panelRef}>
      <header className="panel-header">
        {screen.kind === "rules"
          ? <Button size="icon" variant="ghost" aria-label="Back" onClick={back}><ArrowLeft aria-hidden="true" /></Button>
          : <CorbitsMark decorative className="mark" />}
        <h1 className="brand" tabIndex={-1}>{screen.kind === "rules" ? "Rules" : "Corbits Triage"}</h1>
      </header>
      <main className="panel-main">
        {screen.kind === "settings" ? <Settings pr={active.pr} onManageRules={manageRules} /> : <CheckManager repo={screen.repo} pr={active.pr} onAddModel={openSettings} />}
      </main>
    </div>
  );
}
