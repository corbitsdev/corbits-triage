import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { Skeleton } from "@corbits/react-ui";
import type { CheckPack } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, PrItem } from "../lib/hub-api.ts";
import { checkLimitText } from "../lib/check-limit.ts";
import { errorText } from "../lib/error-text.ts";
import { linearIssues } from "../lib/linked-issue.ts";
import { checkLabel, isCatalogId } from "../lib/pack-prose.ts";
import { passedChecks, type PaneStatus, type Problem, type Severity } from "../lib/pane-report.ts";
import { checkMeasuredText, prHref } from "../lib/triage-view.ts";
import { CitedEvidence } from "./CitedEvidence.tsx";
import { DetailsBoundary } from "./DetailsBoundary.tsx";
import { ChevronIcon } from "./inbox-icons.tsx";
import { Markdown } from "./Markdown.tsx";

export type PullState = { data: GithubPullDetail | undefined; loading: boolean; error: unknown };

const MARK: Record<Severity, { className: string; glyph: string; label: string }> = {
  fail: { className: "mk flag", glyph: "!", label: "To fix" },
  unsure: { className: "mk judge", glyph: "?", label: "Your call" },
  cant: { className: "mk cant", glyph: "–", label: "Couldn't check" },
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function StatusLine({ status }: { status: PaneStatus }) {
  return (
    <p className={`st3 t-${status.tone}`} role="status">
      <span className={status.live ? "dot live" : "dot"} />
      <span>{status.text}</span>
    </p>
  );
}

function ProblemRow({ problem, pack, repo, sha }: { problem: Problem; pack: CheckPack | null; repo: string; sha: string | null }) {
  const { check, severity, cited, notes } = problem;
  const mark = MARK[severity];
  const text = problem.text ?? checkLabel(pack, check.check) ?? check.check;
  return (
    <li className={`pb s-${severity}`}>
      <span className={mark.className} aria-hidden="true">{mark.glyph}</span>
      <div>
        <p className="pb-w">{severity === "unsure" ? <b>{mark.label}: </b> : <span className="sr-only">{mark.label}: </span>}{text}</p>
        {cited.length > 0 ? (
          <p className="pb-c">{cited.map((evidence) => <span key={evidence} className="mono"><CitedEvidence text={evidence} output={check.output} repo={repo} sha={sha} /></span>)}</p>
        ) : null}
        {notes.length > 0 ? <p className="pb-n">{notes.join("; ")}</p> : null}
      </div>
    </li>
  );
}

/** Only what stands in the way; a pull request with nothing in the way shows no list. */
export function Problems({ problems, pack, item }: { problems: Problem[]; pack: CheckPack | null; item: PrItem }) {
  if (problems.length === 0) return null;
  return <ol className="pbs">{problems.map((problem) => <ProblemRow key={problem.check.check} problem={problem} pack={pack} repo={item.repo} sha={item.verdictSha} />)}</ol>;
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
  return (
    <section ref={sectionRef} className="desc" aria-label="Description">
      {body === null ? <p className="none">No description.</p> : (
        <>
          <div id={id} ref={textRef} className={expanded ? "desc-t" : `desc-t clamp${long ? " fade" : ""}`}>
            <Markdown text={body} />
          </div>
          {long || expanded ? (
            <button type="button" className="desc-more" aria-expanded={expanded} aria-controls={id} onClick={toggle}>
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
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
    <table className="tbl">
      <tbody>
        {files.map((file) => (
          <tr key={file.path}>
            <td className="mono path">{file.path}</td>
            <td className="r mono">+{file.additions} −{file.deletions}</td>
          </tr>
        ))}
        {changed > files.length ? <tr><td colSpan={2}>and {changed - files.length} more</td></tr> : null}
      </tbody>
    </table>
  );
}

/** A passed check's measure and limit, or a matched gate, on one line. */
function passedText(check: CheckResult, pack: CheckPack | null): string {
  const measured = isCatalogId(check.check) ? checkMeasuredText(check.output) : null;
  const text = measured ?? check.reason ?? "";
  const parts = check.gate ? ["Matched", text] : [text, checkLimitText(pack, check)];
  return parts.filter(Boolean).join(" · ");
}

function Passed({ checks, pack }: { checks: CheckResult[]; pack: CheckPack | null }) {
  return (
    <table className="tbl">
      <tbody>
        {checks.map((check) => (
          <tr key={check.check}>
            <td>{checkLabel(pack, check.check)}</td>
            <td>{passedText(check, pack)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PullStatus({ pull }: { pull: PullState }) {
  if (pull.loading) return <p className="none">Reading the pull request from GitHub…</p>;
  if (pull.error) return <p className="none">Could not read the pull request from GitHub. {errorText(pull.error)}</p>;
  return null;
}

/** What Triage read, folded away: the linked issue, the changed files and the checks that passed. */
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
      {passed.length > 0 ? <Disclosure label={`${plural(passed.length, "check", "checks")} passed`}><Passed checks={passed} pack={pack} /></Disclosure> : null}
      <Link className="more" to={prHref(item)}>Commits and conversation</Link>
    </div>
  );
}
