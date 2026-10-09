import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CheckResult, GithubPullDetail, PrItem } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import {
  COMPOSER_COPY,
  canRun,
  ciStatus,
  hasNumber,
  isComposerKind,
  openComposer,
  paneActions,
  paneFacts,
  primaryButtonLabel,
  replyDraft,
  runPaneAction,
  titleText,
  verdictHeadline,
  type Composer,
  type MenuEntry,
  type ReplyDraft,
} from "../lib/inbox-pane.ts";
import {
  INBOX_GROUPINGS,
  UNASSIGNED,
  ageText,
  groupInbox,
  inboxAction,
  inboxHref,
  inboxStatus,
  initialsOf,
  matchesQuery,
  primaryAction,
  regroupInbox,
  rowActionLabel,
  rowWhy,
  type InboxAction,
  type InboxGrouping,
  type InboxPile,
  type InboxView,
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

function filesText(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function Row({ item, selected }: { item: PrItem; selected: boolean }) {
  const action = inboxAction(item);
  const why = rowWhy(item);
  return (
    <Link className="row" role="option" aria-selected={selected} to={inboxHref(item)} data-inbox-row={item.key}>
      <span className={dotClass(item, action)} />
      <span className="tw"><b>{titleText(item.title)}</b>{why === null ? null : <span className="why">{why}</span>}</span>
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

function Byline({ item, author, detail }: { item: PrItem; author: string | null; detail: GithubPullDetail | undefined }) {
  const ci = ciStatus(detail);
  return (
    <div className="byline">
      {author === null ? null : <span className="who"><span className="av">{initialsOf(author)}</span><span className="nm">{author}</span></span>}
      <span>opened {ageText(item.waitingSince)} ago</span>
      {detail === undefined ? null : <span><span className="mono">+{detail.pr.additions} −{detail.pr.deletions}</span></span>}
      {detail === undefined ? null : <span>{filesText(detail.pr.changedFiles)}</span>}
      {ci === null ? null : <span className="ci"><span className={ci === "passing" ? "dot ready" : "dot hollow"} />CI {ci}</span>}
    </div>
  );
}

function Owner({ owner }: { owner: string | null }) {
  const avatarClass = owner === null ? "av none" : "av";
  const initials = owner === null ? null : initialsOf(owner);
  const name = owner === null ? UNASSIGNED : owner;
  const source = owner === null ? "" : " from the verdict";
  return (
    <div className="route">
      <span className={avatarClass}>{initials}</span>
      <div className="route-t"><div className="l1"><b>{name}</b>{source}</div></div>
    </div>
  );
}

function Certainty({ confidence, floor }: { confidence: number | null; floor: number | undefined }) {
  if (confidence === null) return null;
  const sure = <b className="mono">{Math.round(confidence * 100)}%</b>;
  if (floor !== undefined && confidence < floor) return <span>{sure} sure, under your {Math.round(floor * 100)}% bar</span>;
  return <span>{sure} sure</span>;
}

const CHECK_MARK: Record<CheckResult["result"], { className: string; glyph: string }> = {
  pass: { className: "mk ok", glyph: "✓" },
  fail: { className: "mk flag", glyph: "!" },
  unconfirmed: { className: "mk judge", glyph: "?" },
};

function CheckRow({ check }: { check: CheckResult }) {
  const mark = CHECK_MARK[check.result];
  return (
    <li>
      <span className={mark.className}>{mark.glyph}</span>
      <span>{check.reason || check.check}<small>{check.kind === "model" ? "Decision model" : check.check}</small></span>
    </li>
  );
}

function Reasons({ item }: { item: PrItem }) {
  if (item.checks.length > 0) {
    return <ul className="why">{item.checks.map((check) => <CheckRow key={check.check} check={check} />)}</ul>;
  }
  if (item.evidence.length === 0) return null;
  return <ul className="why">{item.evidence.map((reason) => <li key={reason}><span className="mk judge">?</span><span>{reason}</span></li>)}</ul>;
}

type SuggestedReplyProps = {
  item: PrItem;
  draft: ReplyDraft;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
};

function SuggestedReply({ item, draft, replyRef, onChange, onKeyDown }: SuggestedReplyProps) {
  return (
    <>
      <h3 className="lbl-h">
        Suggested reply
        {draft.edited ? <span className="tag" style={{ margin: 0 }}>Edited</span> : null}
        <span className="sp" />
        <span className="hint"><kbd>e</kbd> edit · <kbd>⌘</kbd><kbd>⏎</kbd> send</span>
      </h3>
      <div className="compose">
        <textarea ref={replyRef} value={draft.text} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} aria-label="Suggested reply" />
        {item.labels.length > 0 ? <div className="foot">Labels {item.labels.map((label) => <span key={label} className="lbl">{label}</span>)}</div> : null}
      </div>
    </>
  );
}

type ComposerFormProps = {
  composer: Composer;
  busy: boolean;
  readOnly: boolean;
  onChange: (composer: Composer) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function ComposerForm({ composer, busy, readOnly, onChange, onCancel, onSubmit }: ComposerFormProps) {
  const copy = COMPOSER_COPY[composer.kind];
  return (
    <form className="compose composer" onSubmit={onSubmit}>
      <textarea
        value={composer.body}
        onChange={(event) => onChange({ ...composer, body: event.target.value })}
        placeholder={copy.placeholder}
        aria-label={copy.label}
      />
      <div className="foot">
        <button type="submit" className="btn btn-sm" disabled={busy || readOnly}>{copy.submit}</button>
        <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Pane({ item, onBack }: { item: PrItem; onBack: () => void }) {
  const { snapshot, writeGithub, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const [reply, setReply] = useState(item.comment === null ? "" : item.comment);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const facts = paneFacts(item, pull.data);
  const gate = { item, facts, readOnly, busy };
  const { primary, more } = paneActions(gate);
  const draft = replyDraft(item, reply);
  const github = hasNumber(item) ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  const floor = snapshot?.config?.confidenceFloor;
  const detailFiles = pull.data === undefined ? "" : ` · ${filesText(pull.data.pr.changedFiles)}`;

  useEffect(function closeMenuOnOutsideClick() {
    if (!menu) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  async function run(kind: PrimaryAction) {
    if (!hasNumber(item) || !canRun(kind, gate)) return;
    setMenu(false);
    if (isComposerKind(kind)) {
      setComposer(openComposer(composer, kind));
      return;
    }
    setBusy(true);
    try {
      setError(null);
      setDone(await runPaneAction(kind, item, draft, writeGithub));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function onComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasNumber(item) || composer === null || !canRun(composer.kind, gate)) return;
    if (!composer.body.trim()) {
      setError("The comment must not be empty.");
      return;
    }
    const { repo, number } = item;
    setBusy(true);
    try {
      setError(null);
      if (composer.kind === "comment") {
        await writeGithub({ action: "comment", repo, number, body: composer.body });
      } else {
        await writeGithub({ action: "review", repo, number, event: "REQUEST_CHANGES", body: composer.body });
      }
      setComposer(null);
      setDone(`Posted to GitHub on #${number}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function runFromMenu(entry: MenuEntry) {
    if (entry.confirm === null || window.confirm(entry.confirm)) void run(entry.kind);
  }

  function onReplyKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && primary?.kind === "reply") void run("reply");
  }

  useEffect(function paneShortcuts() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isInteractiveShortcutTarget(event.target)) return;
      if (event.key === "a" && primary !== null) {
        event.preventDefault();
        void run(primary.kind);
      }
      if (event.key === "e" && replyRef.current) {
        event.preventDefault();
        replyRef.current.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
              {github === null ? null : <a className="btn btn-quiet btn-sm" href={github} target="_blank" rel="noreferrer">GitHub <ExternalIcon /></a>}
            </div>
            <h2 className="title">{titleText(facts.title)}</h2>
            <Byline item={item} author={facts.author} detail={pull.data} />
          </header>
          <Owner owner={item.owner} />
          <section className="verdict">
            <p className="vh">{verdictHeadline(item)}</p>
            <div className="vm">
              <span><span className="st"><span className={dotClass(item, inboxAction(item))} />{inboxStatus(item)}</span></span>
              {item.priority === null ? null : <span><b>{item.priority}</b></span>}
              <Certainty confidence={item.confidence} floor={floor} />
            </div>
          </section>
          <Reasons item={item} />
          <Link className="disclose" to={prHref(item)}>
            <ChevronIcon />
            Show details
            <span>{item.checks.length} checks{detailFiles} · commits · conversation</span>
          </Link>
          {draft === null ? null : <SuggestedReply item={item} draft={draft} replyRef={replyRef} onChange={setReply} onKeyDown={onReplyKey} />}
          {composer === null ? null : (
            <ComposerForm composer={composer} busy={busy} readOnly={readOnly} onChange={setComposer} onCancel={() => setComposer(null)} onSubmit={onComposerSubmit} />
          )}
          {error === null ? null : <p role="alert" className="error">{error}</p>}
          {done === null ? null : <p role="status" className="note">{done}</p>}
        </div>
      </div>
      <div className="bar">
        {primary === null ? null : (
          <button type="button" className="btn btn-primary" disabled={primary.blocker !== null} onClick={() => void run(primary.kind)}>
            {primaryButtonLabel(primary, draft)} <kbd>a</kbd>
          </button>
        )}
        <span className="sp" />
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="btn btn-quiet" aria-haspopup="menu" aria-expanded={menu} disabled={item.running} onClick={() => setMenu(!menu)}>More <DownIcon /></button>
          {menu ? (
            <div className="menu up" role="menu">
              {more.map((entry) => (
                <button key={entry.label} type="button" role="menuitem" disabled={entry.blocker !== null} onClick={() => runFromMenu(entry)}>{entry.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type EmptyListProps = { loading: boolean; denied: boolean; noRepos: boolean; query: string; view: InboxView; onClear: () => void };

function EmptyList({ loading, denied, noRepos, query, view, onClear }: EmptyListProps) {
  if (loading) return null;
  if (denied) return <DeniedNotice section="logs" />;
  if (noRepos) {
    return <div className="zero"><h2>No repositories yet</h2><p>Choose the repositories Triage should read.</p><Link className="btn btn-sm" to="/repositories">Choose repositories on GitHub</Link></div>;
  }
  if (query.trim()) {
    return <div className="zero"><h2 style={{ fontSize: 20 }}>Nothing here</h2><p>No pull requests match.</p><button type="button" className="btn btn-sm" onClick={onClear}>Clear search</button></div>;
  }
  const waiting = view.waiting.length > 0 ? ` ${view.waiting.length} pull requests are waiting on authors or triage.` : "";
  return <div className="zero"><div className="glyph"><CheckIcon /></div><h2>Inbox zero</h2><p>Nothing needs you.{waiting}</p></div>;
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
  const selected = params.number === undefined ? flat[0] : findPrItem(items, params);
  const hasConnectedRepo = snapshot !== null && snapshot.repos.some((repo) => repo.connected);
  const showFold = view.waiting.length > 0 && !loading;

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
          {flat.length === 0 ? (
            <EmptyList loading={loading} denied={denied} noRepos={!hasConnectedRepo && items.length === 0} query={query} view={view} onClear={() => setQuery("")} />
          ) : (
            <div className="groups">
              {piles.map((pile) => <Pile key={pile.key} pile={pile} selectedKey={selected?.key} />)}
            </div>
          )}
          {showFold ? (
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
                      <span className="tw"><b>{titleText(item.title)}</b><span className="why">{inboxStatus(item)}</span></span>
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
