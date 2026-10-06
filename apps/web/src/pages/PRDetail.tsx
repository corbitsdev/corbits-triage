import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CircleDot, FileText, GitCommitVertical, Info, MessageSquare, type LucideIcon } from "lucide-react";
import { DeniedNotice } from "../lib/denied.tsx";
import { usePortal } from "../lib/portal.tsx";
import { projectQueue, QUEUE_STATE_LABEL, type PrItem } from "../lib/hub-api.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import {
  approvalHeadline,
  factsForPr,
  findPrItem,
  formatConfidence,
  relativeTime,
  type PrFileFact,
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

function DiffViewer({ file }: { file: PrFileFact | undefined }) {
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

function About({ item, floor }: { item: PrItem; floor: number }) {
  const { snapshot } = usePortal();
  const facts = snapshot && item.number !== null ? factsForPr(snapshot.logs, item.repo, item.number) : factsForPr([], item.repo, 0);
  const title = facts.title ?? item.title ?? item.key;
  const author = facts.author ?? item.author;
  const draft = facts.draft ?? item.draft;
  const fileCount = facts.changedFiles ?? (facts.files.length || null);
  const fail = facts.checks.filter((row) => /fail/i.test(row.status)).length;
  const wait = facts.checks.filter((row) => /pend|wait/i.test(row.status)).length;
  const pass = facts.checks.filter((row) => /pass|success/i.test(row.status)).length;
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
            Needs review: confidence {formatConfidence(item.confidence)} is below {formatConfidence(floor)}. No GitHub comment was posted.
          </p>
        ) : null}
      </header>
      <section className="brief">
        <h2>Pull request</h2>
        <dl className="facts">
          {author ? <div><dt>Author</dt><dd>{author}</dd></div> : null}
          <div><dt>Age</dt><dd>{relativeTime(item.waitingSince)}</dd></div>
          {facts.additions === undefined && facts.deletions === undefined ? null : (
            <div>
              <dt>Size</dt>
              <dd className="mono"><span className="add">+{facts.additions ?? 0}</span> <span className="del">−{facts.deletions ?? 0}</span></dd>
            </div>
          )}
          {fileCount === null ? null : <div><dt>Files</dt><dd>{fileCount}</dd></div>}
          {draft === null ? null : <div><dt>Ready</dt><dd>{draft ? "Draft" : "Ready for review"}</dd></div>}
        </dl>
      </section>
      <section className="brief">
        <h2>Issue</h2>
        <p className="muted">No linked issue.</p>
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
        {facts.checks.length === 0 ? <p className="muted">No checks reported.</p> : (
          <>
          <p className="check-counts">
            <span className="fail">{fail} fail</span>
            <span className="wait">{wait} wait</span>
            <span className="pass">{pass} pass</span>
          </p>
          <div className="brief-chips">
            {facts.checks.map((job) => (
              <span className="state-chip" key={job.name}>{job.name} · {job.status}</span>
            ))}
          </div>
          </>
        )}
      </section>
      <section className="brief">
        <h2>Reviews</h2>
        <dl className="facts">
          <div><dt>Requested</dt><dd>{facts.requestedReviewers.join(", ") || "None requested"}</dd></div>
          <div><dt>Approvals</dt><dd>{facts.approvals.join(", ") || "None yet"}</dd></div>
        </dl>
      </section>
      <section className="brief">
        <h2>Checks</h2>
        {item.evidence.length === 0 ? <p className="muted">No triage findings.</p> : (
          <ul>
            {item.evidence.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
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

export default function PRDetail() {
  const params = useParams();
  const { snapshot, decide, closeDuplicate, writeGithub, readOnly } = usePortal();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SliverTab>("about");
  const [filePath, setFilePath] = useState("");
  const [composer, setComposer] = useState<null | { kind: "comment" | "approve" | "changes"; body: string }>(null);
  const id = params.id ?? params.number ?? "";
  const item = snapshot ? findPrItem(projectQueue(snapshot), params) : undefined;
  const approval = snapshot?.approvals.find((row) => row.id === (item?.pendingApprovalId ?? id));
  const denied = snapshot?.denied.approvals ?? false;
  const facts = snapshot && item?.number !== null && item ? factsForPr(snapshot.logs, item.repo, item.number) : factsForPr([], "", 0);
  const selected = useMemo(() => facts.files.find((file) => file.path === filePath) ?? facts.files[0], [facts.files, filePath]);
  const pending = approval?.status.toLowerCase() === "pending";
  const gated = Boolean(item?.needsHuman && pending);
  const floor = snapshot?.config?.confidenceFloor ?? 0.7;
  const mergeable = facts.mergeable ?? item?.mergeable ?? null;
  const canMerge = mergeable === true && (facts.draft ?? item?.draft) !== true;
  const moreRef = useRef<HTMLDetailsElement>(null);
  const score = item?.confidence === null || item?.confidence === undefined
    ? "No score"
    : `${Math.round(item.confidence * 100)}/${Math.round(floor * 100)}`;

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
          <Link className="btn ghost" to="/triage/action">Back</Link>
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
          <Link className="btn ghost" to="/triage/action">Back</Link>
          <h1 tabIndex={-1}>Pull request</h1>
        </header>
        <main id="main" className="scroller">
          {denied ? <DeniedNotice section="approvals" /> : <div className="empty">Unknown pull request.</div>}
        </main>
      </div>
    );
  }

  const github = item.number ? `https://github.com/${item.repo}/pull/${item.number}` : null;
  let pane: ReactNode = <About item={item} floor={floor} />;
  if (tab === "files") pane = facts.files.length ? <DiffViewer file={selected} /> : <div className="diff-empty"><p>No files loaded.</p></div>;
  if (tab === "commits") {
    pane = (
      <div className="pr-pane" aria-label="Commits">
        <h1>Commits</h1>
        {facts.commits.length === 0 ? <p className="muted">No commits loaded.</p> : facts.commits.map((commit) => (
          <div className="commit-row" key={commit.sha}>
            <span className="mono">{commit.sha.slice(0, 7)}</span>
            <strong>{commit.message ?? commit.sha}</strong>
          </div>
        ))}
      </div>
    );
  }
  if (tab === "issue") pane = <div className="pr-pane" aria-label="Issue"><h1>Issue</h1><p className="muted">No linked issue.</p></div>;
  if (tab === "conversation") {
    pane = (
      <div className="pr-pane" aria-label="Talk">
        <h1>Talk</h1>
        {facts.comments.length === 0 ? <p className="muted">No conversation loaded.</p> : facts.comments.map((comment, index) => (
          <p key={index}><strong>{comment.author ?? "Unknown"}</strong> {comment.body}</p>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="main-shell">
        <header className="topbar pr-topbar action-bar">
          <Link className="btn ghost" to="/triage/action">Back</Link>
          <div className="pr-id">
            <p className="pr-id-line">
              <span className="mono pr-repo">{item.repo}</span>
              <strong className="pr-num">{item.number ? `#${item.number}` : ""}</strong>
            </p>
            <div className="pr-id-row">
              <span className={`pri ${(item.priority ?? "").toLowerCase()}`}>{item.priority ?? "—"}</span>
              <span className="state-chip">{QUEUE_STATE_LABEL[item.state]}</span>
              {mergeable === null ? null : <span className="state-chip">{mergeable ? "Mergeable" : "Not mergeable"}</span>}
              <span className="state-chip">{score}</span>
              {github ? <a className="ghost-link" href={github} target="_blank" rel="noreferrer">View on GitHub</a> : null}
            </div>
          </div>
          <div className="pr-actions">
            <div className="pr-actions-row">
              {pending ? (
                <>
                  <button type="button" className={`btn${gated ? " primary" : ""}`} disabled={busy || readOnly} onClick={() => void act("once")}>Confirm</button>
                  <button type="button" className="btn" disabled={busy || readOnly} onClick={() => void act("deny")}>Dismiss</button>
                </>
              ) : null}
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
            facts.files.length === 0
              ? <p className="sliver-empty">No files loaded.</p>
              : <div className="sliver-list">
                  {facts.files.map((file) => (
                    <button type="button" className={`sliver-file${selected?.path === file.path ? " is-on" : ""}`} key={file.path} onClick={() => selectFile(file.path)}>
                      <span className="sliver-file-name">{file.path}</span>
                    </button>
                  ))}
                </div>
          ) : tab === "commits" ? (
            <p className="sliver-empty">{facts.commits.length ? `${facts.commits.length} commits` : "No commits loaded."}</p>
          ) : tab === "issue" ? (
            <p className="sliver-empty">No linked issue.</p>
          ) : tab === "conversation" ? (
            <p className="sliver-empty">{facts.comments.length ? `${facts.comments.length} comments` : "No conversation loaded."}</p>
          ) : (
            <p className="sliver-empty">Overview of this pull request.</p>
          )}
        </div>
      </aside>
    </>
  );
}
