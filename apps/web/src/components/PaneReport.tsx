import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { Button, Skeleton, Table, TableBody, TableCell, TableRow } from "@corbits/react-ui";
import { BUILT_IN_CHECK_NAMES, isCatalogId, type CheckPack } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, PrItem } from "../lib/hub-api.ts";
import { checkLimitText } from "../lib/check-limit.ts";
import { errorText } from "@corbits/common";
import { linearIssues } from "../lib/linked-issue.ts";
import { checkLabel } from "../lib/pack-prose.ts";
import { heldText, lineText, passedChecks, type HeldChoice, type PaneStatus, type Problem, type Severity } from "../lib/pane-report.ts";
import { checkMeasuredText, prHref } from "../lib/triage-view.ts";
import { CitedEvidence } from "./CitedEvidence.tsx";
import { DetailsBoundary } from "./DetailsBoundary.tsx";
import { ChevronIcon } from "./inbox-icons.tsx";
import { Markdown } from "./Markdown.tsx";

export type PullState = { data: GithubPullDetail | undefined; loading: boolean; error: unknown };

/** Labels in the status line's words, read out but not shown since the status line already says them; a failed rule is the author's to fix only once it is their turn. */
const MARK: Record<Severity, { className: string; glyph: string; label: string }> = {
  fail: { className: "mk flag", glyph: "!", label: "Not met" },
  unsure: { className: "mk judge", glyph: "?", label: "Decide" },
  cant: { className: "mk cant", glyph: "–", label: "Couldn't check" },
};

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The rule's name, then why; a reason that already opens with the name as a word is shown alone, so the row never repeats itself. */
function problemText(name: string, reason: string | null): string {
  if (reason === null) return name;
  const opensWithName = reason.toLowerCase().startsWith(name.toLowerCase()) && /^(?:$|[\s\p{P}])/u.test(reason.slice(name.length));
  return opensWithName ? sentence(reason) : `${name}: ${sentence(reason)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function StatusLine({ status }: { status: PaneStatus }) {
  return (
    <p className={`st3 t-${status.tone}`} role="status">
      <span className={status.live ? "dot live" : "dot"} />
      <span>{lineText(status)}</span>
    </p>
  );
}

type HeldActionsProps = { held: HeldChoice[]; doBlocked: boolean; onApprove: (choice: HeldChoice) => void; onHide: (() => void) | null };

/** Each held action under the status line, with why it is held and its approve button; Hide for me hides them in this browser. */
export function HeldActions({ held, doBlocked, onApprove, onHide }: HeldActionsProps) {
  if (held.length === 0) return null;
  return (
    <div className="held">
      <ul aria-label="Held actions">
        {held.map((choice) => (
          <li key={choice.pending.key}>
            <span className="held-what">
              {heldText(choice.pending)}
              {choice.pending.until === null ? <span className="held-why">{choice.pending.reason}</span> : null}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={choice.entry === null ? doBlocked : choice.entry.blocker !== null} onClick={() => onApprove(choice)}>Approve</Button>
          </li>
        ))}
      </ul>
      {onHide === null ? null : <Button type="button" variant="ghost" size="sm" onClick={onHide}>Hide for me</Button>}
    </div>
  );
}

type ProblemsProps = { problems: Problem[]; pack: CheckPack | null; item: PrItem; authorsTurn: boolean };

function ProblemRow({ problem, pack, item, authorsTurn }: Omit<ProblemsProps, "problems"> & { problem: Problem }) {
  const { check, severity, cited, notes } = problem;
  const mark = MARK[severity];
  const label = severity === "fail" && authorsTurn ? "To fix" : mark.label;
  const name = checkLabel(pack, check.check) ?? check.check;
  const text = problemText(name, problem.text);
  return (
    <li className={`pb s-${severity}`}>
      <span className={mark.className} aria-hidden="true">{mark.glyph}</span>
      <div>
        <p className="pb-w"><span className="sr-only">{label}: </span>{text}</p>
        {cited.length > 0 ? (
          <p className="pb-c">{cited.map((evidence) => <span key={evidence} className="mono"><CitedEvidence text={evidence} output={check.output} source={item.source} repo={item.repo} sha={item.verdictSha} /></span>)}</p>
        ) : null}
        {notes.length > 0 ? <p className="pb-n">{notes.join("; ")}</p> : null}
      </div>
    </li>
  );
}

export function Problems({ problems, pack, item, authorsTurn }: ProblemsProps) {
  if (problems.length === 0) return null;
  return <ol className="pbs">{problems.map((problem) => <ProblemRow key={problem.check.check} problem={problem} pack={pack} item={item} authorsTurn={authorsTurn} />)}</ol>;
}

function Disclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className="dr" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <ChevronIcon />
        <span>{label}</span>
      </button>
      <div id={id} className="dr-b" hidden={!open}>
        {open ? <DetailsBoundary>{children}</DetailsBoundary> : null}
      </div>
    </>
  );
}

function descClass(expanded: boolean, long: boolean): string {
  if (expanded) return "desc-t";
  if (long) return "desc-t clamp fade";
  return "desc-t clamp";
}

/** The author's own account, open above the folds; a long one shows its first part until expanded. */
export function Description({ pull }: { pull: PullState }) {
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const body = pull.data?.pr.body?.trim() ? pull.data.pr.body : null;

  useLayoutEffect(function measureOverflow() {
    const node = textRef.current;
    if (node === null || expanded) return;
    const measure = () => setLong(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [body, expanded]);

  /** Collapsing a long description can leave its top above the fold; bring it back only then. */
  function toggle() {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    flushSync(() => setExpanded(false));
    sectionRef.current?.scrollIntoView({ block: "nearest" });
  }

  if (pull.loading) {
    return (
      <section className="desc" aria-hidden="true">
        <Skeleton className="desc-sk" />
        <Skeleton className="desc-sk" />
        <Skeleton className="desc-sk short" />
      </section>
    );
  }
  if (pull.data === undefined) return null;
  if (body === null) {
    return (
      <section ref={sectionRef} className="desc" aria-label="Description">
        <p className="none">No description.</p>
      </section>
    );
  }
  return (
    <section ref={sectionRef} className="desc" aria-label="Description">
      <div id={id} ref={textRef} className={descClass(expanded, long)}>
        <Markdown text={body} />
      </div>
      {(long || expanded) && (
        <button type="button" className="desc-more" aria-expanded={expanded} aria-controls={id} onClick={toggle}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}

function LinkedIssues({ detail }: { detail: GithubPullDetail }) {
  const linear = linearIssues(detail);
  if (detail.issues.length + linear.length === 0) return <p className="none">None found.</p>;
  return (
    <>
      {detail.issues.map((issue) => (
        <article key={issue.number} className="issue">
          <p className="it"><a href={issue.url} target="_blank" rel="noopener noreferrer">#{issue.number} {issue.title}</a> <span>{issue.state}</span></p>
          {issue.body?.trim() ? <Markdown text={issue.body} /> : null}
        </article>
      ))}
      {linear.map((issue) => (
        <p key={issue.key} className="it"><a className="mono" href={issue.url} target="_blank" rel="noopener noreferrer">{issue.key}</a> <span>Linear</span></p>
      ))}
    </>
  );
}

function issueLabel(detail: GithubPullDetail): ReactNode {
  const [issue] = detail.issues;
  const key = issue === undefined ? linearIssues(detail)[0]?.key : `#${issue.number}`;
  return key === undefined ? "Linked issue" : <>Linked issue <span className="mono">{key}</span></>;
}

function Files({ files, changed }: { files: GithubPullDetail["files"]; changed: number }) {
  return (
    <Table className="tbl">
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.path}>
            <TableCell className="mono path">{file.path}</TableCell>
            <TableCell className="r mono"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></TableCell>
          </TableRow>
        ))}
        {changed > files.length ? <TableRow><TableCell colSpan={2}>and {changed - files.length} more</TableCell></TableRow> : null}
      </TableBody>
    </Table>
  );
}

function passedText(check: CheckResult, pack: CheckPack | null): string {
  const measured = isCatalogId(check.check) || BUILT_IN_CHECK_NAMES.has(check.check) ? checkMeasuredText(check.output) : null;
  const text = measured ?? check.reason ?? "";
  const parts = check.gate ? ["Matched", text] : [text, checkLimitText(pack, check)];
  return parts.filter(Boolean).join(" · ");
}

function Passed({ checks, pack }: { checks: CheckResult[]; pack: CheckPack | null }) {
  return (
    <Table className="tbl">
      <TableBody>
        {checks.map((check) => (
          <TableRow key={check.check}>
            <TableCell>{checkLabel(pack, check.check)}</TableCell>
            <TableCell>{passedText(check, pack)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PullStatus({ pull }: { pull: PullState }) {
  if (pull.loading) return <p className="none">Reading the pull request from GitHub…</p>;
  if (pull.error) return <p className="none">Could not read the pull request from GitHub. {errorText(pull.error)}</p>;
  return null;
}

export function ReportRows({ item, pull, pack }: { item: PrItem; pull: PullState; pack: CheckPack | null }) {
  const detail = pull.data;
  const passed = passedChecks(item.checks);
  return (
    <div className="disc3">
      {detail === undefined ? <PullStatus pull={pull} /> : (
        <>
          <Disclosure label={issueLabel(detail)}><LinkedIssues detail={detail} /></Disclosure>
          <Disclosure label={plural(detail.pr.changedFiles, "file", "files")}><Files files={detail.files} changed={detail.pr.changedFiles} /></Disclosure>
        </>
      )}
      {passed.length > 0 ? <Disclosure label={`Checked and fine: ${plural(passed.length, "rule", "rules")}`}><Passed checks={passed} pack={pack} /></Disclosure> : null}
      <Link className="more" to={prHref(item)}>Commits and conversation</Link>
    </div>
  );
}
