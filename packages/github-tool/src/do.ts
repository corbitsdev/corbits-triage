import { ACTION_KINDS, type ActionKind, type ResolvedTarget } from "@corbits/triage-contracts";
import { type } from "arktype";
import {
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
  type AppLogin,
  type GithubFetch,
} from "@corbits/github-reads";
import {
  addAssignees,
  addLabels,
  APPROVE_DO_MARKER,
  approvalOnHead,
  changesRequestedOnHead,
  createIssueComment,
  createReview,
  mergePr,
  mirror,
  removeLabels,
  requestReviewers,
  type MirrorInput,
} from "./github";


export class DoNotRunnableError extends Error {}
export class HeadMovedError extends DoNotRunnableError {}

/** One resolved Do; `effectId` names it on `headSha`, the head its verdict was made on. */
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

/** A Do as a caller hands it over the wire. */
export const DoArgs = type({
  request: { repo: "string", number: "number.integer > 0", labels: "string[]", "owned?": "string[]", comment: "string" },
  step: { effectId: "string > 0", headSha: "string > 0", kind: type.enumerated(...ACTION_KINDS), target: Target },
});

/** Throws when `args` is not a Do. */
export function parseDoInput(args: unknown): DoInput {
  const parsed = DoArgs(args);
  if (parsed instanceof type.errors) throw new Error(`invalid Do: ${parsed.summary}`);
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

/** Writes one Do unless GitHub already shows it, so a repeat after a lost audit write changes nothing. `login` names the App's own reviews. */
export async function executeDo(gh: GithubFetch, { request, step }: DoInput, login: AppLogin): Promise<DoOutcome> {
  const { repo, number } = request;
  const { target } = step;
  switch (step.kind) {
    case "labels": {
      if (!("labels" in target)) throw new DoNotRunnableError("this labels Do names no labels");
      const present = (await readPr(gh, repo, number)).labels;
      const labels = missingFrom(present, target.labels);
      const stale = (target.unlabel ?? []).filter((label) => missingFrom(present, [label]).length === 0);
      if (!labels.length && !stale.length) return { status: "satisfied", result: { labels } };
      // Adding first means a failure part-way leaves an extra label rather than none.
      const added = labels.length ? await addLabels(gh, { repo, number, labels }) : { labels };
      const removed = stale.length ? await removeLabels(gh, { repo, number, labels: stale }) : { removed: [] };
      return { status: "done", result: { ...added, ...removed } };
    }
    case "assign": {
      const { users } = await people(gh, repo, number, target);
      if (!users.length) throw new DoNotRunnableError("no code owner is a user who can be assigned");
      const assignees = missingFrom((await readPr(gh, repo, number)).assignees, users);
      if (!assignees.length) return { status: "satisfied", result: { assignees } };
      return { status: "done", result: await addAssignees(gh, { repo, number, assignees }) };
    }
    case "request-review": {
      const wanted = await people(gh, repo, number, target);
      const pr = await readPr(gh, repo, number);
      const reviewedBy = reviewedOnHead(await getReviews(gh, repo, number), pr.sha);
      const reviewers = missingFrom([...pr.reviewers, ...reviewedBy], wanted.users);
      const teamReviewers = missingFrom(pr.reviewers, wanted.teams);
      if (!reviewers.length && !teamReviewers.length) return { status: "satisfied", result: { reviewers, teamReviewers } };
      return { status: "done", result: await requestReviewers(gh, { repo, number, reviewers, teamReviewers }) };
    }
    case "approve": {
      onHead((await readPr(gh, repo, number)).sha, request, step);
      const reviewId = await approvalOnHead(gh, { repo, number, sha: step.headSha, login: await login() });
      if (reviewId !== undefined) return { status: "satisfied", result: { reviewId } };
      return { status: "done", result: await createReview(gh, { repo, number, body: APPROVE_DO_MARKER, event: "APPROVE", commitId: step.headSha }) };
    }
    case "request-changes": {
      if (!("body" in target)) throw new Error("this request-changes Do has no body");
      onHead((await readPr(gh, repo, number)).sha, request, step);
      const reviewId = await changesRequestedOnHead(gh, { repo, number, sha: step.headSha, login: await login() });
      if (reviewId !== undefined) return { status: "satisfied", result: { reviewId } };
      const body = `${REQUEST_CHANGES_DO_MARKER}\n${target.body}`;
      return { status: "done", result: await createReview(gh, { repo, number, body, event: "REQUEST_CHANGES", commitId: step.headSha }) };
    }
    case "close": {
      const pr = await readPr(gh, repo, number);
      onHead(pr.sha, request, step);
      if (pr.state === "closed") return { status: "satisfied", result: { closed: true } };
      return { status: "done", result: await mirror(gh, { ...request, close: true }) };
    }
    case "comment": {
      if (!("body" in target)) throw new Error("this comment Do has no body");
      onHead((await readPr(gh, repo, number)).sha, request, step);
      const marker = doMarker(step.effectId);
      const posted = (await listIssueComments(gh, repo, number)).find((c) => c.bot && c.body.includes(marker));
      if (posted) return { status: "satisfied", result: { commentId: posted.id } };
      return { status: "done", result: await createIssueComment(gh, { repo, number, body: `${marker}\n${target.body}` }) };
    }
    // CI and reviews are read again here because a held merge can be approved long after its verdict; branch protection stays the backstop.
    case "merge": {
      const pr = await readPr(gh, repo, number);
      if (pr.merged === true) return { status: "satisfied", result: { merged: true } };
      onHead(pr.sha, request, step);
      const ci = summarizeChecks(await getChecks(gh, repo, step.headSha));
      if (!mergeableCi(ci, "ciOptional" in target)) throw new DoNotRunnableError(`CI is ${ci} on ${step.headSha}`);
      const requested = [...latestDecisive(await getReviews(gh, repo, number))].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
      if (requested.length) throw new DoNotRunnableError(`changes are requested by ${requested.join(", ")}`);
      return { status: "done", result: await mergePr(gh, { repo, number, sha: step.headSha }) };
    }
    default:
      throw new DoNotRunnableError(`unknown Do kind ${(step as { kind: unknown }).kind}`);
  }
}
