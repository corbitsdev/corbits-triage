import { errorText } from "@corbits/common";
import { ACTION_KINDS, type ActionKind, type ResolvedTarget } from "@corbits/triage-contracts";
import { type } from "arktype";
import { checkRepo } from "@corbits/repo-read-tool/host-reads";
import {
  ciRefusal,
  codeownersForPr,
  getChecks,
  getReviews,
  latestDecisive,
  listIssueComments,
  mergeableCi,
  missingFrom,
  readPr,
  REQUEST_CHANGES_DO_MARKER,
  reviewedOnHead,
  summarizeChecks,
  unresolvedThreadsHold,
  type GithubFetch,
} from "@corbits/github-reads";
import {
  addAssignees,
  APPROVE_DO_MARKER,
  approvalOnHead,
  changesRequestedOnHead,
  createIssueComment,
  createReview,
  dismissDoChangeRequests,
  mergePr,
  mirror,
  NOT_OPEN,
  syncLabels,
  requestReviewers,
  type MirrorInput,
} from "./github";


export class DoNotRunnableError extends Error {}
export class HeadMovedError extends DoNotRunnableError {}

export type DoStep = { effectId: string; headSha: string; kind: ActionKind; target: ResolvedTarget };

/** `request` is the verdict's own mirror request: it names the pull request, and a close sends its labels and comment as the pane's Close does. */
export type DoInput = { request: Omit<MirrorInput, "close">; step: DoStep };

/** `satisfied` means GitHub already had the state, so nothing was written. */
export type DoOutcome = { status: "done" | "satisfied"; result: unknown };

export function doMarker(effectId: string): string {
  return `<!-- corbits-do:${effectId} -->`;
}

const Target = type({ labels: "string[]", "unlabel?": "string[]" })
  .or({ users: "string[]", "teams?": "string[]" })
  .or({ body: "string" })
  .or({ unresolved: "'codeowners'" })
  .or({ "+": "reject", "ciOptional?": "true" });

export const DoArgs = type({
  request: { repo: "string", number: "number.integer > 0", labels: "string[]", "owned?": "string[]", comment: "string" },
  step: { effectId: "string > 0", headSha: "string > 0", kind: type.enumerated(...ACTION_KINDS), target: Target },
});

export function parseDoInput(args: unknown): DoInput {
  const parsed = DoArgs(args);
  if (parsed instanceof type.errors) throw new Error(`invalid Do: ${parsed.summary}`);
  checkRepo(parsed.request.repo);
  return { request: parsed.request, step: { ...parsed.step, target: parsed.step.target as ResolvedTarget } };
}

type People = { users: string[]; teams: string[] };

/** A close, merge, comment or review reads as the verdict's judgement of its head, so it is not written on a later one; the other writes still hold. */
function onHead(sha: string, { repo, number }: DoInput["request"], step: DoStep): void {
  if (sha !== step.headSha) throw new HeadMovedError(`${repo}#${number} has new commits since this verdict. Run triage again.`);
}

async function people(gh: GithubFetch, repo: string, number: number, target: ResolvedTarget): Promise<People> {
  if ("users" in target) return { users: target.users, teams: "teams" in target ? target.teams : [] };
  if (!("unresolved" in target) || target.unresolved !== "codeowners") throw new Error("this Do names no people");
  const owners = await codeownersForPr(gh, repo, number);
  if (!owners.users.length && !owners.teams.length) throw new DoNotRunnableError("no code owners for the changed files");
  return owners;
}

/**
 * Takes back triage's own request for changes on the merging head, or says why it stands: a repository may restrict who
 * dismisses reviews, and the merge is then GitHub's to refuse.
 */
async function takeBackOwnRequest(gh: GithubFetch, input: { repo: string; number: number; login: string; sha: string }): Promise<string | undefined> {
  try {
    await dismissDoChangeRequests(gh, input);
    return undefined;
  } catch (err) {
    return errorText(err);
  }
}

/** A closed or merged pull request is history: only a close, or a merge of one already merged, is already done. */
function closedOutcome(kind: ActionKind, merged: boolean): DoOutcome {
  if (kind === "close") return { status: "satisfied", result: { closed: true } };
  if (kind === "merge" && merged) return { status: "satisfied", result: { merged: true } };
  throw new DoNotRunnableError(NOT_OPEN);
}

/** Writes one Do unless GitHub already shows it, so a repeat after a lost audit write changes nothing. `login` names the App's bot account, whose reviews are triage's own. */
export async function executeDo(gh: GithubFetch, { request, step }: DoInput, login: string): Promise<DoOutcome> {
  const { repo, number } = request;
  const { target } = step;
  const pr = await readPr(gh, repo, number);
  if (pr.state !== "open") return closedOutcome(step.kind, pr.merged === true);
  switch (step.kind) {
    case "labels": {
      if (!("labels" in target)) throw new DoNotRunnableError("this labels Do names no labels");
      const current = pr.labels;
      const result = await syncLabels(gh, { repo, number, current, add: target.labels, remove: target.unlabel ?? [] });
      return { status: result.added.length || result.removed.length ? "done" : "satisfied", result };
    }
    case "assign": {
      const { users } = await people(gh, repo, number, target);
      if (!users.length) throw new DoNotRunnableError("no code owner is a user who can be assigned");
      const assignees = missingFrom(pr.assignees, users);
      if (!assignees.length) return { status: "satisfied", result: { assignees } };
      return { status: "done", result: await addAssignees(gh, { repo, number, assignees }) };
    }
    case "request-review": {
      const wanted = await people(gh, repo, number, target);
      const reviewedBy = reviewedOnHead(await getReviews(gh, repo, number), pr.sha);
      const reviewers = missingFrom([...pr.reviewers, ...reviewedBy], wanted.users);
      const teamReviewers = missingFrom(pr.reviewers, wanted.teams);
      if (!reviewers.length && !teamReviewers.length) return { status: "satisfied", result: { reviewers, teamReviewers } };
      return { status: "done", result: await requestReviewers(gh, { repo, number, reviewers, teamReviewers }) };
    }
    case "approve": {
      onHead(pr.sha, request, step);
      const reviewId = await approvalOnHead(gh, { repo, number, sha: step.headSha, login });
      if (reviewId !== undefined) return { status: "satisfied", result: { reviewId } };
      return { status: "done", result: await createReview(gh, { repo, number, body: APPROVE_DO_MARKER, event: "APPROVE", commitId: step.headSha }) };
    }
    case "request-changes": {
      if (!("body" in target)) throw new Error("this request-changes Do has no body");
      onHead(pr.sha, request, step);
      const reviewId = await changesRequestedOnHead(gh, { repo, number, sha: step.headSha, login });
      if (reviewId !== undefined) return { status: "satisfied", result: { reviewId } };
      const body = `${REQUEST_CHANGES_DO_MARKER}\n${target.body}`;
      return { status: "done", result: await createReview(gh, { repo, number, body, event: "REQUEST_CHANGES", commitId: step.headSha }) };
    }
    case "close": {
      onHead(pr.sha, request, step);
      const result = await mirror(gh, { ...request, close: true }, login);
      // Closed between the read above and the mirror's own.
      if ("skipped" in result) return { status: "satisfied", result: { closed: true } };
      return { status: "done", result };
    }
    case "comment": {
      if (!("body" in target)) throw new Error("this comment Do has no body");
      onHead(pr.sha, request, step);
      const marker = doMarker(step.effectId);
      const posted = (await listIssueComments(gh, repo, number)).find((c) => c.author === login && c.body.includes(marker));
      if (posted) return { status: "satisfied", result: { commentId: posted.id } };
      return { status: "done", result: await createIssueComment(gh, { repo, number, body: `${marker}\n${target.body}` }) };
    }
    // CI, reviews and review threads are read again here because a held merge can be approved long after its verdict; branch protection stays the backstop.
    case "merge": {
      onHead(pr.sha, request, step);
      const ci = summarizeChecks(await getChecks(gh, repo, step.headSha));
      if (!mergeableCi(ci, "ciOptional" in target)) throw new DoNotRunnableError(ciRefusal(ci));
      const reviews = await getReviews(gh, repo, number, login);
      const requested = [...latestDecisive(reviews)].filter(([, state]) => state === "CHANGES_REQUESTED").map(([reviewer]) => reviewer);
      if (requested.length) throw new DoNotRunnableError(`changes are requested by ${requested.join(", ")}`);
      const threads = await unresolvedThreadsHold(gh, repo, number, login);
      if (threads !== undefined) throw new DoNotRunnableError(threads);
      // Execute runs before the mirror, and a protected branch refuses the merge while triage's own request on this head stands; one on an earlier head is the mirror's to take back.
      const ownRequest = reviews.some((review) => review.triageRequest && review.state === "CHANGES_REQUESTED" && review.commitId === step.headSha);
      const kept = ownRequest ? await takeBackOwnRequest(gh, { repo, number, login, sha: step.headSha }) : undefined;
      return { status: "done", result: { ...(await mergePr(gh, { repo, number, sha: step.headSha })), ...(kept && { changeRequestsKept: kept }) } };
    }
    default:
      throw new DoNotRunnableError(`unknown Do kind ${(step as { kind: unknown }).kind}`);
  }
}
