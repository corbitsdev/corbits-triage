import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AuthorKind, CheckPack } from "@corbits/triage-contracts";
import { lacksDecisionModel, type GithubPullDetail, type PrItem, type RepoRecord } from "../lib/hub-api.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { useGithubPull } from "../lib/github-pull.ts";
import { useMediaQuery } from "../lib/media-query.ts";
import { errorText } from "@corbits/common";
import { HOLD_MS, type Notices } from "../lib/held-actions.ts";
import { useHeldInbox } from "../lib/held-inbox.tsx";
import { pendingDos, type PendingDo } from "../lib/pending-dos.ts";
import { useHeldDoKeys } from "../lib/held-dos.ts";
import { CodeReviewThreads } from "../components/CodeReviewThreads.tsx";
import { Description, HeldActions, Problems, ReportRows, StatusLine } from "../components/PaneReport.tsx";
import { endedText, heldChoices, lineText, paneBar, paneProblems, paneStatus, type BarEntry, type HeldChoice, type PaneBar } from "../lib/pane-report.ts";
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
  ageText,
  awaitingText,
  entriesFor,
  groupInbox,
  groupOpen,
  inNeedsYou,
  initialsOf,
  isLoudAuthorKind,
  listedAction,
  listHref,
  matchesQuery,
  regroupInbox,
  stoppedNotes,
  triageView,
  waitingOnOthers,
  withTriageView,
  type InboxAction,
  type InboxGrouping,
  type HandledMark,
  type InboxPile,
  type OpenGrouping,
  type OpenItem,
  type OpenPile,
  type TriageView,
} from "../lib/inbox-view.ts";
import { NO_FILTERS, activeFilters, filtersFromParams, filtersToParams, matchesFilters, type InboxFilters } from "../lib/inbox-filter.ts";
import { leavesOpen, useOpenPulls, useOpenPullsUnanswered, useQueueLoading, useMarkedItems } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { enabledRepos, packsPending, repoHref, repoKey, reposNeedingSetup, triageEnabledRepos, triageReadyRepos } from "../lib/repo-rows.ts";
import { useTriageVerdicts } from "../lib/triage-verdicts.ts";
import { upgradeLabel, usePolicyUpgrades } from "../lib/policy-upgrades.ts";
import { findPrItem } from "../lib/triage-view.ts";
import { packOf, useCheckPacks, useRepoPack, useRepoWanted, type PackState } from "../lib/check-packs.ts";
import { FilterMenu, FilterPills } from "../components/InboxFilter.tsx";
import { ExternalIcon, SearchIcon } from "../components/inbox-icons.tsx";
import PullToRefresh from "../components/PullToRefresh.tsx";
import { pullUrl, viewOnHost } from "../lib/pull-link.ts";

const GROUPING_LABEL: Record<InboxGrouping | OpenGrouping, string> = { action: "Action", repo: "Repo", waits: "Waits on", owner: "Owner" };

const LIST_TITLE: Record<TriageView, string> = { "needs-you": "Needs you", ready: "Ready", "all-open": "Open", all: "All" };

const WAITING = "Waiting";

const WAITING_PARAM = "waiting";

type Slice = { view: TriageView; waiting: boolean; label: string };

const SLICES: Slice[] = [
  { view: "needs-you", waiting: false, label: "Needs you" },
  { view: "needs-you", waiting: true, label: WAITING },
  { view: "ready", waiting: false, label: "Ready" },
  { view: "all-open", waiting: false, label: "Open" },
  { view: "all", waiting: false, label: "All" },
];

function sliceTarget(params: URLSearchParams, view: TriageView, waiting: boolean): string {
  const next = withTriageView(params, view);
  if (waiting) next.set(WAITING_PARAM, "1");
  const search = next.toString();
  return search === "" ? "/" : `/?${search}`;
}

type SliceButtonsProps = { view: TriageView; waiting: boolean; waitingCount: number; onShow: (view: TriageView, waiting: boolean) => void };

function SliceButtons({ view, waiting, waitingCount, onShow }: SliceButtonsProps) {
  return (
    <div className="seg" role="group" aria-label="Show">
      {SLICES.map((slice) => (
        <button key={slice.label} type="button" aria-pressed={slice.waiting ? waiting : !waiting && view === slice.view} onClick={() => onShow(slice.view, slice.waiting)}>{slice.label}{slice.waiting && waitingCount > 0 ? <span className="n">{waitingCount}</span> : null}</button>
      ))}
    </div>
  );
}

// Narrower screens show the list or the pane, so only side by side does the first row open by itself.
const SIDE_BY_SIDE = "not (max-width: 960px)";

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

function listsOpen(view: TriageView): boolean {
  return view !== "needs-you";
}

function groupingsOf(view: TriageView, listsRest: boolean): Array<InboxGrouping | OpenGrouping> {
  if (view === "ready") return [];
  return listsRest ? OPEN_GROUPINGS : INBOX_GROUPINGS;
}

function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}

type RowProps = { entry: OpenItem; pack: CheckPack | null; byRepo: boolean; selected: boolean; search: string };

/** Grouped by repository the pile names it, so the row names the author instead. */
function Row({ entry, pack, byRepo, selected, search }: RowProps) {
  const { item, handled } = entry;
  const line = lineText(paneStatus({ item, detail: undefined, handled, pack }));
  const href = listHref(item);
  const cells = (
    <>
      <span className={dotClass(item, listedAction(item))} />
      <span className="num">{byRepo ? null : repoName(item.repo)}{item.number === null ? null : `#${item.number}`}</span>
      <b className="tw">{titleText(item.title)}</b>
      {byRepo ? <span className="who" title={item.author ?? undefined}>{item.author}</span> : null}
      <span className="age">{ageText(item.waitingSince)}</span>
      <span className="st" title={line}><span className="st-text">{line}</span></span>
    </>
  );
  if (href === undefined) return <div className="row" data-inbox-row={item.key}>{cells}</div>;
  return <Link className="row" aria-current={selected} to={{ pathname: href, search }} data-inbox-row={item.key}>{cells}</Link>;
}

type PileProps = { byRepo: boolean; pile: OpenPile; packs: Map<string, PackState>; selectedKey: string | undefined; search: string };

function Pile({ byRepo, pile, packs, selectedKey, search }: PileProps) {
  return (
    <>
      <div className="gh">{pile.label}<span className="n">{pile.items.length}</span></div>
      {pile.items.map((entry) => <Row key={entry.item.key} byRepo={byRepo} entry={entry} pack={packOf(packs.get(repoKey({ name: entry.item.repo, source: entry.item.source }))?.found)} selected={entry.item.key === selectedKey} search={search} />)}
    </>
  );
}

function Byline({ item, author, detail }: { item: PrItem; author: string | null; detail: GithubPullDetail | undefined }) {
  return (
    <div className="byline">
      {author === null ? null : <span className="who"><span className="av">{initialsOf(author)}</span><span className="nm">{author}</span></span>}
      <AuthorTag kind={item.authorKind} />
      {detail === undefined ? null : <span>opened {ageText(detail.pr.createdAt)} ago</span>}
      {detail === undefined ? null : <span className="mono"><span className="add">+{detail.pr.additions}</span> <span className="del">−{detail.pr.deletions}</span></span>}
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
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Done</Button>
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
        <Button type="submit" variant="outline" size="sm" disabled={busy || readOnly}>{copy.submit}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
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
  handled: HandledMark | null;
  listTitle: string;
  restored: PaneDraft | null;
  sectionRef: RefObject<HTMLElement | null>;
  onHold: (item: NumberedItem, write: PaneWrite, draft: PaneDraft) => void;
  onBack: () => void;
};

type BottomBarProps = { bar: PaneBar; draft: ReplyDraft | null; onChoose: (entry: BarEntry) => void; onEdit: (() => void) | null };

/** Held actions are listed under the status line; the other writes are buttons, or behind More on a phone where they cannot fit. */
function BottomBar({ bar, draft, onChoose, onEdit }: BottomBarProps) {
  const { primary, rest } = bar;
  const writes = rest.filter((entry) => entry.held === null);

  return (
    <div className="bar">
      {primary !== null && (
        <Button type="button" className="bar-primary" disabled={primary.blocker !== null} onClick={() => onChoose(primary)}>
          {primary.kind === "reply" && draft?.edited ? "Send edited feedback" : primary.label}
          {primary.detail === null ? null : <span className="det">{primary.detail}</span>}
          {primary.held?.until === null ? <span className="held-hint">held for you</span> : null}
        </Button>
      )}
      {onEdit === null ? null : <Button type="button" variant="ghost" onClick={onEdit}>Edit feedback</Button>}
      {writes.map((entry) => <Button key={entry.kind} type="button" variant="ghost" className="bar-write" disabled={entry.blocker !== null} onClick={() => onChoose(entry)}>{entry.label}</Button>)}
      {writes.length === 0 ? null : (
        <Menu>
          <MenuTrigger asChild><Button type="button" variant="ghost" className="bar-more">More</Button></MenuTrigger>
          <MenuContent side="top" align="end">
            {writes.map((entry) => <MenuItem key={entry.kind} disabled={entry.blocker !== null} onSelect={() => onChoose(entry)}>{entry.label}</MenuItem>)}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

function Pane({ item, handled, listTitle, restored, sectionRef, onHold, onBack }: PaneProps) {
  const { triagePullRequest, readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const pack = useRepoPack(item.repo, item.source);
  const wanted = useRepoWanted(item.repo, item.source);
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
  const dos = useMemo(() => pendingDos(item), [item]);
  const heldDoKeys = useHeldDoKeys();
  const doBlocked = writeBlocker(gate) !== null;
  const link = pullUrl(item);
  const status = paneStatus({ item, detail: pull.data, handled, pack });
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

  function approveDo(pending: PendingDo, always: boolean) {
    if (!hasNumber(item) || doBlocked) return;
    heldDoKeys.hold(pending.sentKey);
    function release() {
      heldDoKeys.release(pending.sentKey);
    }
    onHold(item, doWrite(item, pending, release, always), { reply, composer });
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

  function choose(entry: BarEntry) {
    if (entry.blocker !== null) return;
    if (entry.held === null) run(entry.kind);
    else approveDo(entry.held, false);
  }

  function chooseHeld({ pending, entry }: HeldChoice, always: boolean) {
    if (always || entry === null) approveDo(pending, always);
    else choose(entry);
  }

  function hideDos() {
    for (const pending of dos) heldDoKeys.hide(pending.key);
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
        choose(bar.primary);
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
      <Button type="button" variant="ghost" size="sm" className="pane-back" onClick={onBack}>Back to {listTitle}</Button>
      <PullToRefresh className="scroll">
        <div className="pane-in r3">
          <header className="ph">
            <div className="crumb">
              <Link className="mono repo-link" to={repoHref({ name: item.repo, source: item.source })} title="Repository settings">{item.repo}</Link>
              {item.number === null ? null : <span className="mono">#{item.number}</span>}
              <span className="sp" />
              {link === null ? null : <Button asChild variant="ghost" size="sm"><a href={link} target="_blank" rel="noreferrer">{viewOnHost(item)} <ExternalIcon /></a></Button>}
            </div>
            <h2 className="title">{titleText(facts.title)}</h2>
            <Byline item={item} author={facts.author} detail={pull.data} />
          </header>
          <StatusLine status={status} />
          {ended ? null : <HeldActions held={heldChoices(bar)} wanted={wanted} doBlocked={doBlocked} onApprove={chooseHeld} onHide={dos.length === 0 ? null : hideDos} />}
          <Problems problems={paneProblems(item.checks, pack)} pack={pack} item={item} authorsTurn={status.tone === "author"} />
          {hasNumber(item) ? <CodeReviewThreads item={item} /> : null}
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
      </PullToRefresh>
      {!ended && <BottomBar
        bar={bar}
        draft={draft}
        onChoose={choose}
        onEdit={draft === null || editing ? null : () => setEditing(true)}
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
  return <ListEmpty title={title} text={`${repositoriesText(repos.length)} checked.`} />;
}

/** An empty list names the condition in a left-aligned mute sentence under its heading. */
function ListEmpty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="list-empty"><h2>{title}</h2><p>{text}</p>{action}</div>;
}

type EmptyListProps = { view: TriageView; waiting: boolean; waitingCount: number; loading: boolean; denied: boolean; noRepos: boolean; filtered: boolean; onClear: () => void; onShowWaiting: () => void };

/** A repository whose policy file triage refuses runs nothing, so its pull requests wait here without a verdict. */
function RefusedPolicies({ repos }: { repos: RepoRecord[] }) {
  const packs = useCheckPacks(repos);
  function refusedPath(repo: RepoRecord): string | undefined {
    const found = packs.get(repoKey(repo))?.found;
    return found?.kind === "invalid" ? found.path : undefined;
  }
  const refused = repos.filter((repo) => refusedPath(repo) !== undefined);
  return refused.map((repo) => (
    <p key={repoKey(repo)} role="status" className="note">Triage runs nothing on <Link to={repoHref(repo)}>{repo.name}</Link> until its {refusedPath(repo)} is fixed.</p>
  ));
}

/** Triage not running on a host is said once here, not on each of its pull requests. */
function StoppedNotes({ items }: { items: readonly PrItem[] }) {
  return stoppedNotes(items).map((note) => <p key={note} role="status" className="note">{note} <Link to="/settings/triage">Open Settings</Link></p>);
}

/**
 * Each repository whose policy file pull request is waiting for merge, its panel walking through it; the others with
 * no policy file yet are counted, however many there are.
 */
function PolicyUpgradeNotice() {
  const rows = usePolicyUpgrades();
  const waiting = rows.filter((row) => row.pull !== undefined);
  const starting = rows.length - waiting.length;
  return (
    <>
      {waiting.length ? <p role="status" className="note">{waiting.map((row, at) => <Fragment key={repoKey({ name: row.repo, source: row.source })}>{at > 0 ? " · " : null}<Link to={repoHref({ name: row.repo, source: row.source })}>{row.repo}</Link>: {upgradeLabel(row)}</Fragment>)}</p> : null}
      {starting ? <p role="status" className="note"><Link to="/repositories">{repositoriesText(starting)}</Link> {starting === 1 ? "has" : "have"} no policy file yet, so Triage runs nothing there.</p> : null}
    </>
  );
}

function EmptyList({ view, waiting, waitingCount, loading, denied, noRepos, filtered, onClear, onShowWaiting }: EmptyListProps) {
  if (loading) return null;
  if (denied) return <DeniedNotice section="logs" />;
  if (noRepos) {
    return <ListEmpty title="No repositories yet" text="Choose the repositories Triage should read." action={<Button asChild variant="outline"><Link to="/repositories">Choose repositories on GitHub</Link></Button>} />;
  }
  if (filtered) {
    return <ListEmpty title="Nothing here" text="No pull requests match these filters." action={<Button type="button" variant="outline" onClick={onClear}>Clear filters</Button>} />;
  }
  if (view === "all" || view === "all-open") return <NoneOpen title="No open pull requests" />;
  if (view === "ready") return <ListEmpty title="Nothing ready" text="No pull requests can be merged now." />;
  if (waiting) return <ListEmpty title="Nothing waiting" text="No pull requests are waiting on others." />;
  const showWaiting = waitingCount > 0 ? <Button type="button" variant="outline" onClick={onShowWaiting}>Show {waitingCount} waiting</Button> : undefined;
  return <ListEmpty title="Inbox zero" text="Nothing needs you." action={showWaiting} />;
}

function Outcome({ outcome }: { outcome: Notices["outcome"] }) {
  if (outcome === null) return null;
  if (outcome.result === "sent") return <span key={outcome.id} className="sr-only">{outcome.message}</span>;
  return <div key={outcome.id} className="toast note">{outcome.message}</div>;
}

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

/** Without a decision model Triage judges nothing, so the list points to where one is connected. */
function ConnectModel() {
  const { snapshot, readOnly } = usePortal();
  if (!snapshot || !lacksDecisionModel(snapshot)) return null;
  return (
    <div className="grants">
      <section className="rs" aria-labelledby="connect-model">
        <h3 id="connect-model">Connect a decision model</h3>
        <div className="gcard">
          <div className="sentences">
            <div className="sentence">
              <span className="txt">Triage needs a decision model before it can judge pull requests.</span>
              {readOnly ? null : <Button asChild size="sm"><Link to="/settings/triage">Connect</Link></Button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function needsYouPiles(piles: InboxPile[]): OpenPile[] {
  return piles.map((pile) => ({ key: pile.key, label: pile.label, items: pile.items.map((item) => ({ item, handled: null })) }));
}

export default function Inbox() {
  const params = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = triageView(searchParams);
  const { snapshot } = usePortal();
  const held = useHeldInbox();
  const focusOnArrival = useRef<string | null | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  const { open, known } = useMarkedItems();
  const loading = useQueueLoading();
  const openPullsUnanswered = useOpenPullsUnanswered();
  const { denied, error: verdictsError } = useTriageVerdicts();
  const [query, setQuery] = useState("");
  const [needsYouGrouping, setNeedsYouGrouping] = useState<InboxGrouping>("action");
  const [openGrouping, setOpenGrouping] = useState<OpenGrouping>("repo");
  const [waitingGrouping, setWaitingGrouping] = useState<OpenGrouping>("waits");
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const enabled = useMemo(() => triageEnabledRepos(snapshot?.repos ?? []), [snapshot]);
  const enabledRecords = useMemo(() => enabledRepos(snapshot?.repos ?? []), [snapshot]);
  const packs = useCheckPacks(enabledRecords);
  const ready = useMemo(() => triageReadyRepos(snapshot?.repos ?? [], packs), [snapshot, packs]);
  const needsSetup = useMemo(() => reposNeedingSetup(enabledRecords, packs), [enabledRecords, packs]);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const waiting = view === "needs-you" && searchParams.has(WAITING_PARAM);
  const listsRest = listsOpen(view) || waiting;
  const waitingEntries = useMemo(() => waitingOnOthers(open, enabled), [open, enabled]);
  const viewed = useMemo(() => entriesFor(view, open, known, enabled), [open, known, view, enabled]);
  const entries = waiting ? waitingEntries : viewed;
  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const searched = useMemo(() => entries.filter((entry) => matchesQuery(entry.item, query)), [entries, query]);
  const rows = useMemo(() => searched.map((entry) => entry.item).filter((item) => listsRest || inNeedsYou(item)), [searched, listsRest]);
  const now = useMemo(() => Date.now(), [searched, filters]);
  const shown = useMemo(() => searched.filter((entry) => matchesFilters(entry.item, filters, now)), [searched, filters, now]);
  const needsYou = useMemo(() => groupInbox(shown.map((entry) => entry.item), ready), [shown, ready]);
  const piles = useMemo(function pilesOfView() {
    if (view === "ready") return [{ key: "ready", label: "Oldest first", items: shown }];
    if (listsOpen(view)) return groupOpen(shown, openGrouping, needsSetup);
    if (waiting) return groupOpen(shown, waitingGrouping, needsSetup);
    return needsYouPiles(regroupInbox(needsYou, needsYouGrouping));
  }, [view, waiting, shown, openGrouping, waitingGrouping, needsSetup, needsYou, needsYouGrouping]);
  const flat = useMemo(() => piles.flatMap((pile) => pile.items), [piles]);
  const firstRow = useMediaQuery(SIDE_BY_SIDE) ? flat[0]?.item : undefined;
  const selected = params.number === undefined ? firstRow : findPrItem(items, params);
  const selectedMark = entries.find((entry) => entry.item.key === selected?.key)?.handled ?? null;
  // All open keeps an acted-on pull request selected; a fresh pane closes the sent composer, and Undo brings its draft back.
  const paneKey = `${selected?.key}:${selectedMark?.kind ?? ""}`;
  const groupings = groupingsOf(view, listsRest);
  const grouping = currentGrouping();
  const byRepo = view !== "ready" && grouping === "repo";
  const listTitle = waiting ? WAITING : LIST_TITLE[view];
  const hasConnectedRepo = snapshot !== null && snapshot.repos.some((repo) => repo.connected);
  // Search, filters and grouping have nothing to work on in an empty list; at inbox zero the list itself offers Waiting.
  const searchable = loading || entries.some((entry) => listsRest || inNeedsYou(entry.item));

  function setFilters(next: InboxFilters) {
    setSearchParams(filtersToParams(next, searchParams), { replace: true });
  }

  function clearFilters() {
    setQuery("");
    setFilters(NO_FILTERS);
  }

  function currentGrouping(): InboxGrouping | OpenGrouping {
    if (listsOpen(view)) return openGrouping;
    return waiting ? waitingGrouping : needsYouGrouping;
  }

  function showSlice(next: TriageView, nextWaiting: boolean) {
    navigate(sliceTarget(searchParams, next, nextWaiting));
  }

  function toggleWaiting() {
    showSlice("needs-you", !waiting);
  }

  function groupBy(index: number) {
    if (groupings.length === 0) return;
    if (listsRest) {
      const mode = OPEN_GROUPINGS[index];
      if (mode === undefined) return;
      if (waiting) setWaitingGrouping(mode);
      else setOpenGrouping(mode);
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
      const step = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
      const index = flat.findIndex((entry) => entry.item.key === selected?.key);
      for (let at = index === -1 ? 0 : index + step; at >= 0 && at < flat.length; at += step) {
        const href = listHref(flat[at]!.item);
        if (href === undefined) continue;
        navigate({ pathname: href, search });
        return;
      }
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
    const href = item === undefined ? undefined : listHref(item);
    if (item === undefined || href === undefined) {
      focusOnArrival.current = null;
      navigate({ pathname: "/", search });
      return;
    }
    focusOnArrival.current = item.key;
    navigate({ pathname: href, search });
  }

  /** Needs you moves on to the next row; the other views keep the pull request selected unless it left the list; All keeps a merged or closed one until the list refreshes. */
  function holdAction(item: NumberedItem, write: PaneWrite, draft: PaneDraft) {
    if (write.settles !== null && (!listsRest || (view !== "all" && leavesOpen(write.settles)))) {
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
        <ConnectModel />
        <div className="lh">
          <div className="lh-top">
            <h1>Triage</h1>
            {openPullsUnanswered ? null : <span className="n">{flat.length}</span>}
            {view === "needs-you" && !waiting && !packsPending(packs) && needsYou.awaiting > 0 ? <span className="awaiting">{awaitingText(needsYou.awaiting)}</span> : null}
            <SliceButtons view={view} waiting={waiting} waitingCount={waitingEntries.length} onShow={showSlice} />
          </div>
          {searchable ? (
            <div className="tools">
              <label className="search">
                <SearchIcon />
                <input ref={searchRef} placeholder="Search" aria-keyshortcuts="/" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search pull requests" autoComplete="off" />
              </label>
              <FilterMenu items={rows} now={now} filters={filters} onChange={setFilters} triggerRef={filterRef} />
              {groupings.length > 0 ? (
                <div className="seg" role="group" aria-label="Group by">
                  {groupings.map((mode, index) => (
                    <button key={mode} type="button" aria-pressed={grouping === mode} onClick={() => groupBy(index)}>{GROUPING_LABEL[mode]}</button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {searchable || activeFilters(filters).length > 0 ? <FilterPills filters={filters} onChange={setFilters} triggerRef={filterRef} /> : null}
        </div>
        <PullToRefresh className="scroll" id="main">
          <RefusedPolicies repos={enabledRecords} />
          <StoppedNotes items={open.map((entry) => entry.item)} />
          <PolicyUpgradeNotice />
          {verdictsError && <p role="alert" className="error">Could not read triage results. {verdictsError.message}</p>}
          {flat.length === 0 ? (
            <EmptyList view={view} waiting={waiting} waitingCount={waitingEntries.length} loading={loading} denied={denied} noRepos={!hasConnectedRepo && items.length === 0} filtered={query.trim() !== "" || activeFilters(filters).length > 0} onClear={clearFilters} onShowWaiting={toggleWaiting} />
          ) : (
            <div className="groups">
              {piles.map((pile) => <Pile key={pile.key} byRepo={byRepo} pile={pile} packs={packs} selectedKey={selected?.key} search={search} />)}
            </div>
          )}
        </PullToRefresh>
      </section>
      {selected ? (
        <Pane
          key={paneKey}
          item={selected}
          handled={selectedMark}
          listTitle={listTitle}
          restored={paneDraft}
          sectionRef={sectionRef}
          onHold={holdAction}
          onBack={() => navigate({ pathname: "/", search })}
        />
      ) : (
        <section className="panel pane" aria-label="Selected pull request">
          {!loading && <div className="pane-empty">Select a pull request.</div>}
        </section>
      )}
      <Toasts notices={held.notices} onUndo={() => held.undo()} />
    </div>
  );
}
