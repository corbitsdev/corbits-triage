import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Badge, EmptyState, type BadgeTone } from "@corbits/react-ui";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AuthorKind } from "@corbits/triage-contracts";
import type { GithubPullDetail, PrItem } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import { errorText } from "../lib/error-text.ts";
import { HOLD_MS, type Notices } from "../lib/held-actions.ts";
import { useHeldInbox } from "../lib/held-inbox.tsx";
import type { PendingDo } from "../lib/pending-dos.ts";
import { useDoRuns, useHeldDos, usePendingDos } from "../lib/do-runs.ts";
import { MergeChip } from "../components/MergeChip.tsx";
import { Description, Problems, ReportRows, StatusLine } from "../components/PaneReport.tsx";
import { approvedByTriage, endedText, paneBar, paneProblems, paneStatus, type PaneBar } from "../lib/pane-report.ts";
import {
  COMPOSER_COPY,
  canRun,
  doWrite,
  draftText,
  hasNumber,
  isComposerKind,
  openComposer,
  paneFacts,
  paneWrite,
  replyDraft,
  titleText,
  triageStartedText,
  writeBlocker,
  type Composer,
  type NumberedItem,
  type PaneDraft,
  type PaneKind,
  type PaneWrite,
  type ReplyDraft,
  type WriteKind,
} from "../lib/inbox-pane.ts";
import {
  AUTHOR_KIND_LABEL,
  INBOX_GROUPINGS,
  OPEN_GROUPINGS,
  WAITS_ON_LABEL,
  ageText,
  allOpen,
  awaitingText,
  firstTimers,
  groupInbox,
  groupOpen,
  inboxAction,
  inboxStatus,
  inNeedsYou,
  initialsOf,
  isLoudAuthorKind,
  isPostedToAuthor,
  listHref,
  listRoot,
  matchesQuery,
  postedLabel,
  primaryAction,
  regroupInbox,
  rowActionLabel,
  rowWhy,
  waitsOn,
  type InboxAction,
  type InboxGrouping,
  type HandledMark,
  type InboxPile,
  type ListView,
  type OpenGrouping,
  type OpenItem,
  type OpenPile,
  type WaitsOn,
} from "../lib/inbox-view.ts";
import { NO_FILTERS, activeFilters, filtersFromParams, filtersToParams, matchesFilters, type InboxFilters } from "../lib/inbox-filter.ts";
import { leavesOpen, useOpenItems, useOpenPulls, useOpenPullsUnanswered, useQueueLoading } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { usePulse } from "../lib/pulse-visit.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { triageEnabledRepos, triageReadyRepos } from "../lib/repo-rows.ts";
import { useTriageVerdicts } from "../lib/triage-verdicts.ts";
import { findPrItem } from "../lib/triage-view.ts";
import { useRepoPack } from "../lib/check-packs.ts";
import { FilterMenu, FilterPills } from "../components/InboxFilter.tsx";
import { CheckIcon, DownIcon, ExternalIcon, SearchIcon } from "../components/inbox-icons.tsx";

const POSTED = "Posted";

const GROUPING_LABEL: Record<InboxGrouping | OpenGrouping, string> = { action: "Action", repo: "Repo", waits: "Waits on", owner: "Owner" };

const LIST_TITLE: Record<ListView, string> = { "needs-you": "Needs you", "all-open": "All open", "first-timers": "First-timers" };

const WAITS_ON_TONE: Record<WaitsOn, BadgeTone> = { maintainer: "accent", author: "info", ci: "neutral", nobody: "neutral" };

function actionDot(action: InboxAction | null): string {
  if (action === "merge") return "dot ready";
  if (action === "unblock") return "dot blocked";
  return "dot";
}

function dotClass(item: PrItem, action: InboxAction | null): string {
  return item.running ? `${actionDot(action)} live` : actionDot(action);
}

function AuthorTag({ kind }: { kind: AuthorKind | null }) {
  if (kind === null) return null;
  const label = AUTHOR_KIND_LABEL[kind];
  return <span className={isLoudAuthorKind(kind) ? "tag" : "tag quiet"} title={`Author: ${label}`}><span className="sr-only">Author: </span>{label}</span>;
}

/** Needs you lists what needs the maintainer; the other views list open pull requests with who each waits on. */
function listsOpen(view: ListView): boolean {
  return view !== "needs-you";
}

function viewEntries(view: ListView, open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  switch (view) {
    case "needs-you":
      return open.filter((entry) => entry.handled === null);
    case "all-open":
      return allOpen(open, enabled);
    case "first-timers":
      return firstTimers(open, enabled);
  }
}

type RowProps = { item: PrItem; selected: boolean; search: string };

function Row({ item, selected, search }: RowProps) {
  const action = inboxAction(item);
  const primary = primaryAction(item, action);
  const why = rowWhy(item);
  return (
    <Link className="row" role="option" aria-selected={selected} to={{ pathname: listHref("needs-you", item), search }} data-inbox-row={item.key}>
      <span className={dotClass(item, action)} />
      <span className="tw"><AuthorTag kind={item.authorKind} /><b>{titleText(item.title)}</b>{why === null ? null : <span className="why">{why}</span>}</span>
      <span className="age">{ageText(item.waitingSince)}</span>
      {primary === null ? null : <span className="act">{rowActionLabel(primary)}</span>}
      {isPostedToAuthor(item) ? <span className="act done">{POSTED}</span> : null}
    </Link>
  );
}

function OpenRow({ view, entry, selected, search }: Omit<RowProps, "item"> & { view: ListView; entry: OpenItem }) {
  const { item, handled } = entry;
  const waits = waitsOn(item, handled);
  const posted = postedLabel(item, handled);
  return (
    <Link className="row open-row" role="option" aria-selected={selected} to={{ pathname: listHref(view, item), search }} data-inbox-row={item.key}>
      <span className={dotClass(item, inboxAction(item))} />
      <span className="tw"><AuthorTag kind={item.authorKind} /><b>{titleText(item.title)}</b><span className="why">{rowWhy(item) ?? inboxStatus(item)}</span></span>
      <span className="age">{ageText(item.waitingSince)}</span>
      <MergeChip merge={item.merge} compact className="merge-chip" />
      <Badge tone={WAITS_ON_TONE[waits]}>{WAITS_ON_LABEL[waits]}</Badge>
      {posted === null ? null : <span className="act done">{posted}</span>}
    </Link>
  );
}

function PileRow({ view, entry, selected, search }: Omit<RowProps, "item"> & { view: ListView; entry: OpenItem }) {
  if (listsOpen(view)) return <OpenRow view={view} entry={entry} selected={selected} search={search} />;
  return <Row item={entry.item} selected={selected} search={search} />;
}

function Pile({ view, pile, selectedKey, search }: { view: ListView; pile: OpenPile; selectedKey: string | undefined; search: string }) {
  return (
    <>
      <div className="gh">{pile.label}<span className="n">{pile.items.length}</span></div>
      {pile.items.map((entry) => <PileRow key={entry.item.key} view={view} entry={entry} selected={entry.item.key === selectedKey} search={search} />)}
    </>
  );
}

function Byline({ item, author, detail }: { item: PrItem; author: string | null; detail: GithubPullDetail | undefined }) {
  return (
    <div className="byline">
      {author === null ? null : <span className="who"><span className="av">{initialsOf(author)}</span><span className="nm">{author}</span></span>}
      <AuthorTag kind={item.authorKind} />
      {detail === undefined ? null : <span>opened {ageText(detail.pr.createdAt)} ago</span>}
      {detail === undefined ? null : <span><span className="mono">+{detail.pr.additions} −{detail.pr.deletions}</span></span>}
    </div>
  );
}

type FeedbackEditorProps = {
  item: PrItem;
  draft: ReplyDraft;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCancel: () => void;
};

function FeedbackEditor({ item, draft, replyRef, onChange, onKeyDown, onCancel }: FeedbackEditorProps) {
  return (
    <div className="compose">
      <textarea ref={replyRef} value={draft.text} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} aria-label="Feedback" />
      <div className="foot">
        {draft.edited ? <span className="tag" style={{ margin: 0 }}>Edited</span> : null}
        <span className="sp" />
        {item.labels.length > 0 ? <span>Labels {item.labels.map((label) => <span key={label} className="lbl">{label}</span>)}</span> : null}
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Done</button>
      </div>
    </div>
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

type PaneProps = {
  item: PrItem;
  /** What the maintainer did to it while it is still open; null in Needs you. */
  handled: HandledMark | null;
  listTitle: string;
  restored: PaneDraft | null;
  sectionRef: RefObject<HTMLElement | null>;
  onHold: (item: NumberedItem, write: PaneWrite, draft: PaneDraft) => void;
  onBack: () => void;
};

type BottomBarProps = { bar: PaneBar; draft: ReplyDraft | null; dos: PendingDo[]; doBlocked: boolean; running: boolean; onRun: (kind: PaneKind) => void; onEdit: (() => void) | null; onDo: (pending: PendingDo) => void };

/** One primary for the state, up to two secondaries, the rest in More; on a phone the second secondary moves into More. */
function BottomBar({ bar, draft, dos, doBlocked, running, onRun, onEdit, onDo }: BottomBarProps) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { primary, secondary, more } = bar;
  const narrowOnly = secondary[1];

  useEffect(function closeMenuOnOutsideClick() {
    if (!menu) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  function choose(run: () => void) {
    setMenu(false);
    run();
  }

  return (
    <div className="bar bar3">
      {primary === null ? null : (
        <button type="button" className="btn btn-primary" disabled={primary.blocker !== null} onClick={() => onRun(primary.kind)}>
          {primary.kind === "reply" && draft?.edited ? "Send edited feedback" : primary.label}
          {primary.detail === null ? null : <span className="det">{primary.detail}</span>}
        </button>
      )}
      {secondary.map((entry, index) => <button key={entry.kind} type="button" className={index === 1 ? "btn btn-quiet sec2" : "btn btn-quiet"} onClick={() => onRun(entry.kind)}>{entry.label}</button>)}
      <span className="sp" />
      <div className="menu-wrap" ref={menuRef}>
        <button type="button" className="btn btn-quiet" aria-haspopup="menu" aria-expanded={menu} disabled={running} onClick={() => setMenu(!menu)}>More <DownIcon /></button>
        {menu ? (
          <div className="menu up" role="menu">
            {narrowOnly === undefined ? null : <button type="button" role="menuitem" className="m-only" onClick={() => choose(() => onRun(narrowOnly.kind))}>{narrowOnly.label}</button>}
            {onEdit === null ? null : <button type="button" role="menuitem" onClick={() => choose(onEdit)}>Edit feedback</button>}
            {more.map((entry) => (
              <button key={entry.label} type="button" role="menuitem" disabled={entry.blocker !== null} onClick={() => choose(() => onRun(entry.kind))}>{entry.label}</button>
            ))}
            {dos.map((pending) => (
              <button key={pending.key} type="button" role="menuitem" disabled={doBlocked || pending.running} onClick={() => choose(() => onDo(pending))}>
                {pending.running ? `${pending.label}: already running` : pending.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Pane({ item, handled, listTitle, restored, sectionRef, onHold, onBack }: PaneProps) {
  const { triagePullRequest, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const pack = useRepoPack(item.repo);
  const doRuns = useDoRuns(item.repo, item.number);
  const [reply, setReply] = useState(restored === null ? draftText(item) : restored.reply);
  const [editing, setEditing] = useState(restored !== null && restored.reply !== draftText(item));
  const [composer, setComposer] = useState<Composer | null>(restored === null ? null : restored.composer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const verdict = useRef({ runId: item.runId, comment: item.comment });
  const facts = paneFacts(item, pull.data);
  const gate = { item, facts, readOnly, busy };
  const bar = paneBar(gate, pull.data?.pr.base ?? null, facts.author);
  const draft = replyDraft(item, reply);
  const dos = usePendingDos(item);
  const heldDos = useHeldDos();
  const doBlocked = writeBlocker(gate) !== null;
  const github = hasNumber(item) ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  const status = paneStatus({ item, detail: pull.data, handled, approved: approvedByTriage(item, doRuns.data ?? []), primary: bar.primary });
  const ended = endedText(item, pull.data, handled) !== null;

  // A new verdict replaces the drafted feedback and the last note; composer text and an edit made while a run is merely in flight stay.
  useEffect(function restartReplyOnNewVerdict() {
    if (verdict.current.runId === item.runId && verdict.current.comment === item.comment) return;
    verdict.current = { runId: item.runId, comment: item.comment };
    setReply(draftText(item));
    setEditing(false);
    setDone(null);
  }, [item.runId, item.comment]);

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

  function runDo(pending: PendingDo) {
    if (!hasNumber(item) || doBlocked) return;
    heldDos.hold(pending.key);
    function release() {
      heldDos.release(pending.key);
    }
    onHold(item, doWrite(item, pending, release), { reply, composer });
  }

  function run(kind: PaneKind) {
    if (!hasNumber(item) || !canRun(kind, gate)) return;
    if (isComposerKind(kind)) {
      setComposer(openComposer(composer, kind));
      return;
    }
    if (kind === "triage") {
      void startTriage(item);
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
      if (event.key === "a" && bar.primary !== null) {
        event.preventDefault();
        run(bar.primary.kind);
      }
      if (event.key === "e" && draft !== null) {
        event.preventDefault();
        setEditing(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <section ref={sectionRef} className="panel pane" aria-label="Selected pull request" tabIndex={-1}>
      <button type="button" className="btn btn-quiet btn-sm pane-back" onClick={onBack}>Back to {listTitle}</button>
      <div className="scroll">
        <div className="pane-in r3">
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
          <StatusLine status={status} />
          <Problems problems={paneProblems(item.checks)} pack={pack} item={item} />
          <Description pull={{ data: pull.data, loading: pull.isLoading, error: pull.error }} />
          {editing && draft !== null ? (
            <FeedbackEditor item={item} draft={draft} replyRef={replyRef} onChange={setReply} onKeyDown={onReplyKey} onCancel={() => setEditing(false)} />
          ) : null}
          {composer === null ? null : (
            <ComposerForm composer={composer} busy={busy} readOnly={readOnly} onChange={setComposer} onCancel={() => setComposer(null)} onSubmit={onComposerSubmit} />
          )}
          {dos.filter((pending) => pending.error !== null).map((pending) => <p key={pending.key} role="alert" className="error">{pending.label} failed last time: {pending.error}</p>)}
          {error === null ? null : <p role="alert" className="error">{error}</p>}
          {done === null ? null : <p role="status" className="note">{done}</p>}
          <ReportRows item={item} pull={{ data: pull.data, loading: pull.isLoading, error: pull.error }} pack={pack} />
        </div>
      </div>
      {ended ? null : <BottomBar
        bar={bar}
        draft={draft}
        dos={dos}
        doBlocked={doBlocked}
        running={item.running}
        onRun={run}
        onEdit={draft === null || editing ? null : () => setEditing(true)}
        onDo={runDo}
      />}
    </section>
  );
}

function repositoriesText(count: number): string {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** None open is only true when GitHub answered for every repository; a failed read says nothing about its pull requests. */
function NoneOpen({ title }: { title: string }) {
  const openPulls = useOpenPulls();
  const repos = openPulls.data?.repos;
  if (repos === undefined || openPulls.isError || repos.some((repo) => repo.error !== undefined)) return null;
  return <EmptyState title={title} description={`${repositoriesText(repos.length)} checked.`} />;
}

type EmptyListProps = { view: ListView; loading: boolean; denied: boolean; noRepos: boolean; filtered: boolean; onClear: () => void };

function EmptyList({ view, loading, denied, noRepos, filtered, onClear }: EmptyListProps) {
  if (loading) return null;
  if (denied) return <DeniedNotice section="logs" />;
  if (noRepos) {
    return <div className="zero"><h2>No repositories yet</h2><p>Choose the repositories Triage should read.</p><Link className="btn btn-sm" to="/repositories">Choose repositories on GitHub</Link></div>;
  }
  if (filtered) {
    return <div className="zero"><h2 style={{ fontSize: 20 }}>Nothing here</h2><p>No pull requests match these filters.</p><button type="button" className="btn btn-sm" onClick={onClear}>Clear filters</button></div>;
  }
  if (view === "all-open") return <NoneOpen title="No open pull requests" />;
  if (view === "first-timers") return <NoneOpen title="No first-timers" />;
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
          <button type="button" aria-keyshortcuts="u" onClick={onUndo}>Undo</button>
          <span className="drain" aria-hidden="true"><i style={{ animationDuration: `${HOLD_MS}ms` }} /></span>
        </div>
      )}
    </div>
  );
}

/** New, resolved and stuck since the last visit, and what the user acted on; it opens Pulse. */
function PulseLine() {
  const { pulse } = usePulse();
  if (pulse === null) return null;
  const counts = [`${pulse.since.fresh.length} new`, `${pulse.since.resolved.length} resolved`, `${pulse.stuck.length} stuck`];
  if (pulse.acted > 0) counts.push(`${pulse.acted} acted on by you`);
  return (
    <Link className="pulse-line" to="/pulse" aria-label={`Pulse: ${counts.join(", ")}`}>
      <span>{pulse.since.fresh.length} new</span><i aria-hidden="true" />
      <span>{pulse.since.resolved.length} resolved</span><i aria-hidden="true" />
      <span>{pulse.stuck.length} stuck</span>
      {pulse.acted > 0 ? <><i aria-hidden="true" /><b>You {pulse.acted}</b></> : null}
    </Link>
  );
}

/** Needs you rows are never handled; their piles keep the action order inside repository and owner groups. */
function needsYouPiles(piles: InboxPile[]): OpenPile[] {
  return piles.map((pile) => ({ key: pile.key, label: pile.label, items: pile.items.map((item) => ({ item, handled: null })) }));
}

export default function Inbox({ view }: { view: ListView }) {
  const params = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { snapshot } = usePortal();
  const held = useHeldInbox();
  const focusOnArrival = useRef<string | null | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  const open = useOpenItems();
  const loading = useQueueLoading();
  const openPullsUnanswered = useOpenPullsUnanswered();
  const { denied } = useTriageVerdicts();
  const [query, setQuery] = useState("");
  const [needsYouGrouping, setNeedsYouGrouping] = useState<InboxGrouping>("action");
  const [openGrouping, setOpenGrouping] = useState<OpenGrouping>("repo");
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const ready = useMemo(() => triageReadyRepos(snapshot?.repos ?? []), [snapshot]);
  const enabled = useMemo(() => triageEnabledRepos(snapshot?.repos ?? []), [snapshot]);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const entries = useMemo(() => viewEntries(view, open, enabled), [open, view, enabled]);
  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const searched = useMemo(() => entries.filter((entry) => matchesQuery(entry.item, query)), [entries, query]);
  const rows = useMemo(() => searched.map((entry) => entry.item).filter((item) => listsOpen(view) || inNeedsYou(item)), [searched, view]);
  const now = useMemo(() => Date.now(), [searched, filters]);
  const shown = useMemo(() => searched.filter((entry) => matchesFilters(entry.item, filters, now)), [searched, filters, now]);
  const needsYou = useMemo(() => groupInbox(shown.map((entry) => entry.item), ready), [shown, ready]);
  const piles = useMemo(function pilesOfView() {
    return listsOpen(view) ? groupOpen(shown, openGrouping) : needsYouPiles(regroupInbox(needsYou, needsYouGrouping));
  }, [view, shown, openGrouping, needsYou, needsYouGrouping]);
  const flat = useMemo(() => piles.flatMap((pile) => pile.items), [piles]);
  const selected = params.number === undefined ? flat[0]?.item : findPrItem(items, params);
  const selectedMark = entries.find((entry) => entry.item.key === selected?.key)?.handled ?? null;
  // All open keeps an acted-on pull request selected; a fresh pane closes the sent composer, and Undo brings its draft back.
  const paneKey = `${selected?.key}:${selectedMark?.kind ?? ""}`;
  const groupings: Array<InboxGrouping | OpenGrouping> = listsOpen(view) ? OPEN_GROUPINGS : INBOX_GROUPINGS;
  const grouping = listsOpen(view) ? openGrouping : needsYouGrouping;
  const hasConnectedRepo = snapshot !== null && snapshot.repos.some((repo) => repo.connected);

  function setFilters(next: InboxFilters) {
    setSearchParams(filtersToParams(next, searchParams), { replace: true });
  }

  function clearFilters() {
    setQuery("");
    setFilters(NO_FILTERS);
  }

  function groupBy(index: number) {
    if (listsOpen(view)) {
      const mode = OPEN_GROUPINGS[index];
      if (mode !== undefined) setOpenGrouping(mode);
      return;
    }
    const mode = INBOX_GROUPINGS[index];
    if (mode !== undefined) setNeedsYouGrouping(mode);
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
      if (/^[1-3]$/.test(event.key)) {
        groupBy(Number(event.key) - 1);
        return;
      }
      if (event.key !== "j" && event.key !== "k" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = flat.findIndex((entry) => entry.item.key === selected?.key);
      const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" || event.key === "ArrowDown" ? 1 : -1)))];
      if (next && next.item.key !== selected?.key) navigate({ pathname: listHref(view, next.item), search });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
    navigate({ pathname: item === undefined ? listRoot(view) : listHref(view, item), search });
  }

  /** Needs you moves on to the next row; the other views keep the pull request selected unless it left the list. */
  function holdAction(item: NumberedItem, write: PaneWrite, draft: PaneDraft) {
    if (write.settles !== null && (view === "needs-you" || leavesOpen(write.settles))) {
      const index = flat.findIndex((row) => row.item.key === item.key);
      const next = flat[index + 1] ?? flat[index - 1];
      moveTo(next?.item);
    } else if (write.settles !== null) {
      moveTo(item);
    }
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
          <div className="lh-top"><h1>{LIST_TITLE[view]}</h1>{openPullsUnanswered ? null : <span className="n">{flat.length}</span>}{view === "needs-you" && needsYou.awaiting > 0 ? <span className="awaiting">{awaitingText(needsYou.awaiting)}</span> : null}<PulseLine /></div>
          <div className="tools">
            <label className="search">
              <SearchIcon />
              <input ref={searchRef} placeholder="Search" aria-keyshortcuts="/" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pull requests" autoComplete="off" />
            </label>
            <FilterMenu items={rows} now={now} filters={filters} onChange={setFilters} triggerRef={filterRef} />
            <div className="seg" role="group" aria-label="Group by">
              {groupings.map((mode, index) => (
                <button key={mode} type="button" aria-pressed={grouping === mode} onClick={() => groupBy(index)}>{GROUPING_LABEL[mode]}</button>
              ))}
            </div>
          </div>
          <FilterPills filters={filters} onChange={setFilters} triggerRef={filterRef} />
        </div>
        <div className="scroll" id="main">
          {flat.length === 0 ? (
            <EmptyList view={view} loading={loading} denied={denied} noRepos={!hasConnectedRepo && items.length === 0} filtered={query.trim() !== "" || activeFilters(filters).length > 0} onClear={clearFilters} />
          ) : (
            <div className="groups">
              {piles.map((pile) => <Pile key={pile.key} view={view} pile={pile} selectedKey={selected?.key} search={search} />)}
            </div>
          )}
        </div>
      </section>
      {selected ? (
        <Pane
          key={paneKey}
          item={selected}
          handled={listsOpen(view) ? selectedMark : null}
          listTitle={LIST_TITLE[view]}
          restored={paneDraft}
          sectionRef={sectionRef}
          onHold={holdAction}
          onBack={() => navigate({ pathname: listRoot(view), search })}
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
