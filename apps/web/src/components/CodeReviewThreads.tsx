import { errorText } from "@corbits/common";
import { BUDGET_EXHAUSTED_NOTE, INCOMPLETE_NOTE, UNVERIFIED_FINDING } from "@corbits/triage-contracts";
import { useCodeReview, useReviewAgain, useSendCodeReview } from "../lib/code-review.ts";
import { useCodeReviewOn } from "../lib/check-packs.ts";
import { useGithubPull } from "../lib/github-pull.ts";
import { relativeTime } from "../lib/duration.ts";
import type { CodeReviewComment, CodeReviewRun, PrItem } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { hostName } from "../lib/pull-link.ts";
import { Markdown } from "./Markdown.tsx";

type Reviewed = Pick<PrItem, "repo" | "source" | "headSha" | "draft" | "verdictSha" | "codeReviewSkipped" | "awaiting"> & { number: number };

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function hint(review: CodeReviewRun, completed: CodeReviewRun | null): string {
  if (review.status === "running") return `Reviewing ${shortSha(review.headSha)}…`;
  if (review.status === "failed") return "The last review did not finish";
  const count = completed?.comments?.length ?? 0;
  if (count === 0) return "No findings";
  return count === 1 ? "1 finding" : `${count} findings`;
}

function location({ path, start, end }: CodeReviewComment): string {
  return end > start ? `${path}:${start}–${end}` : `${path}:${start}`;
}

function QuotedCode({ comment }: { comment: CodeReviewComment }) {
  if (!comment.quoted) return null;
  const lines = comment.quoted.replace(/\n$/, "").split("\n");
  return (
    <pre className="cr-code">
      {lines.map((line, index) => <span key={index}><i>{comment.start + index}</i>{line}</span>)}
    </pre>
  );
}

/** Each finding is the first comment of its own thread, so replies can follow it. */
function Thread({ comment, review }: { comment: CodeReviewComment; review: CodeReviewRun }) {
  return (
    <li className="thread">
      <div className="cmt">
        <span className="av bot"><img src="/corbits-mark.svg" alt="" /></span>
        <div className="cmt-b">
          <div className="byline">
            <span className="who"><span className="nm">Code review</span><span className="tag">Bot</span></span>
            <span>reviewed <span className="mono">{shortSha(review.headSha)}</span></span>
            <span>{relativeTime(review.startedAt)}</span>
          </div>
          <p className="pb-w">{comment.title}</p>
          <Markdown text={comment.body} />
          <p className="pb-c">
            {comment.priority === undefined ? null : <b>P{comment.priority}</b>}
            <span className="mono">{location(comment)}</span>
            {comment.unverified ? <span>{UNVERIFIED_FINDING}</span> : null}
          </p>
          <QuotedCode comment={comment} />
        </div>
      </div>
    </li>
  );
}

/**
 * "Send to GitHub" for the finished review, at the head it was carried over to if any, or that it was sent: a review sent
 * before it was carried over stays on the unchanged lines, so it is not sent again.
 */
function SendToGithub({ item, completed, carriedTo, send }: { item: Reviewed; completed: CodeReviewRun; carriedTo: string | null; send: ReturnType<typeof useSendCodeReview> }) {
  const { readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const heads = [completed.headSha, carriedTo];
  const sent = pull.data?.reviews.some((review) => review.codeReview === true && heads.includes(review.commitId)) === true;
  if (sent) return <span className="hint">Sent to GitHub</span>;
  return <button type="button" className="linkish" disabled={readOnly || pull.isPending || send.isPending} onClick={() => send.mutate(carriedTo ?? completed.headSha)}>Send to GitHub</button>;
}

/** "Send to Bitbucket": sending it again posts only what is missing, so the button stays until a send answers. */
function SendToBitbucket({ completed, carriedTo, send }: { completed: CodeReviewRun; carriedTo: string | null; send: ReturnType<typeof useSendCodeReview> }) {
  const { readOnly } = usePortal();
  if (send.isSuccess) return <span className="hint">Sent to Bitbucket</span>;
  return <button type="button" className="linkish" disabled={readOnly || send.isPending} onClick={() => send.mutate(carriedTo ?? completed.headSha)}>Send to Bitbucket</button>;
}

function SendReview({ item, completed, carriedTo, send }: { item: Reviewed; completed: CodeReviewRun; carriedTo: string | null; send: ReturnType<typeof useSendCodeReview> }) {
  if (item.source === "bitbucket-datacenter") return <SendToBitbucket completed={completed} carriedTo={carriedTo} send={send} />;
  return <SendToGithub item={item} completed={completed} carriedTo={carriedTo} send={send} />;
}

/**
 * The pull request's code review once there is one; before it, why its head was left out, or that it is awaited while the
 * hub waits on it or the policy file turns it on. Review again on a reviewed pull request that is not a draft while code
 * review has a place to run.
 */
export function CodeReviewThreads({ item }: { item: Reviewed }) {
  const { snapshot, readOnly } = usePortal();
  const reviews = useCodeReview(item).data;
  const again = useReviewAgain(item);
  const send = useSendCodeReview(item);
  const policyOn = useCodeReviewOn(item.repo, item.source);
  const skipped = item.codeReviewSkipped !== undefined && !again.isSuccess && reviews?.review?.headSha !== item.verdictSha;
  const awaited = item.awaiting.includes("code-review") || (policyOn && item.draft !== true);
  if (!reviews || (!reviews.review && !skipped && !awaited)) return null;
  const { review, completed, carriedTo } = reviews;
  const askable = Boolean(snapshot?.codeReviewPlace) && item.draft !== true && Boolean(review);

  if (!review && !skipped) return <section className="code-review" aria-label="Code review"><h3 className="lbl-h">Code review: awaited</h3></section>;

  return (
    <section className="code-review" aria-label="Code review">
      <h3 className="lbl-h">
        Code review<span className="hint">{review ? hint(review, completed) : "Not reviewed"}</span>
        <span className="sp" />
        {completed ? <SendReview item={item} completed={completed} carriedTo={carriedTo} send={send} /> : null}
        {askable ? <button type="button" className="linkish" disabled={readOnly || again.isPending} onClick={() => again.mutate()}>Review again</button> : null}
      </h3>
      {again.error ? <p role="alert" className="error">Could not review again. {errorText(again.error)}</p> : null}
      {send.error ? <p role="alert" className="error">Could not send to {hostName(item.source)}. {errorText(send.error)}</p> : null}
      {skipped ? <p className="note">Not reviewed: {item.codeReviewSkipped}.{completed ? ` The review below is of ${shortSha(completed.headSha)}.` : null}</p> : null}
      {completed && carriedTo ? <p className="note">Carried over from {shortSha(completed.headSha)}: the new commits leave the diff as it was reviewed.</p> : null}
      {completed?.summary ? <p className="cr-summary">{completed.summary}</p> : null}
      {completed?.budgetExhausted ? <p className="note">{BUDGET_EXHAUSTED_NOTE}</p> : null}
      {completed && completed.complete !== true ? <p className="note">{INCOMPLETE_NOTE}</p> : null}
      {completed?.comments?.length ? <ol className="threads">{completed.comments.map((comment, index) => <Thread key={index} comment={comment} review={completed} />)}</ol> : null}
    </section>
  );
}
