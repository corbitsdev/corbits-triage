import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { CircleDot, FileText, GitCommitVertical, Info, MessageSquare, type LucideIcon } from "lucide-react";
import { DeniedNotice } from "../lib/denied.tsx";
import { usePortal } from "../lib/portal.tsx";
import { usePullRequestItems, useQueueLoading } from "../lib/open-pulls.ts";
import { useApprovals } from "../lib/tenant-entities.ts";
import { QUEUE_STATE_LABEL, type CheckResult, type GithubPullDetail, type PrItem } from "../lib/hub-api.ts";
import { useGithubPull } from "../lib/github-pull.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import {
  approvalHeadline,
  findPrItem,
  relativeTime,
  scoreText,
} from "../lib/triage-view.ts";

type SliverTab = "about" | "files" | "commits" | "issue" | "conversation";

function parseDiff(hunk: string): Array<{ header: string; rows: Array<{ type: string; oldNo: string | number; newNo: string | number; mark: string; text: string }> }> {
  if (!hunk) return [];
  const hunks: Array<{ header: string; rows: Array<{ type: string; oldNo: string | number; newNo: string | number; mark: string; text: string }> }> = [];
  let cur: (typeof hunks)[number] | null = null;
  let oldLine = 1;
  let newLine = 1;
  const lines = hunk.replace(/\n$/, "").split("\n");
  if (!lines.some((line) => line.startsWith("@@"))) {
    cur = { header: "", rows: [] };
    hunks.push(cur);
  }
  for (const line of lines) {
    const meta = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (meta) {
      cur = { header: line, rows: [] };
      hunks.push(cur);
      oldLine = Number(meta[1]);
      newLine = Number(meta[2]);
      continue;
    }
    if (!cur) continue;
    const active = cur;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      active.rows.push({ type: "add", oldNo: "", newNo: newLine, mark: "+", text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      active.rows.push({ type: "del", oldNo: oldLine, newNo: "", mark: "−", text: line.slice(1) });
      oldLine += 1;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      active.rows.push({ type: "ctx", oldNo: oldLine, newNo: newLine, mark: "", text });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks.filter((hk) => hk.rows.length || hk.header);
}

type PullFile = GithubPullDetail["files"][number];

function DiffViewer({ file }: { file: PullFile | undefined }) {
  if (!file) return <div className="diff-empty"><p>Select a file</p></div>;
  const hunks = parseDiff(file.patch ?? "");
  return (
    <article className="diff-viewer">
      <header className="diff-chrome">
        <h2 className="diff-path">{file.path}</h2>
        <p className="diff-stat">
          <span className="add">+{file.additions ?? 0}</span>{" "}
          <span className="del">−{file.deletions ?? 0}</span>
        </p>
      </header>
      <div className="diff-body" aria-label="Diff">
        {hunks.length === 0 ? (
          <div className="diff-empty"><p>No files loaded.</p></div>
        ) : hunks.map((hk, index) => (
          <div key={`${hk.header}-${index}`}>
            {hk.header ? <div className="diff-hunk-head"><span className="diff-hunk-meta">{hk.header}</span></div> : null}
            {hk.rows.map((row, rowIndex) => (
              <div className={`diff-line ${row.type}`} key={`${index}-${rowIndex}`}>
                <span className="ln old">{row.oldNo}</span>
                <span className="ln new">{row.newNo}</span>
                <span className="gutter" aria-hidden="true">{row.mark}</span>
                <span className="code">{row.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function IssueList({ issues, pending, error }: { issues: GithubPullDetail["issues"]; pending: boolean; error: unknown }) {
  if (pending) return <p className="muted">Loading issues…</p>;
  if (error) return <p className="muted">Could not load issues. {errorText(error)}</p>;
  if (issues.length === 0) return <p className="muted">No linked issue.</p>;
  return (
    <ul>
      {issues.map((issue) => (
        <li key={issue.number}>
          <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number} {issue.title}</a> <span className="state-chip">{issue.state}</span>
        </li>
      ))}
    </ul>
  );
}

function CheckRow({ check }: { check: CheckResult }) {
  const tone = check.result === "unconfirmed" ? "wait" : check.result;
  return (
    <li className={`verdict-check check-item ${tone}`}>
      <strong>{check.check}</strong>
      <span className="muted">{check.kind}</span>
      <span className="check-result">{check.result}</span>
      {check.reason ? <span className="check-fact">{check.reason}</span> : null}
      {check.evidence.map((line) => <span className="check-fact mono small-text" key={line}>{line}</span>)}
    </li>
  );
}

function CheckList({ checks, fallback }: { checks: CheckResult[]; fallback: string[] }) {
  if (checks.length === 0) {
    return fallback.length === 0 ? <p className="muted">No triage findings.</p> : <ul>{fallback.map((reason) => <li key={reason}>{reason}</li>)}</ul>;
  }
  const open = checks.filter((c) => c.result === "fail").concat(checks.filter((c) => c.result === "unconfirmed"));
  const passed = checks.filter((c) => c.result === "pass");
  return (
    <>
      {open.length > 0 ? <ul className="verdict-checks">{open.map((c) => <CheckRow key={c.check} check={c} />)}</ul> : null}
      {passed.length > 0 ? (
        <details className="check-group">
          <summary>{passed.length} checks passed</summary>
          <ul className="verdict-checks">{passed.map((c) => <CheckRow key={c.check} check={c} />)}</ul>
        </details>
      ) : null}
    </>
  );
}

function About({ item, floor }: { item: PrItem; floor: number }) {
  const { snapshot } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const pr = pull.data?.pr;
  const checks = (pull.data?.checks ?? []).map((row) => ({ name: row.name, status: row.conclusion ?? row.status }));
  const approvals = [...new Set((pull.data?.reviews ?? []).filter((row) => row.state.toUpperCase() === "APPROVED").map((row) => row.reviewer))];
  const issues = pull.data?.issues ?? [];
  const title = pr?.title ?? item.title ?? item.key;
  const author = pr?.author ?? item.author;
  const draft = pr?.draft ?? item.draft;
  const fileCount = pr?.changedFiles ?? null;
  const fail = checks.filter((row) => /fail/i.test(row.status)).length;
  const wait = checks.filter((row) => /pend|wait|progress|queued/i.test(row.status)).length;
  const pass = checks.filter((row) => /pass|success/i.test(row.status)).length;
  const pending = pull.isPending && pull.fetchStatus !== "idle";
  const repo = snapshot?.repos.find((row) => row.name === item.repo);
  const low = item.confidence !== null && item.confidence < floor;
  return (
    <article className="pr-overview" aria-label="About">
      <header className="brief brief-lead">
        <h1>{title}</h1>
        <p className="verdict-why">{item.evidence[0] ?? item.nextAction ?? "No evidence recorded."}</p>
        {item.comment ? <pre className="mono small-text">{item.comment}</pre> : null}
        {low ? (
          <p role="note" className="badge attention">
            Needs review. {scoreText(item, floor)}. No GitHub comment was posted.
          </p>
        ) : null}
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
          {draft === null ? null : <div><dt>Ready</dt><dd>{draft ? "Draft" : "Ready for review"}</dd></div>}
        </dl>
      </section>
      <section className="brief">
        <h2>Issue</h2>
        <IssueList issues={issues} pending={pending} error={pull.error} />
      </section>
      <section className="brief">
        <h2>Repository</h2>
        <dl className="facts">
          <div><dt>Repo</dt><dd className="mono">{item.repo}</dd></div>
          <div><dt>Posting</dt><dd>{repo?.cleanupMode === "automated" ? "Automated" : "Human approved"}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>Status</h2>
        <dl className="facts">
          <div><dt>Workflow</dt><dd>{QUEUE_STATE_LABEL[item.state]}</dd></div>
          <div><dt>Priority</dt><dd>{item.priority ?? "Unset"}</dd></div>
          <div><dt>Owner</dt><dd>{item.owner ?? "Unassigned"}</dd></div>
          <div><dt>Next</dt><dd className="soft">{item.nextAction ?? "No next action recorded."}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>CI</h2>
        {pending ? <p className="muted">Loading checks…</p> : pull.error ? <p className="muted">Could not load checks.</p> : checks.length === 0 ? <p className="muted">No checks reported.</p> : (
          <>
          <p className="check-counts">
            <span className="fail">{fail} fail</span>
            <span className="wait">{wait} wait</span>
            <span className="pass">{pass} pass</span>
          </p>
          <div className="brief-chips">
            {checks.map((job) => (
              <span className="state-chip" key={job.name}>{job.name} · {job.status}</span>
            ))}
          </div>
          </>
        )}
      </section>
      <section className="brief">
        <h2>Reviews</h2>
        <dl className="facts">
          <div><dt>Requested</dt><dd>{pr ? (pr.requestedReviewers > 0 ? `${pr.requestedReviewers} requested` : "None requested") : pending ? "Loading…" : "Unavailable"}</dd></div>
          <div><dt>Approvals</dt><dd>{approvals.join(", ") || (pending ? "Loading…" : pull.error ? "Unavailable" : "None yet")}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>Checks</h2>
        <CheckList checks={item.checks} fallback={item.evidence} />
        {item.labels.length > 0 && (
          <div className="row wrap">
            {item.labels.map((label) => <span key={label} className="badge">{label}</span>)}
          </div>
        )}
      </section>
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
      await writeGithub({ action: "reply", repo: item.repo, number: item.number, body });
      if (item.labels.length > 0) await writeGithub({ action: "labels", repo: item.repo, number: item.number, labels: item.labels });
      onPosted();
      await queryClient.invalidateQueries({ queryKey: ["github-pull"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
          {item.labels.map((label) => <span className="chip" key={label}>{label}</span>)}
        </div>
      ) : null}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="pr-actions-row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void post()}>Post</button>
        <button type="button" className="btn" disabled={busy} onClick={onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}

export default function PRDetail() {
  const params = useParams();
  const { snapshot, decide, closeDuplicate, writeGithub, readOnly } = usePortal();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SliverTab>("about");
  const [filePath, setFilePath] = useState("");
  const [composer, setComposer] = useState<null | { kind: "comment" | "approve" | "changes"; body: string }>(null);
  const id = params.id ?? params.number ?? "";
  const queueItems = usePullRequestItems();
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
  const floor = snapshot?.config?.confidenceFloor ?? 0.7;
  const mergeable = pull.data?.pr.mergeable ?? item?.mergeable ?? null;
  const closed = pull.data?.pr.state === "closed";
  const canMerge = mergeable === true && (pull.data?.pr.draft ?? item?.draft) !== true;
  const [handled, setHandled] = useState<Record<string, "posted" | "dismissed">>({});
  const head = pull.data?.pr.sha ?? item?.sha ?? "";
  const handledKey = `${item?.key}@${head}`;
  const repoRecord = snapshot?.repos.find((row) => row.name === item?.repo);
  const recommended = item?.comment?.trim() ?? "";
  const showRecommended = Boolean(
    recommended && item?.number && !closed && !readOnly && repoRecord?.cleanupMode !== "automated" && handled[handledKey] !== "dismissed",
  );
  const recommendedPosted = handled[handledKey] === "posted" || comments.some((comment) => comment.body.includes(recommended));
  const moreRef = useRef<HTMLDetailsElement>(null);

  async function act(decision: "once" | "deny") {
    if (!approval) return;
    setBusy(true);
    try {
      setError("");
      await decide(approval.id, decision);
    } catch (cause) {
      setError(`Could not update the approval. ${cause instanceof Error ? cause.message : String(cause)} Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function requestClose() {
    if (!item) return;
    setBusy(true);
    try {
      setError("");
      await closeDuplicate(item);
    } catch (cause) {
      setError(`Could not request the close. ${cause instanceof Error ? cause.message : String(cause)} Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function requestWrite(kind: "comment" | "approve" | "changes" | "merge" | "close") {
    if (!item || item.number === null) return;
    moreRef.current?.removeAttribute("open");
    if (kind === "comment" || kind === "approve" || kind === "changes") {
      setComposer({ kind, body: composer?.kind === kind ? composer.body : "" });
      return;
    }
    setBusy(true);
    try {
      setError("");
      if (kind === "merge") {
        await writeGithub({ action: "merge", repo: item.repo, number: item.number });
      } else {
        await writeGithub({
          action: "close",
          repo: item.repo,
          number: item.number,
          labels: item.labels,
          comment: item.comment ?? "",
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        await writeGithub({ action: "comment", repo: item.repo, number: item.number, body });
      } else {
        await writeGithub({
          action: "review",
          repo: item.repo,
          number: item.number,
          event: composer.kind === "approve" ? "APPROVE" : "REQUEST_CHANGES",
          body,
        });
      }
      setComposer(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
          <Link className="btn ghost" to="/inbox">Back</Link>
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
          <Link className="btn ghost" to="/inbox">Back</Link>
          <h1 tabIndex={-1}>Pull request</h1>
        </header>
        <main id="main" className="scroller">
          {denied ? <DeniedNotice section="approvals" /> : loading ? null : <div className="empty">Unknown pull request.</div>}
        </main>
      </div>
    );
  }

  const github = item.number ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  let pane: ReactNode = <About item={item} floor={floor} />;
  const loadState = pullPending
    ? <p className="muted">Loading from GitHub…</p>
    : pull.error ? <p role="alert" className="error">Could not load from GitHub. {errorText(pull.error)}</p> : null;
  if (tab === "files") {
    pane = loadState ? <div className="diff-empty">{loadState}</div>
      : files.length ? <DiffViewer file={selected} /> : <div className="diff-empty"><p>No files changed.</p></div>;
  }
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
    pane = <div className="pr-pane" aria-label="Issue"><h1>Issue</h1><IssueList issues={pull.data?.issues ?? []} pending={pullPending} error={pull.error} /></div>;
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
          <Link className="btn ghost" to="/inbox">Back</Link>
          <div className="pr-id">
            <p className="pr-id-line">
              <span className="mono pr-repo">{item.repo}</span>
              <strong className="pr-num">{item.number ? `#${item.number}` : ""}</strong>
            </p>
            <div className="pr-id-row">
              <span className={`pri ${(item.priority ?? "").toLowerCase()}`}>{item.priority ?? "—"}</span>
              <span className="state-chip">{QUEUE_STATE_LABEL[item.state]}</span>
              {closed ? <span className="state-chip">{pull.data?.pr.merged ? "Merged" : "Closed"}</span>
                : mergeable === null ? null : <span className="state-chip">{mergeable ? "Mergeable" : "Not mergeable"}</span>}
              <span className="state-chip">{scoreText(item, floor)}</span>
              {github ? <a className="ghost-link" href={github} target="_blank" rel="noreferrer">View on GitHub</a> : null}
            </div>
          </div>
          <div className="pr-actions">
            <div className="pr-actions-row">
              {pending ? (
                <>
                  {closed ? null : <button type="button" className={`btn${gated ? " primary" : ""}`} disabled={busy || readOnly} onClick={() => void act("once")}>Confirm</button>}
                  <button type="button" className="btn" disabled={busy || readOnly} onClick={() => void act("deny")}>Dismiss</button>
                </>
              ) : null}
              {closed ? null : (
                <>
                  {item.canClose ? (
                    <button type="button" className="btn" disabled={item.pendingClose || busy || readOnly} onClick={() => void requestClose()}>Close as duplicate</button>
                  ) : null}
                  <button type="button" className="btn" disabled={!item.number || busy || readOnly} onClick={() => void requestWrite("comment")}>Comment</button>
                  <button type="button" className={`btn${canMerge && !gated ? " primary" : ""}`} disabled={!item.number || !canMerge || busy || readOnly} onClick={() => void requestWrite("merge")}>Merge</button>
                  <details className="more-menu" ref={moreRef}>
                    <summary className="btn" aria-label="More actions">More</summary>
                    <div className="more-menu-list" role="menu">
                      <button type="button" role="menuitem" disabled={!item.number || busy || readOnly} onClick={() => void requestWrite("approve")}>Approve</button>
                      <button type="button" role="menuitem" disabled={!item.number || busy || readOnly} onClick={() => void requestWrite("changes")}>Request changes</button>
                      <button type="button" role="menuitem" disabled={!item.number || busy || readOnly} onClick={() => void requestWrite("close")}>Close pull request</button>
                    </div>
                  </details>
                </>
              )}
            </div>
          </div>
        </header>
        {composer ? (
          <form className="pr-composer" onSubmit={submitComposerForm}>
            <textarea
              value={composer.body}
              onChange={(event) => setComposer({ ...composer, body: event.target.value })}
              placeholder={composer.kind === "approve" ? "Optional review comment" : "Write a comment"}
              required={composer.kind !== "approve"}
              rows={3}
            />
            <div className="pr-actions-row">
              <button type="submit" className="btn primary" disabled={busy || readOnly}>Send</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setComposer(null)}>Cancel</button>
            </div>
          </form>
        ) : null}
        {showRecommended ? (
          <RecommendedComment
            key={`${handledKey}@${item.runId}`}
            item={item}
            posted={recommendedPosted}
            onPosted={() => setHandled({ ...handled, [handledKey]: "posted" })}
            onDismiss={() => setHandled({ ...handled, [handledKey]: "dismissed" })}
          />
        ) : null}
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
          {tab === "files" ? (
            loadState
              ? <p className="sliver-empty">{pullPending ? "Loading files…" : "Could not load files."}</p>
              : files.length === 0
                ? <p className="sliver-empty">No files changed.</p>
                : <div className="sliver-list">
                    {files.map((file) => (
                      <button type="button" className={`sliver-file${selected?.path === file.path ? " is-on" : ""}`} key={file.path} onClick={() => selectFile(file.path)}>
                        <span className="sliver-file-name">{file.path}</span>
                      </button>
                    ))}
                  </div>
          ) : tab === "commits" ? (
            <p className="sliver-empty">{pullPending ? "Loading commits…" : pull.error ? "Could not load commits." : `${commits.length} commits`}</p>
          ) : tab === "issue" ? (
            <p className="sliver-empty">{pullPending ? "Loading issues…" : pull.error ? "Could not load issues." : `${pull.data?.issues.length ?? 0} linked issues`}</p>
          ) : tab === "conversation" ? (
            <p className="sliver-empty">{pullPending ? "Loading conversation…" : pull.error ? "Could not load conversation." : `${comments.length} comments`}</p>
          ) : (
            <p className="sliver-empty">Overview of this pull request.</p>
          )}
        </div>
      </aside>
    </>
  );
}
