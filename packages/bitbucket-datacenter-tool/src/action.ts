import { ACTION_KINDS, type ActionKind, type ResolvedTarget } from "@corbits/triage-contracts";
import { ciRefusal, mergeableCi, type CiState } from "@corbits/github-reads";
import { type } from "arktype";
import {
  addReviewers,
  buildStates,
  createComment,
  listComments,
  mergePr,
  mergeVeto,
  mirror,
  NOT_OPEN,
  readPr,
  setStatus,
  statusOf,
  type BitbucketFetch,
  type BitbucketUser,
  type BuildState,
  type MirrorInput,
  type PullRequest,
} from "./bitbucket";

export class ActionNotRunnableError extends Error {}
export class HeadMovedError extends ActionNotRunnableError {}

export type ActionStep = { effectId: string; headSha: string; kind: ActionKind; target: ResolvedTarget };

/** `request` is the verdict's own mirror request: it names the pull request, and a close sends its comment as the pane's Close does. */
export type ActionInput = { request: Omit<MirrorInput, "close">; step: ActionStep };

/** `satisfied` means Bitbucket already had the state, so nothing was written. */
export type ActionOutcome = { status: "done" | "satisfied"; result: unknown };

export const NO_LABELS = "Bitbucket Data Center has no labels";
export const NO_ASSIGNEES = "Bitbucket Data Center has no assignees";
export const NO_TEAMS = "Bitbucket Data Center has no team reviewers";
export const NO_CODEOWNERS = "Bitbucket Data Center code owners are not read";
export const OWN_PULL_REQUEST = "Bitbucket Data Center forbids reviewing your own pull request";

export function actionMarker(effectId: string): string {
  return `[corbits-action]: #${encodeURIComponent(effectId)}`;
}

const Target = type({ labels: "string[]", "unlabel?": "string[]" })
  .or({ users: "string[]", "teams?": "string[]" })
  .or({ body: "string" })
  .or({ unresolved: "'codeowners'" })
  .or({ "+": "reject", "ciOptional?": "true" });

export const ActionArgs = type({
  request: { repo: "string", number: "number.integer > 0", labels: "string[]", "owned?": "string[]", comment: "string" },
  step: { effectId: "string > 0", headSha: "string > 0", kind: type.enumerated(...ACTION_KINDS), target: Target },
});

export function parseActionInput(args: unknown): ActionInput {
  const parsed = ActionArgs(args);
  if (parsed instanceof type.errors) throw new Error(`invalid action: ${parsed.summary}`);
  return { request: parsed.request, step: { ...parsed.step, target: parsed.step.target as ResolvedTarget } };
}

/** A close, merge, comment or review reads as the verdict's judgement of its head, so it is not written on a later one. */
function onHead(sha: string, { repo, number }: ActionInput["request"], step: ActionStep): void {
  if (sha !== step.headSha) throw new HeadMovedError(`${repo}#${number} has new commits since this verdict. Run triage again.`);
}

function reviewerSlugs(target: ResolvedTarget): string[] {
  if ("unresolved" in target) throw new ActionNotRunnableError(NO_CODEOWNERS);
  if (!("users" in target)) throw new Error("this action names no people");
  if (!target.users.length) throw new ActionNotRunnableError(NO_TEAMS);
  return target.users;
}

function closedOutcome(kind: ActionKind, pr: PullRequest): ActionOutcome {
  if (kind === "close") return { status: "satisfied", result: { closed: true } };
  if (kind === "merge" && pr.state === "MERGED") return { status: "satisfied", result: { merged: true } };
  throw new ActionNotRunnableError(NOT_OPEN);
}

function ciState(states: BuildState[]): CiState {
  if (!states.length) return "none";
  if (states.some((s) => s === "FAILED" || s === "CANCELLED")) return "failure";
  if (states.some((s) => s === "INPROGRESS" || s === "UNKNOWN")) return "pending";
  return "success";
}

async function postOnce(bb: BitbucketFetch, input: { repo: string; number: number; userId: number; marker: string; body: string }): Promise<ActionOutcome> {
  const posted = (await listComments(bb, input.repo, input.number)).find((c) => c.author.id === input.userId && c.text.includes(input.marker));
  if (posted) return { status: "satisfied", result: { commentId: posted.id } };
  return { status: "done", result: await createComment(bb, { repo: input.repo, number: input.number, text: `${input.marker}\n${input.body}` }) };
}

/** Writes one action unless Bitbucket already shows it, so a repeat after a lost audit write changes nothing. A write Bitbucket refuses throws a BitbucketRefusal. */
export async function executeAction(bb: BitbucketFetch, { request, step }: ActionInput, user: BitbucketUser): Promise<ActionOutcome> {
  const { repo, number } = request;
  const { target } = step;
  const pr = await readPr(bb, repo, number);
  if (pr.state !== "OPEN") return closedOutcome(step.kind, pr);
  switch (step.kind) {
    case "labels":
      throw new ActionNotRunnableError(NO_LABELS);
    case "assign":
      throw new ActionNotRunnableError(NO_ASSIGNEES);
    case "request-review": {
      const present = new Set([pr.author.slug, ...pr.reviewers.map((r) => r.user.slug)]);
      const reviewers = reviewerSlugs(target).filter((slug) => !present.has(slug));
      if (!reviewers.length) return { status: "satisfied", result: { reviewers } };
      return { status: "done", result: await addReviewers(bb, { repo, number, reviewers }) };
    }
    case "approve": {
      onHead(pr.sha, request, step);
      const me = await user();
      if (pr.author.id === me.id) throw new ActionNotRunnableError(OWN_PULL_REQUEST);
      if (statusOf(pr, me) === "APPROVED") return { status: "satisfied", result: { status: "APPROVED" } };
      return { status: "done", result: await setStatus(bb, { repo, number, slug: me.slug, status: "APPROVED" }) };
    }
    // Data Center's needs-work status carries no text, so the reasons go in a comment beside it.
    case "request-changes": {
      if (!("body" in target)) throw new Error("this request-changes action has no body");
      onHead(pr.sha, request, step);
      const me = await user();
      if (pr.author.id === me.id) throw new ActionNotRunnableError(OWN_PULL_REQUEST);
      if (statusOf(pr, me) === "NEEDS_WORK") return { status: "satisfied", result: { status: "NEEDS_WORK" } };
      const comment = await postOnce(bb, { repo, number, userId: me.id, marker: actionMarker(step.effectId), body: target.body });
      return { status: "done", result: { ...(comment.result as object), ...(await setStatus(bb, { repo, number, slug: me.slug, status: "NEEDS_WORK" })) } };
    }
    case "close": {
      onHead(pr.sha, request, step);
      const result = await mirror(bb, { ...request, close: true }, user);
      // Closed between the read above and the mirror's own.
      if ("skipped" in result) return { status: "satisfied", result: { closed: true } };
      return { status: "done", result };
    }
    case "comment": {
      if (!("body" in target)) throw new Error("this comment action has no body");
      onHead(pr.sha, request, step);
      return postOnce(bb, { repo, number, userId: (await user()).id, marker: actionMarker(step.effectId), body: target.body });
    }
    // Builds and reviews are read again here because a held merge can be approved long after its verdict; Bitbucket's merge checks stay the backstop.
    case "merge": {
      onHead(pr.sha, request, step);
      const ci = ciState(await buildStates(bb, step.headSha));
      if (!mergeableCi(ci, "ciOptional" in target)) throw new ActionNotRunnableError(ciRefusal(ci));
      const me = await user();
      const requested = pr.reviewers.filter((r) => r.status === "NEEDS_WORK" && r.user.id !== me.id).map((r) => r.user.slug);
      if (requested.length) throw new ActionNotRunnableError(`changes are requested by ${requested.join(", ")}`);
      // Triage's own needs-work is its verdict on this head, which now merges; a "no needs work" merge check would veto it.
      if (statusOf(pr, me) === "NEEDS_WORK") await setStatus(bb, { repo, number, slug: me.slug, status: "UNAPPROVED" });
      const veto = await mergeVeto(bb, repo, number);
      if (veto) throw new ActionNotRunnableError(veto);
      return { status: "done", result: await mergePr(bb, { repo, number, version: (await readPr(bb, repo, number)).version }) };
    }
    default:
      throw new ActionNotRunnableError(`unknown action kind ${(step as { kind: unknown }).kind}`);
  }
}
