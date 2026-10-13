import { Button, CorbitsMark, EmptyState, formatRelativeTime, Skeleton, Tabs } from "@corbits/react-ui";
import { ExternalLink, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../error-text.ts";
import { ask, send, type OpenPr } from "../messages.ts";
import { pageActions } from "../page-actions.ts";
import { prKey, type PrRef } from "../pr.ts";
import { localPacks, runStates, views, type RunState } from "../storage.ts";
import { stateName, toneOf, type TriageView } from "../view.ts";
import { CheckList } from "./CheckList.tsx";
import { CheckManager } from "./CheckManager.tsx";
import { openExamplePr } from "./example-pr.ts";
import { Actions, RunFailed, ScoreCard } from "./PrView.tsx";
import { Settings } from "./Settings.tsx";
import { useStorageItem } from "./use-storage.ts";

type Pane = "triage" | "checks" | "settings";

const PANES = [
  { id: "triage", label: "Triage" },
  { id: "checks", label: "Checks" },
  { id: "settings", label: "Settings" },
] as const;

type OpenList = { state: "loading" } | { state: "loaded"; prs: OpenPr[] } | { state: "failed"; error: string };

const KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** The pull request in the address's hash, as the panel's expand button and a pick in the list set it. */
function fromHash(): PrRef | undefined {
  const match = KEY.exec(decodeURIComponent(location.hash.slice(1)));
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

/** A GitHub tab showing the pull request, where its actions apply; none until one opens. */
function usePrTab(pr: PrRef | undefined): number | undefined {
  const [tabId, setTabId] = useState<number>();
  useEffect(function followTabs() {
    let live = true;
    async function find() {
      const tabs = pr ? await browser.tabs.query({ url: `https://github.com/${pr.repo}/pull/${pr.number}*` }) : [];
      if (live) setTabId(tabs.find((tab) => tab.id !== undefined)?.id);
    }
    function onUpdated(_tabId: number, change: Browser.tabs.OnUpdatedInfo) {
      if (change.url !== undefined || change.status === "complete") find();
    }
    function onRemoved() {
      find();
    }
    find();
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    return function stop() {
      live = false;
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [pr?.repo, pr?.number]);
  return tabId;
}

function PrRow({ pr, title, view, selected, onSelect }: { pr: PrRef; title: string; view: TriageView | undefined; selected: boolean; onSelect: (pr: PrRef) => void }) {
  return (
    <li>
      <button type="button" className="ws-row" aria-current={selected ? "true" : undefined} onClick={() => onSelect(pr)}>
        <span className="recent-score mono" data-tone={view ? toneOf(view) : "none"}>{view ? view.readiness ?? "–" : ""}</span>
        <span className="recent-body">
          <b>{title || `Pull request #${pr.number}`}</b>
          <span><span className="mono">#{pr.number}</span> · {view ? stateName(view) : "Not scored yet"}</span>
        </span>
      </button>
    </li>
  );
}

type RepoGroupProps = { repo: string; scored: TriageView[]; list: OpenList | undefined; selected: PrRef | undefined; onSelect: (pr: PrRef) => void; onLoad: (repo: string) => void };

function RepoGroup({ repo, scored, list, selected, onSelect, onLoad }: RepoGroupProps) {
  const known = new Set(scored.map((view) => view.pr.number));
  const unscored = list?.state === "loaded" ? list.prs.filter((pr) => !known.has(pr.number)) : [];
  const isSelected = (number: number) => selected?.repo === repo && selected.number === number;
  return (
    <section className="ws-repo" aria-label={repo}>
      <h2 className="ws-repo-name mono" title={repo}>{repo}</h2>
      <ul>
        {scored.map((view) => <PrRow key={view.pr.number} pr={view.pr} title={view.title} view={view} selected={isSelected(view.pr.number)} onSelect={onSelect} />)}
        {unscored.map((pr) => <PrRow key={pr.number} pr={{ repo, number: pr.number }} title={pr.title} view={undefined} selected={isSelected(pr.number)} onSelect={onSelect} />)}
      </ul>
      {list?.state === "loaded" ? <p className="hint">{list.prs.length ? `The ${list.prs.length} newest open, ${unscored.length} not scored yet.` : "No open pull requests."}</p> : null}
      {list?.state === "failed" ? <p className="error" role="alert">{list.error}</p> : null}
      {list?.state !== "loaded" ? (
        <button type="button" className="text-button" disabled={list?.state === "loading"} onClick={() => onLoad(repo)}>
          {list?.state === "loading" ? "Reading open pull requests…" : "Show its open pull requests"}
        </button>
      ) : null}
    </section>
  );
}

function PrDetail({ pr, view, state }: { pr: PrRef; view: TriageView | undefined; state: RunState | undefined }) {
  const tabId = usePrTab(pr);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A pick in the list goes with the button that made it, so focus moves to the chosen pull request's heading.
  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);
  const title = view?.title ?? "";
  const running = state?.running === true;
  const limited = state?.error !== undefined && state.resetAt !== undefined;
  const actions = view ? pageActions(view).length > 0 : false;

  function rerun() {
    send({ type: "triage", pr, mode: "refetch" });
  }

  return (
    <article className="ws-pr">
      <header className="ws-pr-head">
        <div className="pr-id">
          <h1 tabIndex={-1} ref={headingRef}>{title || `Pull request #${pr.number}`}</h1>
          <p className="mono pr-ref"><span className="pr-repo">{pr.repo}</span><span className="pr-number">#{pr.number}</span></p>
        </div>
        <div className="row">
          <p className="footer-meta">{running ? "Running…" : view ? `Updated ${formatRelativeTime(view.checkedAt ?? view.ranAt)}` : null}</p>
          <Button size="sm" variant="outline" disabled={running} onClick={rerun}><RotateCw aria-hidden="true" className={running ? "spin" : undefined} />Run again</Button>
          <Button asChild size="sm" variant="outline"><a href={`https://github.com/${pr.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer">Open on GitHub<ExternalLink aria-hidden="true" /></a></Button>
        </div>
      </header>
      {state?.error ? <RunFailed pr={pr} view={view} state={state} /> : null}
      {!view && !state?.error ? (
        <div className="loading" role="status" aria-label="Scoring the pull request">
          <Skeleton className="skeleton score" />
          <Skeleton className="skeleton list" />
        </div>
      ) : null}
      {view ? (
        <div className="ws-grid">
          <div className="ws-col">
            <ScoreCard view={view} />
            {actions && tabId === undefined ? <p className="hint">Open the pull request on GitHub to apply these as yourself.</p> : null}
            <Actions view={view} tabId={tabId} primary={!limited && tabId !== undefined} />
          </div>
          <section className="part ws-col" aria-labelledby="ws-checks-head">
            <h2 id="ws-checks-head">Checks</h2>
            <CheckList view={view} expanded />
          </section>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The extension in a full tab: repositories and their pull requests on the left, the chosen one's full triage on the
 * right, with the check manager and settings beside it. The side panel stays the quick view.
 */
export function Workspace() {
  const allViews = useStorageItem(views);
  const allStates = useStorageItem(runStates);
  const packs = useStorageItem(localPacks);
  const [selected, setSelected] = useState<PrRef | undefined>(fromHash);
  const [pane, setPane] = useState<Pane>("triage");
  const [checksRepo, setChecksRepo] = useState<string>();
  const [lists, setLists] = useState<Record<string, OpenList>>({});
  const key = selected ? prKey(selected) : undefined;

  useEffect(function followHash() {
    function onHash() {
      setSelected(fromHash());
    }
    window.addEventListener("hashchange", onHash);
    return function stop() {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(function triageSelected() {
    if (selected) send({ type: "triage", pr: selected, mode: "if-stale" });
  }, [key]);

  if (allViews === undefined || allStates === undefined || packs === undefined) return null;
  const scored = Object.values(allViews).sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  const repos = [...new Set([...(selected ? [selected.repo] : []), ...scored.map((view) => view.pr.repo), ...Object.keys(packs)])];
  const checksFor = checksRepo ?? selected?.repo ?? repos[0];

  function select(pr: PrRef) {
    location.hash = encodeURIComponent(prKey(pr));
    setPane("triage");
  }

  async function load(repo: string) {
    setLists((all) => ({ ...all, [repo]: { state: "loading" } }));
    try {
      const prs = await ask({ type: "open-prs", repo });
      setLists((all) => ({ ...all, [repo]: { state: "loaded", prs } }));
    } catch (cause) {
      setLists((all) => ({ ...all, [repo]: { state: "failed", error: errorText(cause) } }));
    }
  }

  function openSettings() {
    setPane("settings");
  }

  function manageChecks(repo: string) {
    setChecksRepo(repo);
    setPane("checks");
  }

  return (
    <div className="ws">
      <nav className="ws-nav" aria-label="Pull requests">
        <p className="brand ws-brand"><CorbitsMark decorative className="mark" />Corbits Triage</p>
        {repos.length ? repos.map((repo) => (
          <RepoGroup key={repo} repo={repo} scored={scored.filter((view) => view.pr.repo === repo)} list={lists[repo]} selected={selected} onSelect={select} onLoad={load} />
        )) : <p className="hint ws-empty-nav">Pull requests you open on GitHub are listed here once scored.</p>}
      </nav>
      <main className="ws-main">
        <Tabs tabs={PANES} active={pane} onChange={setPane} label="Workspace sections">
          {function panel(active) {
            if (active === "settings") return <div className="ws-narrow"><Settings pr={selected} onManageChecks={manageChecks} /></div>;
            if (active === "checks") {
              return checksFor
                ? <div className="ws-narrow"><h1 className="ws-pane-title mono">{checksFor}</h1><CheckManager repo={checksFor} pr={selected?.repo === checksFor ? selected : undefined} onAddModel={openSettings} /></div>
                : <EmptyState title="No repository yet" description="Open a pull request on GitHub, and its repository's checks can be changed here." />;
            }
            return selected
              ? <PrDetail key={key} pr={selected} view={allViews[key!]} state={allStates[key!]} />
              : <EmptyState title="Pick a pull request" description="Choose one on the left, or open an example to see what Triage finds." action={<Button variant="outline" onClick={openExamplePr}>Open an example pull request</Button>} />;
          }}
        </Tabs>
      </main>
    </div>
  );
}
