import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import { QUEUE_STATE_LABEL, type PrItem } from "../lib/hub-api.ts";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import { actionLane, filterTriageItems, prHref, relativeTime, sortTriageItems, type TriageBoardView } from "../lib/triage-view.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useQueueItems } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { useRunLogs } from "../lib/run-logs.ts";

function viewFromPath(pathname: string): TriageBoardView {
  if (pathname.endsWith("/merge")) return "merge";
  if (pathname.endsWith("/all")) return "all";
  return "action";
}

function Card({ item }: { item: PrItem }) {
  return (
    <Link className={`pr-card${item.needsHuman ? " needs" : ""}`} to={prHref(item)}>
      <div className="pr-card-top">
        <strong>{item.title ?? item.key}</strong>
        <span className={`pri ${(item.priority ?? "none").toLowerCase()}`}>{item.priority ?? "—"}</span>
      </div>
      <div className="pr-card-meta">
        <span className="mono">{item.repo}{item.number ? ` #${item.number}` : ""}</span>
        <span>{QUEUE_STATE_LABEL[item.state]}</span>
        <span>{item.owner ?? "Unassigned"}</span>
        <span>{relativeTime(item.waitingSince)}</span>
      </div>
      {item.evidence[0] ? <p className="pr-card-why">{item.evidence[0]}</p> : null}
      <p className="pr-card-next">{item.nextAction ?? "No next action recorded"}</p>
    </Link>
  );
}

function Lane({ title, items }: { title: string; items: PrItem[] }) {
  return (
    <section className="lane">
      <header className="lane-head">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </header>
      {items.length ? items.map((item) => <Card key={item.key} item={item} />) : <p className="lane-empty">None</p>}
    </section>
  );
}

export default function Triage() {
  const { snapshot } = usePortal();
  const location = useLocation();
  const view = viewFromPath(location.pathname);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const allItems = useQueueItems();
  const shown = useMemo(function filterShown() {
    const normalized = query.trim().toLowerCase();
    function matchesQuery(item: PrItem): boolean {
      if (!normalized) return true;
      return `${item.title ?? ""} ${item.key} ${item.repo} ${item.owner ?? ""} ${item.nextAction ?? ""} ${item.evidence.join(" ")}`.toLowerCase().includes(normalized);
    }
    return sortTriageItems(filterTriageItems(allItems, view).filter(matchesQuery));
  }, [allItems, query, view]);
  const { logs, denied } = useRunLogs();
  const connectedRepos = snapshot?.repos.filter((repo) => repo.connected) ?? [];
  const catchingUp = snapshot ? connectedRepos.some((repo) => isRepoCatchingUp(logs, snapshot.runs, repo.name)) : false;
  const title = view === "action" ? "Triaged" : view === "merge" ? "Ready to Merge" : "All PRs";
  const lede = view === "action"
    ? "Every triaged pull request, ranked by priority."
    : view === "merge"
      ? "Checks are green and GitHub says these can merge. Merge is a maintainer action, not auto."
      : "Every pull request that went through checks. Human-needed first.";
  const empty = query.trim()
    ? "No pull requests match this search."
    : connectedRepos.length === 0
      ? "No repositories yet."
      : catchingUp
        ? "Catching up open pull requests."
        : "Nothing in this view.";

  useEffect(function focusSearchOnSlash() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && !isInteractiveShortcutTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const board = (
    <div className="board">
      <Lane title="P0 / P1" items={shown.filter((item) => actionLane(item) === "p01")} />
      <Lane title="P2" items={shown.filter((item) => actionLane(item) === "p2")} />
      <Lane title="P3" items={shown.filter((item) => actionLane(item) === "p3")} />
    </div>
  );
  const stack = <div className="card-stack">{shown.map((item) => <Card key={item.key} item={item} />)}</div>;

  return (
    <div className="main-shell">
      <div className="topbar">
        <label className="topbar-search">
          <span className="sr-only">Search pull requests</span>
          <Search strokeWidth={1.7} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search pull requests"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="workspace">
        <header className="workspace-head">
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p className="lede">{lede}</p>
            </div>
          </div>
          <nav className="view-tabs" aria-label="Triage views">
            <NavLink to="/triage/action">Triaged</NavLink>
            <NavLink to="/triage/merge">Ready to Merge</NavLink>
            <NavLink to="/triage/all">All PRs</NavLink>
          </nav>
        </header>
        <main id="main" className="scroller">
          <div className="content-wide">
            {denied && <DeniedNotice section="logs" />}
            {!denied && connectedRepos.length === 0 && shown.length === 0 ? (
              <div className="empty">
                <p>No repositories yet.</p>
                <Link className="btn primary" to="/repositories">Choose repositories on GitHub</Link>
              </div>
            ) : !denied && shown.length === 0 ? (
              <div className="empty">{empty}</div>
            ) : view === "action" ? board : stack}
          </div>
        </main>
      </div>
    </div>
  );
}
