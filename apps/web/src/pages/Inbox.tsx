import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { PrItem } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import {
  INBOX_GROUPINGS,
  ageText,
  groupInbox,
  inboxAction,
  inboxHref,
  inboxStatus,
  initialsOf,
  matchesQuery,
  primaryAction,
  primaryLabel,
  regroupInbox,
  rowActionLabel,
  rowWhy,
  type InboxAction,
  type InboxGrouping,
  type InboxPile,
  type PrimaryAction,
} from "../lib/inbox-view.ts";
import { useQueueItems, useQueueLoading } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { useRunLogs } from "../lib/run-logs.ts";
import { findPrItem, prHref } from "../lib/triage-view.ts";
import { CheckIcon, ChevronIcon, DownIcon, ExternalIcon, SearchIcon } from "../components/inbox-icons.tsx";

const GROUPING_LABEL: Record<InboxGrouping, string> = { action: "Action", repo: "Repo", owner: "Owner" };

function actionDot(action: InboxAction | null): string {
  if (action === "merge") return "dot ready";
  if (action === "unblock") return "dot blocked";
  if (action === null) return "dot wait";
  return "dot";
}

function dotClass(item: PrItem, action: InboxAction | null): string {
  return item.running ? `${actionDot(action)} live` : actionDot(action);
}

function Row({ item, selected }: { item: PrItem; selected: boolean }) {
  const action = inboxAction(item);
  const why = rowWhy(item);
  return (
    <Link className="row" role="option" aria-selected={selected} to={inboxHref(item)} data-inbox-row={item.key}>
      <span className={dotClass(item, action)} />
      <span className="tw"><b>{item.title ?? item.key}</b>{why ? <span className="why">{why}</span> : null}</span>
      <span className="age">{ageText(item.waitingSince)}</span>
      {action === null ? null : <span className="act">{rowActionLabel(primaryAction(item, action))}</span>}
    </Link>
  );
}

function Pile({ pile, selectedKey }: { pile: InboxPile; selectedKey: string | undefined }) {
  return (
    <>
      <div className="gh">{pile.label}<span className="n">{pile.items.length}</span></div>
      {pile.items.map((item) => <Row key={item.key} item={item} selected={item.key === selectedKey} />)}
    </>
  );
}

type Composer = { kind: "comment" | "changes"; body: string };

function Pane({ item, onBack }: { item: PrItem; onBack: () => void }) {
  const { snapshot, writeGithub, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const [reply, setReply] = useState(item.comment ?? "");
  const [composer, setComposer] = useState<Composer | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const action = inboxAction(item);
  const primary = action === null ? null : primaryAction(item, action);
  const pr = pull.data?.pr;
  const github = item.number === null ? null : `https://github.com/${item.repo}/pull/${item.number}`;
  const floor = snapshot?.config?.confidenceFloor;
  const author = pr?.author ?? item.author;
  // A running pull request's verdict is about to be superseded, so nothing acts on it.
  const canWrite = item.number !== null && !item.running && !readOnly && !busy;
  const canMerge = canWrite && (pr?.mergeable ?? item.mergeable) === true && (pr?.draft ?? item.draft) !== true;
  const ciChecks = pull.data?.checks ?? [];
  const ciPassing = ciChecks.length > 0 && ciChecks.every((check) => /pass|success|neutral|skipped/i.test(check.conclusion ?? check.status));
  const edited = item.comment !== null && reply !== item.comment;

  useEffect(function closeMenuOnOutsideClick() {
    if (!menu) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  async function run(kind: PrimaryAction) {
    if (item.number === null || item.running) return;
    setMenu(false);
    if (kind === "comment" || kind === "changes") {
      setComposer({ kind, body: composer?.kind === kind ? composer.body : "" });
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (kind === "reply") {
        if (!reply.trim()) throw new Error("The reply must not be empty.");
        await writeGithub({ action: "reply", repo: item.repo, number: item.number, body: reply });
        if (item.labels.length > 0) await writeGithub({ action: "labels", repo: item.repo, number: item.number, labels: item.labels });
        setDone(`Posted to GitHub on #${item.number}.`);
      } else if (kind === "approve") {
        await writeGithub({ action: "review", repo: item.repo, number: item.number, event: "APPROVE", body: "" });
        setDone(`Approved #${item.number}.`);
      } else if (kind === "merge") {
        await writeGithub({ action: "merge", repo: item.repo, number: item.number });
        setDone(`Merged #${item.number}.`);
      } else {
        await writeGithub({ action: "close", repo: item.repo, number: item.number, labels: item.labels, comment: item.comment ?? "" });
        setDone(`Closed #${item.number}.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (item.number === null || item.running || !composer) return;
    if (!composer.body.trim()) {
      setError("The comment must not be empty.");
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (composer.kind === "comment") {
        await writeGithub({ action: "comment", repo: item.repo, number: item.number, body: composer.body });
      } else {
        await writeGithub({ action: "review", repo: item.repo, number: item.number, event: "REQUEST_CHANGES", body: composer.body });
      }
      setComposer(null);
      setDone(`Posted to GitHub on #${item.number}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function onReplyKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && primary === "reply") void run("reply");
  }

  useEffect(function paneShortcuts() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isInteractiveShortcutTarget(event.target)) return;
      if (event.key === "a" && primary !== null) {
        event.preventDefault();
        void run(primary);
      }
      if (event.key === "e" && replyRef.current) {
        event.preventDefault();
        replyRef.current.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const more: Array<{ kind: PrimaryAction; label: string; enabled: boolean; shown: boolean }> = [
    { kind: "approve", label: "Approve", enabled: canWrite, shown: true },
    { kind: "changes", label: "Request changes", enabled: canWrite, shown: true },
    { kind: "comment", label: "Comment", enabled: canWrite, shown: true },
    { kind: "merge", label: "Merge", enabled: canMerge, shown: true },
    { kind: "close", label: "Close as duplicate", enabled: canWrite, shown: item.canClose },
  ];

  return (
    <section className="panel pane" aria-label="Selected pull request">
      <button type="button" className="btn btn-quiet btn-sm pane-back" onClick={onBack}>Back to inbox</button>
      <div className="scroll">
        <div className="pane-in">
          <header className="ph">
            <div className="crumb">
              <Link className="mono repo-link" to={`/repositories/${encodeURIComponent(item.repo)}`} title="Repository settings">{item.repo}</Link>
              {item.number === null ? null : <span className="mono">#{item.number}</span>}
              <span className="sp" />
              {github ? <a className="btn btn-quiet btn-sm" href={github} target="_blank" rel="noreferrer">GitHub <ExternalIcon /></a> : null}
            </div>
            <h2 className="title">{pr?.title ?? item.title ?? item.key}</h2>
            <div className="byline">
              {author ? <span className="who"><span className="av">{initialsOf(author)}</span><span className="nm">{author}</span></span> : null}
              <span>opened {ageText(item.waitingSince)} ago</span>
              {pr ? <span><span className="mono">+{pr.additions} −{pr.deletions}</span></span> : null}
              {pr ? <span>{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}</span> : null}
              {ciChecks.length > 0 ? <span className="ci"><span className={ciPassing ? "dot ready" : "dot hollow"} />CI {ciPassing ? "passing" : "waiting"}</span> : null}
            </div>
          </header>
          <div className="route">
            {item.owner ? <span className="av">{initialsOf(item.owner)}</span> : <span className="av none" />}
            <div className="route-t">
              <div className="l1"><b>{item.owner ?? "Unassigned"}</b>{item.owner ? " from the verdict" : ""}</div>
            </div>
          </div>
          <section className="verdict">
            <p className="vh">{item.running ? inboxStatus(item) : (item.nextAction ?? item.evidence[0] ?? inboxStatus(item))}</p>
            <div className="vm">
              <span><span className="st"><span className={dotClass(item, action)} />{inboxStatus(item)}</span></span>
              {item.priority ? <span><b>{item.priority}</b></span> : null}
              {item.confidence === null ? null : (
                <span><b className="mono">{Math.round(item.confidence * 100)}%</b> sure{floor !== undefined && item.confidence < floor ? `, under your ${Math.round(floor * 100)}% bar` : ""}</span>
              )}
            </div>
          </section>
          {item.checks.length > 0 || item.evidence.length > 0 ? (
            <ul className="why">
              {item.checks.map((check) => (
                <li key={check.check}>
                  <span className={`mk ${check.result === "pass" ? "ok" : check.result === "fail" ? "flag" : "judge"}`}>{check.result === "pass" ? "✓" : check.result === "fail" ? "!" : "?"}</span>
                  <span>{check.reason || check.check}<small>{check.kind === "model" ? "Decision model" : check.check}</small></span>
                </li>
              ))}
              {item.checks.length === 0 ? item.evidence.map((reason) => <li key={reason}><span className="mk judge">?</span><span>{reason}</span></li>) : null}
            </ul>
          ) : null}
          <Link className="disclose" to={prHref(item)}>
            <ChevronIcon />
            Show details
            <span>{item.checks.length} checks{pr ? ` · ${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}` : ""} · commits · conversation</span>
          </Link>
          {item.comment !== null ? (
            <>
              <h3 className="lbl-h">
                Suggested reply
                {edited ? <span className="tag" style={{ margin: 0 }}>Edited</span> : null}
                <span className="sp" />
                <span className="hint"><kbd>e</kbd> edit · <kbd>⌘</kbd><kbd>⏎</kbd> send</span>
              </h3>
              <div className="compose">
                <textarea ref={replyRef} value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={onReplyKey} aria-label="Suggested reply" />
                {item.labels.length > 0 ? <div className="foot">Labels {item.labels.map((label) => <span key={label} className="lbl">{label}</span>)}</div> : null}
              </div>
            </>
          ) : null}
          {composer ? (
            <form className="compose composer" onSubmit={submitComposer}>
              <textarea
                value={composer.body}
                onChange={(event) => setComposer({ ...composer, body: event.target.value })}
                placeholder={composer.kind === "changes" ? "What needs to change" : "Write a comment"}
                aria-label={composer.kind === "changes" ? "Requested changes" : "Comment"}
              />
              <div className="foot">
                <button type="submit" className="btn btn-sm" disabled={busy || readOnly}>{composer.kind === "changes" ? "Request changes" : "Comment"}</button>
                <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => setComposer(null)}>Cancel</button>
              </div>
            </form>
          ) : null}
          {error ? <p role="alert" className="error">{error}</p> : null}
          {done ? <p role="status" className="note">{done}</p> : null}
        </div>
      </div>
      <div className="bar">
        {primary === null ? null : (
          <button type="button" className="btn btn-primary" disabled={primary === "merge" ? !canMerge : !canWrite} onClick={() => void run(primary)}>
            {primary === "reply" && edited ? "Post edited reply" : primaryLabel(primary)} <kbd>a</kbd>
          </button>
        )}
        <span className="sp" />
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="btn btn-quiet" aria-haspopup="menu" aria-expanded={menu} disabled={item.running} onClick={() => setMenu(!menu)}>More <DownIcon /></button>
          {menu ? (
            <div className="menu up" role="menu">
              {more.filter((row) => row.shown && row.kind !== primary).map((row) => (
                <button key={row.kind} type="button" role="menuitem" disabled={!row.enabled} onClick={() => void run(row.kind)}>{row.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default function Inbox() {
  const params = useParams();
  const navigate = useNavigate();
  const { snapshot } = usePortal();
  const items = useQueueItems();
  const loading = useQueueLoading();
  const { denied } = useRunLogs();
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<InboxGrouping>("action");
  const [showWaiting, setShowWaiting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => groupInbox(items.filter((item) => matchesQuery(item, query))), [items, query]);
  const piles = useMemo(() => regroupInbox(view, grouping), [view, grouping]);
  const flat = useMemo(() => piles.flatMap((pile) => pile.items), [piles]);
  const routed = params.number === undefined ? undefined : findPrItem(items, params);
  const selected = routed ?? (params.number === undefined ? flat[0] : undefined);
  const connectedRepos = snapshot?.repos.filter((repo) => repo.connected) ?? [];

  useEffect(function shortcuts() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isInteractiveShortcutTarget(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Enter") {
        paneRef.current?.focus();
        return;
      }
      const digit = INBOX_GROUPINGS[Number(event.key) - 1];
      if (digit !== undefined && /^[1-3]$/.test(event.key)) {
        setGrouping(digit);
        return;
      }
      if (event.key !== "j" && event.key !== "k" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = flat.findIndex((item) => item.key === selected?.key);
      const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" || event.key === "ArrowDown" ? 1 : -1)))];
      if (next && next.key !== selected?.key) navigate(inboxHref(next));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flat, navigate, selected]);

  useEffect(function keepSelectionVisible() {
    if (!selected) return;
    document.querySelector(`[data-inbox-row="${CSS.escape(selected.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const empty = loading ? null
    : denied ? <DeniedNotice section="logs" />
    : connectedRepos.length === 0 && items.length === 0 ? (
      <div className="zero"><h2>No repositories yet</h2><p>Choose the repositories Triage should read.</p><Link className="btn btn-sm" to="/repositories">Choose repositories on GitHub</Link></div>
    ) : query.trim() ? (
      <div className="zero"><h2 style={{ fontSize: 20 }}>Nothing here</h2><p>No pull requests match.</p><button type="button" className="btn btn-sm" onClick={() => setQuery("")}>Clear search</button></div>
    ) : (
      <div className="zero"><div className="glyph"><CheckIcon /></div><h2>Inbox zero</h2><p>Nothing needs you.{view.waiting.length > 0 ? ` ${view.waiting.length} pull requests are waiting on authors or triage.` : ""}</p></div>
    );

  return (
    <div className={`inbox${selected ? " has-selection" : ""}`} ref={paneRef} tabIndex={-1}>
      <section className="panel list" aria-label="Pull requests">
        <div className="lh">
          <div className="lh-top"><h1>Inbox</h1><span className="n">{flat.length}</span></div>
          <div className="tools">
            <label className="search">
              <SearchIcon />
              <input ref={searchRef} placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pull requests" autoComplete="off" />
              <kbd>/</kbd>
            </label>
            <div className="seg" role="group" aria-label="Group by">
              {INBOX_GROUPINGS.map((mode) => (
                <button key={mode} type="button" aria-pressed={grouping === mode} onClick={() => setGrouping(mode)}>{GROUPING_LABEL[mode]}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="scroll" id="main">
          {flat.length === 0 ? empty : (
            <div className="groups">
              {piles.map((pile) => <Pile key={pile.key} pile={pile} selectedKey={selected?.key} />)}
            </div>
          )}
          {view.waiting.length > 0 && !loading ? (
            <>
              <div className="fold">
                <span>{view.waiting.length} waiting on authors or triage</span>
                <button type="button" className="linkish" onClick={() => setShowWaiting(!showWaiting)}>{showWaiting ? "Hide" : "Show"}</button>
              </div>
              {showWaiting ? (
                <div className="fold-list">
                  {view.waiting.map((item) => (
                    <Link key={item.key} className="row" to={inboxHref(item)} aria-selected={item.key === selected?.key}>
                      <span className={dotClass(item, null)} />
                      <span className="tw"><b>{item.title ?? item.key}</b><span className="why">{inboxStatus(item)}</span></span>
                      <span className="age">{ageText(item.waitingSince)}</span>
                    </Link>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="list-foot"><span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>a</kbd> do suggested</span><span><kbd>/</kbd> search</span></footer>
      </section>
      {selected ? <Pane key={selected.key} item={selected} onBack={() => navigate("/inbox")} /> : (
        <section className="panel pane" aria-label="Selected pull request">
          {loading ? null : <div className="pane-empty">Select a pull request.</div>}
        </section>
      )}
    </div>
  );
}
