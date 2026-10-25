import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { CircleDot, FileText, GitCommitVertical, Info, MessageSquare, type LucideIcon } from "lucide-react";
import { DeniedNotice } from "../lib/denied.tsx";
import { usePortal } from "../lib/portal.tsx";
import { usePullPageItems, useQueueLoading } from "../lib/open-pulls.ts";
import { useApprovals } from "../lib/tenant-entities.ts";
import { QUEUE_STATE_LABEL, type CheckResult, type GithubPullDetail, type PrItem } from "../lib/hub-api.ts";
import { useGithubPull } from "../lib/github-pull.ts";
import { errorText } from "@corbits/common";
import type { RepoSource } from "@corbits/triage-contracts";
import { approvedHead, canRun, checkedHead, hasUncheckedCommits, paneFacts, titleText } from "../lib/inbox-pane.ts";
import { notPostedText } from "../lib/inbox-view.ts";
import { heldReason, isHeldBlock } from "../lib/pane-report.ts";
import { offersClose, pendingDos, type PendingDo } from "../lib/pending-dos.ts";
import { useApproveDo, useHeldDoKeys } from "../lib/held-dos.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";
import { PrTimeline } from "../components/PrTimeline.tsx";
import { SuggestedActions } from "../components/SuggestedActions.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { CitedEvidence } from "../components/CitedEvidence.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { useDiffLayout } from "../lib/diff-layout.ts";
import { useRepoPack } from "../lib/check-packs.ts";
import { checkLabel } from "../lib/pack-prose.ts";
import { hostName, pullUrl, viewOnHost } from "../lib/pull-link.ts";
import {
  approvalHeadline,
  checkValueText,
  findPrItem,
  relativeTime,
  upperFirst,
  verdictText,
} from "../lib/triage-view.ts";

type SliverTab = "about" | "files" | "commits" | "issue" | "conversation";

/** Bitbucket resolves no issue records; the reference the linked-issue rule found stands in for them. */
function ruleIssueReference(item: PrItem): string | null {
  const check = item.checks.find((row) => row.check === "linked-issue" && row.result === "pass");
  return check?.evidence[0] ?? null;
}

function IssueList({ item, issues, pending, error }: { item: PrItem; issues: GithubPullDetail["issues"]; pending: boolean; error: unknown }) {
  if (pending) return <p className="muted">Loading issues…</p>;
  if (error) return <p className="muted">Could not load issues. {errorText(error)}</p>;
  if (issues.length === 0) {
    const reference = ruleIssueReference(item);
    return reference === null ? <p className="muted">No linked issue.</p> : <p className="mono">{reference}</p>;
  }
  return (
    <ul>
      {issues.map((issue) => (
        <li key={issue.number}>
          <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number} {issue.title}</a> <Badge>{issue.state}</Badge>
        </li>
      ))}
    </ul>
  );
}

const GATE_RESULT: Record<CheckResult["result"], string> = { pass: "matched", fail: "did not match", unconfirmed: "unknown" };

function checkTone(check: CheckResult): string {
  if (check.result === "unconfirmed") return "wait";
  if (check.gate) return "match";
  return check.result;
}

function CheckRow({ check, name, source, repo, sha }: { check: CheckResult; name: string | null; source: RepoSource; repo: string; sha: string | null }) {
  const tone = checkTone(check);
  const value = checkValueText(check);
  return (
    <li className={`verdict-check check-item ${tone}`}>
      {name === null ? null : <strong>{name}</strong>}
      <span className="muted">{check.kind}</span>
      <span className="check-result">{check.gate ? GATE_RESULT[check.result] : check.result}</span>
      {check.reason ? <span className="check-fact">{check.reason}</span> : null}
      {value === null ? null : <span className="check-fact">{value}</span>}
      {check.evidence.map((line) => <span className="check-fact mono small-text" key={line}><CitedEvidence text={line} output={check.output} source={source} repo={repo} sha={sha} /></span>)}
    </li>
  );
}

function CheckList({ source, repo, sha, checks, fallback }: { source: RepoSource; repo: string; sha: string | null; checks: CheckResult[]; fallback: string[] }) {
  const pack = useRepoPack(repo);
  if (checks.length === 0) {
    return fallback.length === 0 ? <p className="muted">No triage findings.</p> : <ul>{fallback.map((reason) => <li key={reason}>{reason}</li>)}</ul>;
  }
  const open = checks.filter((c) => c.result === "fail").concat(checks.filter((c) => c.result === "unconfirmed"));
  const passed = checks.filter((c) => c.result === "pass");
  return (
    <>
      {open.length > 0 ? <ul className="verdict-checks">{open.map((c) => <CheckRow key={c.check} check={c} name={checkLabel(pack, c.check)} source={source} repo={repo} sha={sha} />)}</ul> : null}
      {passed.length > 0 ? (
        <details className="check-group">
          <summary>Checked and fine: {passed.length} {passed.length === 1 ? "rule" : "rules"}</summary>
          <ul className="verdict-checks">{passed.map((c) => <CheckRow key={c.check} check={c} name={checkLabel(pack, c.check)} source={source} repo={repo} sha={sha} />)}</ul>
        </details>
      ) : null}
    </>
  );
}

/** `drafted`: the recommended comment is open for editing above, so the overview does not repeat it. */
function About({ item, drafted }: { item: PrItem; drafted: boolean }) {
  const pull = useGithubPull(item.repo, item.number);
  const pr = pull.data?.pr;
  const facts = paneFacts(item, pull.data);
  const checks = (pull.data?.checks ?? []).map((row) => ({ name: row.name, status: row.conclusion ?? row.status }));
  const approvals = [...new Set((pull.data?.reviews ?? []).filter((row) => row.state.toUpperCase() === "APPROVED").map((row) => row.reviewer))];
  const issues = pull.data?.issues ?? [];
  const title = titleText(facts.title);
  const author = facts.author;
  const draft = facts.draft;
  const fileCount = pr?.changedFiles ?? null;
  const fail = checks.filter((row) => /fail/i.test(row.status)).length;
  const wait = checks.filter((row) => /pend|wait|progress|queued/i.test(row.status)).length;
  const pass = checks.filter((row) => /pass|success/i.test(row.status)).length;
  const pending = pull.isPending && pull.fetchStatus !== "idle";

  function renderCi() {
    if (pending) return <p className="muted">Loading checks…</p>;
    if (pull.error) return <p className="muted">Could not load checks.</p>;
    if (checks.length === 0) return <p className="muted">No checks reported.</p>;
    return (
      <>
        <p className="check-counts">
          <span className="fail">{fail} fail</span>
          <span className="wait">{wait} wait</span>
          <span className="pass">{pass} pass</span>
        </p>
        <div className="brief-chips">
          {checks.map((job) => (
            <Badge key={job.name} className="verbatim">{job.name} · {job.status}</Badge>
          ))}
        </div>
      </>
    );
  }

  function requestedText(): string {
    if (pr) return pr.requestedReviewers > 0 ? `${pr.requestedReviewers} requested` : "None requested";
    if (pending) return "Loading…";
    return "Unavailable";
  }

  function approvalsText(): string {
    const joined = approvals.join(", ");
    if (joined) return joined;
    if (pending) return "Loading…";
    if (pull.error) return "Unavailable";
    return "None yet";
  }

  return (
    <article className="pr-overview" aria-label="About">
      <header className="brief brief-lead">
        <h1>{title}</h1>
        {hasUncheckedCommits(item) ? <p className="soft">New commits since Triage checked</p> : null}
        <p className="verdict-why">{item.evidence[0] ?? item.nextAction ?? "No evidence recorded."}</p>
        {item.comment && !drafted ? <Markdown text={item.comment} /> : null}
      </header>
      <section className="brief">
        <h2>Pull request</h2>
        <dl className="facts">
          {author ? <div><dt>Author</dt><dd>{author}</dd></div> : null}
          <div><dt>Age</dt><dd>{relativeTime(item.waitingSince)}</dd></div>
          {pr === undefined ? null : (
            <div>
              <dt>Size</dt>
              <dd className="mono"><span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span></dd>
            </div>
          )}
          {fileCount === null ? null : <div><dt>Files</dt><dd>{fileCount}</dd></div>}
          {draft !== null && <div><dt>Ready</dt><dd>{draft ? "Draft" : "Ready for review"}</dd></div>}
        </dl>
      </section>
      <section className="brief">
        <h2>Issue</h2>
        <IssueList item={item} issues={issues} pending={pending} error={pull.error} />
      </section>
      <section className="brief">
        <h2>Repository</h2>
        <dl className="facts">
          <div><dt>Repo</dt><dd className="mono">{item.repo}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>Status</h2>
        <dl className="facts">
          <div><dt>Workflow</dt><dd>{QUEUE_STATE_LABEL[item.state]}</dd></div>
          <div><dt>Verdict</dt><dd>{verdictText({ ...item, reasons: [] })}</dd></div>
          <div><dt>Priority</dt><dd>{item.priority ?? "Unset"}</dd></div>
          <div><dt>Owner</dt><dd>{item.owner ?? "Unassigned"}</dd></div>
          <div><dt>Next</dt><dd className="soft">{item.nextAction ?? "No next action recorded."}</dd></div>
        </dl>
        {item.reasons.length ? <ul className="small-text" aria-label="Why">{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
      </section>
      <section className="brief">
        <h2>CI</h2>
        {renderCi()}
      </section>
      <section className="brief">
        <h2>Reviews</h2>
        <dl className="facts">
          <div><dt>Requested</dt><dd>{requestedText()}</dd></div>
          <div><dt>Approvals</dt><dd>{approvalsText()}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>Rules</h2>
        <CheckList source={item.source} repo={item.repo} sha={item.verdictSha} checks={item.checks} fallback={item.evidence} />
        {item.labels.length > 0 && (
          <div className="row wrap">
            {item.labels.map((label) => <Badge key={label} className="verbatim">{label}</Badge>)}
          </div>
        )}
      </section>
      <PrTimeline item={item} />
    </article>
  );
}

const SLIVER_ICONS: Record<SliverTab, LucideIcon> = {
  about: Info,
  files: FileText,
  commits: GitCommitVertical,
  issue: CircleDot,
  conversation: MessageSquare,
};

function SliverTabButton({ id, label, current, onSelect }: { id: SliverTab; label: string; current: SliverTab; onSelect: (id: SliverTab) => void }) {
  const TabIcon = SLIVER_ICONS[id];
  return (
    <button type="button" className={`sliver-tab${current === id ? " is-on" : ""}`} title={label} aria-pressed={current === id} onClick={() => onSelect(id)}>
      <TabIcon strokeWidth={1.7} aria-hidden="true" />
      <span className="sliver-tab-label">{label}</span>
    </button>
  );
}

function RecommendedComment({ item, posted, onPosted, onDismiss }: {
  item: PrItem;
  posted: boolean;
  onPosted: () => void;
  onDismiss: () => void;
}) {
  const { writeGithub } = usePortal();
  const queryClient = useQueryClient();
  const [body, setBody] = useState(item.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function post() {
    if (item.number === null) return;
    if (!body.trim()) {
      setError("Comment must not be empty.");
      return;
    }
    setBusy(true);
    try {
      setError("");
      await writeGithub({ action: "reply", repo: item.repo, number: item.number, body }, "now");
      if (item.labels.length > 0) await writeGithub({ action: "labels", repo: item.repo, number: item.number, labels: item.labels }, "now");
      onPosted();
      await queryClient.invalidateQueries({ queryKey: ["github-pull"] });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (posted) return <p role="status" className="pr-composer muted">Recommended comment posted.</p>;
  return (
    <section className="pr-composer" aria-label="Recommended comment">
      <h2>Recommended comment</h2>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} aria-label="Recommended comment" />
      {item.labels.length > 0 ? (
        <div className="chips" aria-label="Recommended labels">
          {item.labels.map((label) => <Badge key={label} className="verbatim">{label}</Badge>)}
        </div>
      ) : null}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="pr-actions-row">
        <Button type="button" disabled={busy} onClick={() => void post()}>Post</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDismiss}>Dismiss</Button>
      </div>
    </section>
  );
}

function MissingPull({ denied, loading }: { denied: boolean; loading: boolean }) {
  if (denied) return <DeniedNotice section="approvals" />;
  if (loading) return null;
  return <div className="empty">Unknown pull request.</div>;
}

export default function PRDetail() {
  const params = useParams();
  const { snapshot, decide, writeGithub, notify, readOnly } = usePortal();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SliverTab>("about");
  const [filePath, setFilePath] = useState("");
  const [composer, setComposer] = useState<null | { kind: "comment" | "approve" | "changes"; body: string }>(null);
  const id = params.id ?? params.number ?? "";
  const routed = params.owner && params.repo && Number.isInteger(Number(params.number)) ? { repo: `${params.owner}/${params.repo}`, number: Number(params.number) } : null;
  const queueItems = usePullPageItems(routed?.repo ?? null, routed?.number ?? null);
  const loading = useQueueLoading();
  const item = snapshot ? findPrItem(queueItems, params) : undefined;
  const approvals = useApprovals();
  const approval = approvals.rows.find((row) => row.id === (item?.pendingApprovalId ?? id));
  const denied = approvals.denied;
  const pull = useGithubPull(item?.repo ?? "", item?.number ?? null);
  const pullPending = pull.isPending && pull.fetchStatus !== "idle";
  const files = pull.data?.files ?? [];
  const commits = pull.data?.commits ?? [];
  const comments = pull.data?.comments ?? [];
  const selected = useMemo(() => files.find((file) => file.path === filePath) ?? files[0], [files, filePath]);
  const pending = approval?.status.toLowerCase() === "pending";
  const gated = Boolean(item?.needsHuman && pending);
  const gate = item === undefined ? null : { item, facts: paneFacts(item, pull.data), readOnly, busy };
  const closed = pull.data?.pr.state === "closed";
  const canMerge = gate !== null && canRun("merge", gate);
  const [handled, setHandled] = useState<Record<string, "posted" | "dismissed">>({});
  const head = pull.data?.pr.sha ?? item?.sha ?? "";
  const handledKey = `${item?.key}@${head}`;
  const recommended = item?.comment?.trim() ?? "";
  const showRecommended = Boolean(
    recommended && item?.number && !closed && !readOnly && !item.automatic.includes("comment") && handled[handledKey] !== "dismissed",
  );
  const recommendedPosted = handled[handledKey] === "posted" || comments.some((comment) => comment.body.includes(recommended));
  const dos = useMemo(() => (item === undefined ? [] : pendingDos(item)), [item]);
  const approvePackDo = useApproveDo();
  const heldDoKeys = useHeldDoKeys();
  const diffLayout = useDiffLayout();

  async function act(decision: "once" | "deny") {
    if (!approval) return;
    setBusy(true);
    try {
      setError("");
      await decide(approval.id, decision);
    } catch (cause) {
      setError(`Could not update the approval. ${errorText(cause)} Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function requestWrite(kind: "comment" | "approve" | "changes" | "merge" | "close") {
    if (!item || item.number === null) return;
    if (kind === "comment" || kind === "approve" || kind === "changes") {
      setComposer({ kind, body: composer?.kind === kind ? composer.body : "" });
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (kind === "merge") {
        await writeGithub({ action: "merge", repo: item.repo, number: item.number, headSha: checkedHead(item) }, "now");
      } else {
        await writeGithub({
          action: "close",
          repo: item.repo,
          number: item.number,
          labels: item.labels,
          comment: item.comment ?? "",
        }, "now");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approveDo(pending: PendingDo) {
    if (!item || item.number === null || item.running) return;
    setBusy(true);
    try {
      setError("");
      await approvePackDo(pending.ref, false);
      heldDoKeys.hold(pending.sentKey);
      notify(`Approved ${pending.label} on ${item.key}; Triage will run it.`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitComposer() {
    if (!item || item.number === null || !composer) return;
    const body = composer.body;
    if (composer.kind !== "approve" && !body.trim()) {
      setError("Comment must not be empty.");
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (composer.kind === "comment") {
        await writeGithub({ action: "comment", repo: item.repo, number: item.number, body }, "now");
      } else {
        const { repo, number } = item;
        const review = composer.kind === "approve"
          ? { action: "review", repo, number, event: "APPROVE", body, headSha: approvedHead(item) } as const
          : { action: "review", repo, number, event: "REQUEST_CHANGES", body } as const;
        await writeGithub(review, "now");
      }
      setComposer(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function submitComposerForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitComposer();
  }

  function selectFile(path: string) {
    setFilePath(path);
    setTab("files");
  }

  if (!item && approval) {
    return (
      <div className="main-shell">
        <header className="topbar pr-topbar">
          <Button asChild variant="ghost"><Link to="/inbox">Back</Link></Button>
          <h1 tabIndex={-1}>{approvalHeadline(approval)}</h1>
        </header>
        <main id="main" className="scroller">
          {approval.status.toLowerCase() === "pending" && (
            <ApprovalCard approval={approval} disabled={readOnly} onDecide={decide} approveLabel="Confirm" rejectLabel="Dismiss" />
          )}
        </main>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="main-shell">
        <header className="topbar pr-topbar">
          <Button asChild variant="ghost"><Link to="/inbox">Back</Link></Button>
          <h1 tabIndex={-1}>Pull request</h1>
        </header>
        <main id="main" className="scroller">
          <MissingPull denied={denied} loading={loading} />
        </main>
      </div>
    );
  }

  const link = pullUrl(item);
  const host = hostName(item.source);
  const notPosted = notPostedText(item);

  function loadNotice(): ReactNode {
    if (pullPending) return <p className="muted">Loading from {host}…</p>;
    if (pull.error) return <p role="alert" className="error">Could not load from {host}. {errorText(pull.error)}</p>;
    return null;
  }

  function filesPane(): ReactNode {
    if (loadState) return <div className="diff-empty">{loadState}</div>;
    if (selected) return <DiffView file={selected} layout={diffLayout.layout} canSplit={diffLayout.splitFits} onLayout={diffLayout.choose} />;
    return <div className="diff-empty"><p>No files changed.</p></div>;
  }

  function mergeBadge(): ReactNode {
    if (closed) return <Badge>{pull.data?.pr.merged ? "Merged" : "Closed"}</Badge>;
    if (gate === null || gate.facts.mergeable === null || gate.facts.hostBlock === "mergeability-unknown") return null;
    if (!gate.facts.mergeable) return <Badge>Not mergeable</Badge>;
    if (isHeldBlock(gate.facts.hostBlock)) return <Badge>{`Merge blocked · ${upperFirst(heldReason(gate.facts.hostBlock, pull.data))}`}</Badge>;
    return <Badge>Mergeable</Badge>;
  }

  function sliverText(what: string, loaded: string): string {
    if (pullPending) return `Loading ${what}…`;
    if (pull.error) return `Could not load ${what}.`;
    return loaded;
  }

  function renderSliver(): ReactNode {
    if (tab === "files") {
      if (loadState) return <p className="sliver-empty">{pullPending ? "Loading files…" : "Could not load files."}</p>;
      if (files.length === 0) return <p className="sliver-empty">No files changed.</p>;
      return (
        <div className="sliver-list">
          {files.map((file) => (
            <button type="button" className={`sliver-file${selected?.path === file.path ? " is-on" : ""}`} key={file.path} onClick={() => selectFile(file.path)}>
              <span className="sliver-file-name">{file.path}</span>
              <span className="sliver-file-stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
            </button>
          ))}
        </div>
      );
    }
    if (tab === "commits") return <p className="sliver-empty">{sliverText("commits", `${commits.length} commits`)}</p>;
    if (tab === "issue") return <p className="sliver-empty">{sliverText("issues", `${pull.data?.issues.length ?? 0} linked issues`)}</p>;
    if (tab === "conversation") return <p className="sliver-empty">{sliverText("conversation", `${comments.length} comments`)}</p>;
    return <p className="sliver-empty">Overview of this pull request.</p>;
  }
  let pane: ReactNode = <About item={item} drafted={showRecommended && !recommendedPosted} />;
  const loadState = loadNotice();
  if (tab === "files") pane = filesPane();
  if (tab === "commits") {
    pane = (
      <div className="pr-pane" aria-label="Commits">
        <h1>Commits</h1>
        {loadState ?? (commits.length === 0 ? <p className="muted">No commits.</p> : commits.map((commit) => (
          <div className="commit-row" key={commit.sha}>
            <span className="mono">{commit.sha.slice(0, 7)}</span>
            <strong>{commit.message.split("\n")[0]}</strong>
            <span className="muted">{commit.author} · {relativeTime(commit.committedAt)}</span>
          </div>
        )))}
      </div>
    );
  }
  if (tab === "issue") {
    pane = <div className="pr-pane" aria-label="Issue"><h1>Issue</h1><IssueList item={item} issues={pull.data?.issues ?? []} pending={pullPending} error={pull.error} /></div>;
  }
  if (tab === "conversation") {
    pane = (
      <div className="pr-pane" aria-label="Talk">
        <h1>Talk</h1>
        {loadState ?? (comments.length === 0 ? <p className="muted">No comments yet.</p> : comments.map((comment) => (
          <p key={comment.id}><strong>{comment.author}</strong> <span className="muted">{relativeTime(comment.createdAt)}</span><br />{comment.body}</p>
        )))}
      </div>
    );
  }

  return (
    <>
      <div className="main-shell">
        <header className="topbar pr-topbar action-bar">
          <Button asChild variant="ghost"><Link to="/inbox">Back</Link></Button>
          <div className="pr-id">
            <p className="pr-id-line">
              <span className="mono pr-repo">{item.repo}</span>
              <strong className="pr-num">{item.number ? `#${item.number}` : ""}</strong>
            </p>
            <div className="pr-id-row">
              <span className={`pri ${(item.priority ?? "").toLowerCase()}`}>{item.priority ?? "—"}</span>
              <Badge>{QUEUE_STATE_LABEL[item.state]}</Badge>
              {mergeBadge()}
              <VerdictChip item={item} />
              {link ? <a className="ghost-link" href={link} target="_blank" rel="noreferrer">{viewOnHost(item)}</a> : null}
            </div>
          </div>
          <div className="pr-actions">
            <div className="pr-actions-row">
              {pending && (
                <>
                  {!closed && <Button type="button" variant={gated ? "primary" : "outline"} disabled={busy || readOnly} onClick={() => void act("once")}>Confirm</Button>}
                  <Button type="button" variant="outline" disabled={busy || readOnly} onClick={() => void act("deny")}>Dismiss</Button>
                </>
              )}
              {!closed && (
                <>
                  <Button type="button" variant="outline" disabled={!item.number || busy || readOnly} onClick={() => void requestWrite("comment")}>Comment</Button>
                  <Button type="button" variant={canMerge && !gated ? "primary" : "outline"} disabled={!canMerge} onClick={() => void requestWrite("merge")}>Merge</Button>
                  <Menu>
                    <MenuTrigger asChild><Button type="button" variant="outline" aria-label="More actions">More</Button></MenuTrigger>
                    <MenuContent align="end">
                      {item.byTriage ? null : (
                        <>
                          <MenuItem disabled={!item.number || busy || readOnly} onSelect={() => void requestWrite("approve")}>Approve</MenuItem>
                          <MenuItem disabled={!item.number || busy || readOnly} onSelect={() => void requestWrite("changes")}>Request changes</MenuItem>
                        </>
                      )}
                      {!offersClose(item) && <MenuItem disabled={!item.number || busy || readOnly} onSelect={() => void requestWrite("close")}>Close pull request</MenuItem>}
                    </MenuContent>
                  </Menu>
                </>
              )}
            </div>
          </div>
        </header>
        {composer && (
          <form className="pr-composer" onSubmit={submitComposerForm}>
            <textarea
              value={composer.body}
              onChange={(event) => setComposer({ ...composer, body: event.target.value })}
              placeholder={composer.kind === "approve" ? "Optional review comment" : "Write a comment"}
              required={composer.kind !== "approve"}
              rows={3}
            />
            <div className="pr-actions-row">
              <Button type="submit" disabled={busy || readOnly}>Send</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setComposer(null)}>Cancel</Button>
            </div>
          </form>
        )}
        {showRecommended ? (
          <RecommendedComment
            key={`${handledKey}@${item.runId}`}
            item={item}
            posted={recommendedPosted}
            onPosted={() => setHandled({ ...handled, [handledKey]: "posted" })}
            onDismiss={() => setHandled({ ...handled, [handledKey]: "dismissed" })}
          />
        ) : null}
        {closed || notPosted === null ? null : <p role="status" className="pr-composer muted">{notPosted}</p>}
        {closed || dos.length === 0 ? null : (
          <div className="pr-composer">
            <SuggestedActions dos={dos} disabled={!item.number || item.running || busy || readOnly} onApprove={(pending) => void approveDo(pending)} onSkip={(pending) => heldDoKeys.hide(pending.key)} />
          </div>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <main id="main" className="content content-pr-shell">
          <div className="pr-workspace">{pane}</div>
        </main>
      </div>
      <aside className="pr-sliver" aria-label="Pull request">
        <div className="sliver-tabs" role="toolbar" aria-label="Pull request">
          <SliverTabButton id="about" label="About" current={tab} onSelect={setTab} />
          <SliverTabButton id="files" label="Files" current={tab} onSelect={setTab} />
          <SliverTabButton id="commits" label="Commits" current={tab} onSelect={setTab} />
          <SliverTabButton id="issue" label="Issue" current={tab} onSelect={setTab} />
          <SliverTabButton id="conversation" label="Talk" current={tab} onSelect={setTab} />
        </div>
        <div className="sliver-body">
          {renderSliver()}
        </div>
      </aside>
    </>
  );
}
