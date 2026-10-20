import { errorText } from "@corbits/common";
import { BUDGET_EXHAUSTED_NOTE, UNVERIFIED_FINDING } from "@corbits/triage-contracts";
import { useCodeReview, useReviewAgain, useSendCodeReview } from "../lib/code-review.ts";
import { useGithubPull } from "../lib/github-pull.ts";
import { relativeTime } from "../lib/duration.ts";
import type { CodeReviewComment, CodeReviewRun, CodeReviews, PrItem } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { Markdown } from "./Markdown.tsx";

type Reviewed = Pick<PrItem, "repo" | "source"> & { number: number };

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function hint({ review, completed }: CodeReviews): string {
  if (!review) return "No review yet";
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

/** "Send to GitHub" for the finished review, or that it was sent; GitHub pull requests only. */
function SendToGithub({ item, completed, send }: { item: Reviewed; completed: CodeReviewRun; send: ReturnType<typeof useSendCodeReview> }) {
  const { readOnly } = usePortal();
  const pull = useGithubPull(item.repo, item.number);
  const sent = pull.data?.reviews.some((review) => review.codeReview === true && review.commitId === completed.headSha) === true;
  if (sent) return <span className="hint">Sent to GitHub</span>;
  return <button type="button" className="linkish" disabled={readOnly || pull.isPending || send.isPending} onClick={() => send.mutate(completed.headSha)}>Send to GitHub</button>;
}

/** A list of more unread files than this starts collapsed. */
const SHOWN_UNREAD = 5;

function CutNote({ cut }: { cut: NonNullable<CodeReviewRun["cut"]> }) {
  const { unread } = cut;
  const said = `Reviewed the first ${cut.lines} of ${cut.of} lines of the diff; the rest was over the size limit.`;
  if (!unread?.length) return <p className="note">{said} Some files were not reviewed.</p>;
  const heading = unread.length === 1 ? "1 file not reviewed in full" : `${unread.length} files not reviewed in full`;
  return (
    <div className="note">
      {said}
      <details open={unread.length <= SHOWN_UNREAD}>
        <summary>{heading}</summary>
        <ul className="cr-unread">{unread.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      </details>
    </div>
  );
}

/** The pull request's code review: shown once it has one, or while the repository has code review on. */
export function CodeReviewThreads({ item }: { item: Reviewed }) {
  const { snapshot, readOnly } = usePortal();
  const reviews = useCodeReview(item).data;
  const again = useReviewAgain(item);
  const send = useSendCodeReview(item);
  const on = snapshot?.repos.some((repo) => repo.name === item.repo && repo.source === item.source && repo.codeReview === true) === true;
  if (!reviews || (!on && !reviews.review)) return null;
  const { completed } = reviews;

  return (
    <section className="code-review" aria-label="Code review">
      <h3 className="lbl-h">
        Code review<span className="hint">{hint(reviews)}</span>
        <span className="sp" />
        {completed && item.source === "github" ? <SendToGithub item={item} completed={completed} send={send} /> : null}
        {on && snapshot?.codeReviewPlace ? <button type="button" className="linkish" disabled={readOnly || again.isPending} onClick={() => again.mutate()}>Review again</button> : null}
      </h3>
      {again.error ? <p role="alert" className="error">Could not review again. {errorText(again.error)}</p> : null}
      {send.error ? <p role="alert" className="error">Could not send to GitHub. {errorText(send.error)}</p> : null}
      {completed?.summary ? <p className="cr-summary">{completed.summary}</p> : null}
      {completed?.cut ? <CutNote cut={completed.cut} /> : null}
      {completed?.budgetExhausted ? <p className="note">{BUDGET_EXHAUSTED_NOTE}</p> : null}
      {completed?.comments?.length ? <ol className="threads">{completed.comments.map((comment, index) => <Thread key={index} comment={comment} review={completed} />)}</ol> : null}
    </section>
  );
}
