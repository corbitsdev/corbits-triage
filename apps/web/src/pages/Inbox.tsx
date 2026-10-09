import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { CheckResult, GithubPullDetail, PrItem } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import { errorText } from "../lib/error-text.ts";
import { HOLD_MS, type Notices } from "../lib/held-actions.ts";
import { useHeldInbox } from "../lib/held-inbox.tsx";
import {
  COMPOSER_COPY,
  canRun,
  ciStatus,
  draftText,
  hasNumber,
  isComposerKind,
  needsConfirm,
  openComposer,
  paneActions,
  paneFacts,
  paneWrite,
  primaryButtonLabel,
  replyDraft,
  titleText,
  triageStartedText,
  verdictHeadline,
  type Composer,
  type NumberedItem,
  type PaneDraft,
  type PaneKind,
  type PaneWrite,
  type ReplyDraft,
  type WriteKind,
} from "../lib/inbox-pane.ts";
import {
  INBOX_GROUPINGS,
  UNASSIGNED,
  ageText,
  awaitingText,
  groupInbox,
  hasDraftComment,
  inboxAction,
  inboxHref,
  inboxStatus,
  initialsOf,
  isPostedToAuthor,
  matchesQuery,
  primaryAction,
  regroupInbox,
  rowActionLabel,
  rowWhy,
  type InboxAction,
  type InboxGrouping,
  type InboxPile,
} from "../lib/inbox-view.ts";
import { NO_FILTERS, activeFilters, filtersFromParams, filtersToParams, matchesFilters, type InboxFilters } from "../lib/inbox-filter.ts";
import { useQueueItems, useQueueLoading } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { triageReadyRepos } from "../lib/repo-rows.ts";
import { useRunLogs } from "../lib/run-logs.ts";
import { findPrItem, prHref } from "../lib/triage-view.ts";
import { FilterMenu, FilterPills } from "../components/InboxFilter.tsx";
import { CheckIcon, ChevronIcon, DownIcon, ExternalIcon, SearchIcon } from "../components/inbox-icons.tsx";

const POSTED = "Posted";

const GROUPING_LABEL: Record<InboxGrouping, string> = { action: "Action", repo: "Repo", owner: "Owner" };

function actionDot(action: InboxAction | null): string {
  if (action === "merge") return "dot ready";
  if (action === "unblock") return "dot blocked";
  return "dot";
}

function dotClass(item: PrItem, action: InboxAction | null): string {
  return item.running ? `${actionDot(action)} live` : actionDot(action);
}

function filesText(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function Row({ item, selected, search }: { item: PrItem; selected: boolean; search: string }) {
  const action = inboxAction(item);
  const primary = primaryAction(item, action);
  const why = rowWhy(item);
  return (
    <Link className="row" role="option" aria-selected={selected} to={{ pathname: inboxHref(item), search }} data-inbox-row={item.key}>
      <span className={dotClass(item, action)} />
      <span className="tw"><b>{titleText(item.title)}</b>{why === null ? null : <span className="why">{why}</span>}</span>
      <span className="age">{ageText(item.waitingSince)}</span>
      {primary === null ? null : <span className="act">{rowActionLabel(primary)}</span>}
      {isPostedToAuthor(item) ? <span className="act done">{POSTED}</span> : null}
    </Link>
  );
}

function Pile({ pile, selectedKey, search }: { pile: InboxPile; selectedKey: string | undefined; search: string }) {
  return (
    <>
      <div className="gh">{pile.label}<span className="n">{pile.items.length}</span></div>
      {pile.items.map((item) => <Row key={item.key} item={item} selected={item.key === selectedKey} search={search} />)}
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
  editing: boolean;
  canPost: boolean;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onPost: () => void;
  onEdit: () => void;
  onCancel: () => void;
};

function SuggestedReply({ item, draft, editing, canPost, replyRef, onChange, onKeyDown, onPost, onEdit, onCancel }: SuggestedReplyProps) {
  return (
    <>
      <h3 className="lbl-h">
        Suggested reply
        <span className="sp" />
      </h3>
      {editing ? (
        <div className="compose">
          <textarea ref={replyRef} value={draft.text} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} aria-label="Suggested reply" />
          <div className="foot">
            <span className="hint"><kbd>⌘</kbd><kbd>⏎</kbd> send</span>
            {draft.edited ? <span className="tag" style={{ margin: 0 }}>Edited</span> : null}
            <span className="sp" />
            {item.labels.length > 0 ? <span>Labels {item.labels.map((label) => <span key={label} className="lbl">{label}</span>)}</span> : null}
            <button type="button" className="btn btn-quiet btn-sm" disabled={!canPost} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="suggest">
          <p className="suggest-text">{draft.text}</p>
          <div className="suggest-actions">
            <button type="button" className="btn btn-sm" disabled={!canPost} onClick={onPost}>Post the suggestion</button>
            <button type="button" className="btn btn-quiet btn-sm" disabled={!canPost} onClick={onEdit}>Edit the suggestion</button>
          </div>
        </div>
      )}
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

/** Shortcuts stay out of the way while a modal dialog, such as the filter popover, asks something. */
function modalOpen(): boolean {
  return document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null;
}

function ConfirmDuplicate({ item, onCancel, onConfirm }: { item: NumberedItem; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(function openAsModal() {
    dialogRef.current?.showModal();
    confirmRef.current?.focus();
  }, []);

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="confirm-duplicate" onClose={onCancel}>
      <h2 id="confirm-duplicate">Close #{item.number} as a duplicate?</h2>
      <p>
        Triage {hasDraftComment(item.comment) ? "posts the suggested reply, " : null}
        {item.labels.length > 0 ? <>adds {item.labels.map((label) => <span key={label} className="lbl">{label}</span>)} and </> : null}
        closes it on GitHub. You can reopen it there.
      </p>
      <div className="acts">
        <button type="button" className="btn btn-quiet" onClick={() => dialogRef.current?.close()}>Cancel</button>
        <button ref={confirmRef} type="button" className="btn btn-primary" onClick={onConfirm}>Close as duplicate <kbd aria-hidden="true">⏎</kbd></button>
      </div>
    </dialog>
  );
}

type PaneProps = {
  item: PrItem;
  restored: PaneDraft | null;
  sectionRef: RefObject<HTMLElement | null>;
  onHold: (item: NumberedItem, write: PaneWrite, draft: PaneDraft) => void;
  onBack: () => void;
};

function Pane({ item, restored, sectionRef, onHold, onBack }: PaneProps) {
  const { snapshot, triagePullRequest, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const [reply, setReply] = useState(restored === null ? draftText(item) : restored.reply);
  const [editing, setEditing] = useState(restored !== null && restored.reply !== draftText(item));
  const [composer, setComposer] = useState<Composer | null>(restored === null ? null : restored.composer);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const verdict = useRef({ runId: item.runId, comment: item.comment });
  const facts = paneFacts(item, pull.data);
  const gate = { item, facts, readOnly, busy };
  const { primary, more } = paneActions(gate);
  const draft = replyDraft(item, reply);
  const canPost = draft !== null && canRun("reply", gate);
  const github = hasNumber(item) ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  const floor = snapshot?.config?.confidenceFloor;
  const detailFiles = pull.data === undefined ? "" : ` · ${filesText(pull.data.pr.changedFiles)}`;

  // A new verdict replaces the suggested reply and the last note; composer text and an edit made while a run is merely in flight stay.
  useEffect(function restartReplyOnNewVerdict() {
    if (verdict.current.runId === item.runId && verdict.current.comment === item.comment) return;
    verdict.current = { runId: item.runId, comment: item.comment };
    setReply(draftText(item));
    setEditing(false);
    setDone(null);
  }, [item.runId, item.comment]);

  useEffect(function closeMenuOnOutsideClick() {
    if (!menu) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  useEffect(function focusReplyWhenEditing() {
    if (editing && replyRef.current) replyRef.current.focus();
  }, [editing]);

  function hold(kind: WriteKind, body: string) {
    if (!hasNumber(item)) return;
    let write: PaneWrite;
    try {
      write = paneWrite(kind, item, body);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    onHold(item, write, { reply, composer });
  }

  async function startTriage(pr: NumberedItem) {
    setBusy(true);
    try {
      setError(null);
      await triagePullRequest(pr.repo, pr.number);
      setDone(triageStartedText(pr.number));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function run(kind: PaneKind) {
    if (!hasNumber(item) || !canRun(kind, gate)) return;
    setMenu(false);
    if (isComposerKind(kind)) {
      setComposer(openComposer(composer, kind));
      return;
    }
    if (kind === "triage") {
      void startTriage(item);
      return;
    }
    if (needsConfirm(kind, item)) {
      setConfirming(true);
      return;
    }
    hold(kind, reply);
  }

  function onComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composer !== null && canRun(composer.kind, gate)) hold(composer.kind, composer.body);
  }

  function onReplyKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && draft !== null) run("reply");
  }

  useEffect(function paneShortcuts() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || modalOpen() || isInteractiveShortcutTarget(event.target)) return;
      if (event.key === "a" && primary !== null) {
        event.preventDefault();
        run(primary.kind);
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
    <section ref={sectionRef} className="panel pane" aria-label="Selected pull request" tabIndex={-1}>
      <button type="button" className="btn btn-quiet btn-sm pane-back" onClick={onBack}>Back to inbox</button>
      <div className="bar">
        {primary === null ? null : (
          <button type="button" className="btn btn-primary" disabled={primary.blocker !== null} onClick={() => run(primary.kind)}>
            {primaryButtonLabel(primary, draft)} <kbd>a</kbd>
          </button>
        )}
        <span className="sp" />
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="btn btn-quiet" aria-haspopup="menu" aria-expanded={menu} disabled={item.running} onClick={() => setMenu(!menu)}>More <DownIcon /></button>
          {menu ? (
            <div className="menu up" role="menu">
              {more.map((entry) => (
                <button key={entry.label} type="button" role="menuitem" disabled={entry.blocker !== null} onClick={() => run(entry.kind)}>{entry.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="scroll">
        <div className="pane-in">
          <header className="ph">
            <div className="crumb">
              <Link className="mono repo-link" to={`/repositories/${item.repo}`} title="Repository settings">{item.repo}</Link>
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
              {isPostedToAuthor(item) ? <span>{POSTED}</span> : null}
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
          {draft === null ? null : (
            <SuggestedReply
              item={item}
              draft={draft}
              editing={editing}
              canPost={canPost}
              replyRef={replyRef}
              onChange={setReply}
              onKeyDown={onReplyKey}
              onPost={() => run("reply")}
              onEdit={() => setEditing(true)}
              onCancel={() => setEditing(false)}
            />
          )}
          {composer === null ? null : (
            <ComposerForm composer={composer} busy={busy} readOnly={readOnly} onChange={setComposer} onCancel={() => setComposer(null)} onSubmit={onComposerSubmit} />
          )}
          {confirming && hasNumber(item) ? <ConfirmDuplicate item={item} onCancel={() => setConfirming(false)} onConfirm={() => hold("close", reply)} /> : null}
          {error === null ? null : <p role="alert" className="error">{error}</p>}
          {done === null ? null : <p role="status" className="note">{done}</p>}
        </div>
      </div>
    </section>
  );
}

type EmptyListProps = { loading: boolean; denied: boolean; noRepos: boolean; filtered: boolean; onClear: () => void };

function EmptyList({ loading, denied, noRepos, filtered, onClear }: EmptyListProps) {
  if (loading) return null;
  if (denied) return <DeniedNotice section="logs" />;
  if (noRepos) {
    return <div className="zero"><h2>No repositories yet</h2><p>Choose the repositories Triage should read.</p><Link className="btn btn-sm" to="/repositories">Choose repositories on GitHub</Link></div>;
  }
  if (filtered) {
    return <div className="zero"><h2 style={{ fontSize: 20 }}>Nothing here</h2><p>No pull requests match these filters.</p><button type="button" className="btn btn-sm" onClick={onClear}>Clear filters</button></div>;
  }
  return <div className="zero"><div className="glyph"><CheckIcon /></div><h2>Inbox zero</h2><p>Nothing needs you.</p></div>;
}

function Outcome({ outcome }: { outcome: Notices["outcome"] }) {
  if (outcome === null) return null;
  if (outcome.result === "sent") return <span key={outcome.id} className="sr-only">{outcome.message}</span>;
  return <div key={outcome.id} className="toast note">{outcome.message}</div>;
}

/** One polite live region: the held action with its Undo, then what really happened once it was sent. */
function Toasts({ notices, onUndo }: { notices: Notices; onUndo: () => void }) {
  const { held, outcome } = notices;
  return (
    <div className="toasts" role="status" aria-live="polite">
      <Outcome outcome={outcome} />
      {held === null ? null : (
        <div key={held.id} className="toast">
          <span>{held.message}</span>
          <button type="button" aria-keyshortcuts="u" onClick={onUndo}>Undo <kbd aria-hidden="true">u</kbd></button>
          <span className="drain" aria-hidden="true"><i style={{ animationDuration: `${HOLD_MS}ms` }} /></span>
        </div>
      )}
    </div>
  );
}

export default function Inbox() {
  const params = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { snapshot } = usePortal();
  const held = useHeldInbox();
  const focusOnArrival = useRef<string | null | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  const items = useQueueItems();
  const loading = useQueueLoading();
  const { denied } = useRunLogs();
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<InboxGrouping>("action");
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const ready = useMemo(() => triageReadyRepos(snapshot?.repos ?? []), [snapshot]);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const searched = useMemo(() => items.filter((item) => matchesQuery(item, query)), [items, query]);
  const rows = useMemo(() => searched.filter((item) => inboxAction(item) !== null), [searched]);
  const now = useMemo(() => Date.now(), [searched, filters]);
  const view = useMemo(() => groupInbox(searched.filter((item) => matchesFilters(item, filters, now)), ready), [searched, filters, now, ready]);
  const piles = useMemo(() => regroupInbox(view, grouping), [view, grouping]);
  const flat = useMemo(() => piles.flatMap((pile) => pile.items), [piles]);
  const selected = params.number === undefined ? flat[0] : findPrItem(items, params);
  const hasConnectedRepo = snapshot !== null && snapshot.repos.some((repo) => repo.connected);

  function setFilters(next: InboxFilters) {
    setSearchParams(filtersToParams(next, searchParams), { replace: true });
  }

  function clearFilters() {
    setQuery("");
    setFilters(NO_FILTERS);
  }

  useEffect(function shortcuts() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || modalOpen() || isInteractiveShortcutTarget(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Enter") {
        paneRef.current?.focus();
        return;
      }
      if (event.key === "u") {
        if (!event.repeat && held.undo()) event.preventDefault();
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
      if (next && next.key !== selected?.key) navigate({ pathname: inboxHref(next), search });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flat, held.undo, navigate, selected, search]);

  useEffect(function sendHeldWhenLeaving() {
    return held.enter();
  }, [held.enter]);

  useEffect(function focusAfterAutoAdvance() {
    const target = focusOnArrival.current;
    if (target === undefined || target !== (selected?.key ?? null)) return;
    focusOnArrival.current = undefined;
    (selected ? sectionRef.current : paneRef.current)?.focus();
  }, [selected]);

  /** Focus follows the selection once it lands, so the keyboard stays in the pane after an action or Undo. */
  function moveTo(item: PrItem | undefined) {
    focusOnArrival.current = item === undefined ? null : item.key;
    navigate({ pathname: item === undefined ? "/inbox" : inboxHref(item), search });
  }

  function holdAction(item: NumberedItem, write: PaneWrite, draft: PaneDraft) {
    const index = flat.findIndex((row) => row.key === item.key);
    const next = flat[index + 1] ?? flat[index - 1];
    moveTo(next);
    held.hold(item, write, draft, function backToItem() {
      moveTo(item);
    });
  }

  const restoredDraft = selected === undefined ? undefined : held.restored[selected.key];
  const paneDraft = restoredDraft !== undefined && restoredDraft.runId === selected?.runId ? restoredDraft.draft : null;

  useEffect(function forgetRestoredOnceShown() {
    if (selected !== undefined && Object.hasOwn(held.restored, selected.key)) held.forgetRestored(selected.key);
  }, [held.forgetRestored, held.restored, selected]);

  useEffect(function keepSelectionVisible() {
    if (!selected) return;
    document.querySelector(`[data-inbox-row="${CSS.escape(selected.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className={`inbox${selected ? " has-selection" : ""}`} ref={paneRef} tabIndex={-1}>
      <section className="panel list" aria-label="Pull requests">
        <div className="lh">
          <div className="lh-top"><h1>Inbox</h1><span className="n">{flat.length}</span>{view.awaiting > 0 ? <span className="awaiting">{awaitingText(view.awaiting)}</span> : null}</div>
          <div className="tools">
            <label className="search">
              <SearchIcon />
              <input ref={searchRef} placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pull requests" autoComplete="off" />
              <kbd>/</kbd>
            </label>
            <FilterMenu items={rows} now={now} filters={filters} onChange={setFilters} triggerRef={filterRef} />
            <div className="seg" role="group" aria-label="Group by">
              {INBOX_GROUPINGS.map((mode) => (
                <button key={mode} type="button" aria-pressed={grouping === mode} onClick={() => setGrouping(mode)}>{GROUPING_LABEL[mode]}</button>
              ))}
            </div>
          </div>
          <FilterPills filters={filters} onChange={setFilters} triggerRef={filterRef} />
        </div>
        <div className="scroll" id="main">
          {flat.length === 0 ? (
            <EmptyList loading={loading} denied={denied} noRepos={!hasConnectedRepo && items.length === 0} filtered={query.trim() !== "" || activeFilters(filters).length > 0} onClear={clearFilters} />
          ) : (
            <div className="groups">
              {piles.map((pile) => <Pile key={pile.key} pile={pile} selectedKey={selected?.key} search={search} />)}
            </div>
          )}
        </div>
        <footer className="list-foot"><span><kbd>j</kbd> <kbd>k</kbd> move</span><span><kbd>a</kbd> do suggested</span><span><kbd>/</kbd> search</span></footer>
      </section>
      {selected ? (
        <Pane
          key={selected.key}
          item={selected}
          restored={paneDraft}
          sectionRef={sectionRef}
          onHold={holdAction}
          onBack={() => navigate({ pathname: "/inbox", search })}
        />
      ) : (
        <section className="panel pane" aria-label="Selected pull request">
          {loading ? null : <div className="pane-empty">Select a pull request.</div>}
        </section>
      )}
      <Toasts notices={held.notices} onUndo={() => held.undo()} />
    </div>
  );
}
