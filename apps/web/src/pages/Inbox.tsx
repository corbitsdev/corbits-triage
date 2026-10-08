import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, EmptyState, ListDetail } from "@corbits/react-ui";
import { Search } from "lucide-react";
import type { PrItem } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import {
  INBOX_STATUS_LABEL,
  confidenceText,
  groupInbox,
  inboxAction,
  inboxHref,
  matchesQuery,
  primaryAction,
  primaryLabel,
  rowActionLabel,
  type InboxAction,
  type InboxGroup,
  type PrimaryAction,
} from "../lib/inbox-view.ts";
import { useQueueItems, useQueueLoading } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { useRunLogs } from "../lib/run-logs.ts";
import { findPrItem, prHref, relativeTime } from "../lib/triage-view.ts";

function Row({ item, action, selected }: { item: PrItem; action: InboxAction; selected: boolean }) {
  return (
    <Link
      className={`inbox-row${selected ? " is-selected" : ""}`}
      to={inboxHref(item)}
      aria-current={selected ? "true" : undefined}
      data-inbox-row={item.key}
    >
      <span className={`inbox-dot ${action}`} aria-hidden="true" />
      <span className="inbox-row-main">
        <b>{item.title ?? item.key}</b>
        {item.evidence[0] ? <span className="inbox-row-why">{item.evidence[0]}</span> : null}
      </span>
      <span className="inbox-row-age mono">{relativeTime(item.waitingSince)}</span>
      <span className="inbox-row-act">{rowActionLabel(primaryAction(item, action))}</span>
    </Link>
  );
}

function Group({ group, selectedKey }: { group: InboxGroup; selectedKey: string | undefined }) {
  return (
    <section className="inbox-group" aria-label={group.label}>
      <header className="inbox-group-head">
        <span>{group.label}</span>
        <span className="mono">{group.items.length}</span>
      </header>
      {group.items.map((item) => <Row key={item.key} item={item} action={group.action} selected={item.key === selectedKey} />)}
    </section>
  );
}

function WaitingFold({ items }: { items: PrItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section className="inbox-fold" aria-label="Waiting on others">
      <button type="button" className="inbox-fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{items.length} waiting on authors or triage</span>
        <span className="inbox-fold-link">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? items.map((item) => (
        <Link key={item.key} className="inbox-row is-waiting" to={inboxHref(item)}>
          <span className="inbox-dot waiting" aria-hidden="true" />
          <span className="inbox-row-main">
            <b>{item.title ?? item.key}</b>
            <span className="inbox-row-why">{INBOX_STATUS_LABEL[item.state]}</span>
          </span>
          <span className="inbox-row-age mono">{relativeTime(item.waitingSince)}</span>
        </Link>
      )) : null}
    </section>
  );
}

type Composer = { kind: "comment" | "changes"; body: string };

function ReadingPane({ item }: { item: PrItem }) {
  const { snapshot, writeGithub, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const [reply, setReply] = useState(item.comment ?? "");
  const [composer, setComposer] = useState<Composer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const moreRef = useRef<HTMLDetailsElement>(null);
  const action = inboxAction(item);
  const primary = action === null ? null : primaryAction(item, action);
  const pr = pull.data?.pr;
  const github = item.number === null ? null : `https://github.com/${item.repo}/pull/${item.number}`;
  const floor = snapshot?.config?.confidenceFloor;
  const sure = confidenceText(item);
  const canWrite = item.number !== null && !readOnly && !busy;
  const canMerge = canWrite && (pr?.mergeable ?? item.mergeable) === true && (pr?.draft ?? item.draft) !== true;

  async function run(kind: PrimaryAction) {
    if (item.number === null) return;
    moreRef.current?.removeAttribute("open");
    if (kind === "comment" || kind === "changes") {
      setComposer({ kind, body: composer?.kind === kind ? composer.body : "" });
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (kind === "reply") {
        if (!reply.trim()) throw new Error("The reply must not be empty.");
        await writeGithub({ action: "comment", repo: item.repo, number: item.number, body: reply });
        if (item.labels.length > 0) await writeGithub({ action: "labels", repo: item.repo, number: item.number, labels: item.labels });
        setDone("Posted to GitHub.");
      } else if (kind === "approve") {
        await writeGithub({ action: "review", repo: item.repo, number: item.number, event: "APPROVE", body: "" });
        setDone("Approved on GitHub.");
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
    if (item.number === null || !composer) return;
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
      setDone("Posted to GitHub.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function sendReplyOnMetaEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && primary === "reply") void run("reply");
  }

  const actions: Array<{ kind: PrimaryAction; label: string; enabled: boolean }> = [
    { kind: "approve", label: "Approve", enabled: canWrite },
    { kind: "changes", label: "Request changes", enabled: canWrite },
    { kind: "comment", label: "Comment", enabled: canWrite },
    { kind: "merge", label: "Merge", enabled: canMerge },
    { kind: "close", label: "Close as duplicate", enabled: canWrite && item.canClose },
  ];
  const secondary = actions.filter((row) => row.kind !== primary);

  return (
    <article className="pane" aria-label={item.title ?? item.key}>
      <div className="pane-in">
        <p className="pane-crumb">
          <Link className="mono" to={`/repositories/${encodeURIComponent(item.repo)}`}>{item.repo}</Link>
          <span className="mono">{item.number === null ? "" : `#${item.number}`}</span>
          {github ? <a className="pane-crumb-link" href={github} target="_blank" rel="noreferrer">GitHub ↗</a> : null}
        </p>
        <h2 className="pane-title">{pr?.title ?? item.title ?? item.key}</h2>
        <p className="pane-byline">
          {(pr?.author ?? item.author) ? <span>{pr?.author ?? item.author}</span> : null}
          <span>opened {relativeTime(item.waitingSince)}</span>
          {pr ? <span className="mono">+{pr.additions} −{pr.deletions}</span> : null}
          {pr ? <span>{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}</span> : null}
        </p>
        <p className="pane-route">
          <b>{item.owner ?? "Unassigned"}</b>
          {item.owner ? <span> owns this pull request</span> : <span> · no owner from the verdict</span>}
        </p>
        <section className="pane-verdict">
          <p className="pane-verdict-head">{item.nextAction ?? item.evidence[0] ?? INBOX_STATUS_LABEL[item.state]}</p>
          <p className="pane-verdict-meta">
            <span className={`inbox-dot ${action ?? "waiting"}`} aria-hidden="true" />
            <b>{INBOX_STATUS_LABEL[item.state]}</b>
            {item.priority ? <span>{item.priority}</span> : null}
            {sure ? <span><b className="mono">{sure.split(" ")[0]}</b> sure{floor !== undefined && item.confidence !== null && item.confidence < floor ? `, under your ${Math.round(floor * 100)}% bar` : ""}</span> : null}
          </p>
        </section>
        {item.checks.length > 0 || item.evidence.length > 0 ? (
          <ul className="pane-why">
            {item.checks.map((check) => (
              <li key={check.check}>
                <span className={`pane-mark ${check.result}`} aria-hidden="true">{check.result === "pass" ? "✓" : check.result === "fail" ? "!" : "?"}</span>
                <span>
                  {check.reason || check.check}
                  <small>{check.kind === "model" ? "Decision model" : check.check}</small>
                </span>
              </li>
            ))}
            {item.checks.length === 0 ? item.evidence.map((reason) => (
              <li key={reason}><span className="pane-mark unconfirmed" aria-hidden="true">?</span><span>{reason}</span></li>
            )) : null}
          </ul>
        ) : null}
        <Link className="pane-disclose" to={prHref(item)}>
          <b>Show details</b>
          <span>{item.checks.length} checks{pr ? ` · ${pr.changedFiles} files` : ""} · commits · conversation</span>
        </Link>
        {item.comment !== null ? (
          <section className="pane-reply" aria-label="Suggested reply">
            <p className="pane-label">Suggested reply{reply !== item.comment ? <Badge>Edited</Badge> : null}</p>
            <div className="pane-compose">
              <textarea value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={sendReplyOnMetaEnter} rows={4} aria-label="Suggested reply" />
              {item.labels.length > 0 ? (
                <p className="pane-compose-foot">Labels {item.labels.map((label) => <span key={label} className="mono pane-chip">{label}</span>)}</p>
              ) : null}
            </div>
          </section>
        ) : null}
        {composer ? (
          <form className="pane-compose pane-composer" onSubmit={submitComposer}>
            <textarea
              value={composer.body}
              onChange={(event) => setComposer({ ...composer, body: event.target.value })}
              placeholder={composer.kind === "changes" ? "What needs to change" : "Write a comment"}
              rows={3}
              aria-label={composer.kind === "changes" ? "Requested changes" : "Comment"}
            />
            <div className="pane-composer-actions">
              <Button type="submit" size="sm" disabled={busy || readOnly}>{composer.kind === "changes" ? "Request changes" : "Comment"}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setComposer(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}
        {error ? <p role="alert" className="error">{error}</p> : null}
        {done ? <p role="status" className="pane-done">{done}</p> : null}
      </div>
      <div className="pane-bar">
        {primary ? (
          <Button type="button" disabled={primary === "merge" ? !canMerge : !canWrite} onClick={() => void run(primary)}>
            {primary === "reply" && reply !== item.comment ? "Post edited reply" : primaryLabel(primary)}
          </Button>
        ) : null}
        <details className="more-menu" ref={moreRef}>
          <summary className="btn" aria-label="More actions">More</summary>
          <div className="more-menu-list" role="menu">
            {secondary.map((row) => (
              <button key={row.kind} type="button" role="menuitem" disabled={!row.enabled} onClick={() => void run(row.kind)}>{row.label}</button>
            ))}
          </div>
        </details>
      </div>
    </article>
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
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => groupInbox(items.filter((item) => matchesQuery(item, query))), [items, query]);
  const flat = useMemo(() => view.groups.flatMap((group) => group.items), [view]);
  const routed = params.number === undefined ? undefined : findPrItem(items, params);
  const selected = routed ?? (params.number === undefined ? flat[0] : undefined);
  const count = flat.length;
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

  const list = (
    <div className="inbox-list">
      <header className="inbox-head">
        <div className="inbox-head-top">
          <h1>Inbox</h1>
          <span className="mono inbox-count">{count}</span>
        </div>
        <label className="inbox-search">
          <span className="sr-only">Search pull requests</span>
          <Search strokeWidth={1.7} aria-hidden="true" />
          <input ref={searchRef} type="search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          <kbd>/</kbd>
        </label>
      </header>
      <div className="inbox-scroll">
        {denied ? <DeniedNotice section="logs" /> : null}
        {!denied && !loading && connectedRepos.length === 0 && items.length === 0 ? (
          <EmptyState title="No repositories yet" action={<Button asChild size="sm"><Link to="/repositories">Choose repositories on GitHub</Link></Button>} />
        ) : null}
        {!denied && !loading && connectedRepos.length > 0 && count === 0 && view.waiting.length === 0 ? (
          <EmptyState title={query.trim() ? "No pull requests match" : "Nothing needs you"} description={query.trim() ? "Try another search." : "Every open pull request is handled."} />
        ) : null}
        {view.groups.map((group) => <Group key={group.action} group={group} selectedKey={selected?.key} />)}
        <WaitingFold items={view.waiting} />
      </div>
      <footer className="inbox-hints" aria-hidden="true">
        <span><kbd>j</kbd><kbd>k</kbd> move</span>
        <span><kbd>⏎</kbd> open</span>
        <span><kbd>/</kbd> search</span>
      </footer>
    </div>
  );

  return (
    <div className="inbox" ref={paneRef} tabIndex={-1}>
      <ListDetail
        className="inbox-split"
        list={list}
        detail={selected ? <ReadingPane key={selected.key} item={selected} /> : null}
        onCloseDetail={() => navigate("/inbox")}
        detailLabel="Pull request"
        placeholder={loading ? <span /> : <EmptyState title="Nothing selected" description="Pick a pull request from the list." />}
      />
    </div>
  );
}
