import {
  addAssignees,
  addLabels,
  codeownersForPr,
  createIssueComment,
  getReviews,
  listIssueComments,
  mirror,
  readPr,
  requestReviewers,
  type GithubFetch,
} from "@corbits/github-tool/github";
import { missingFrom, type ResolvedTarget, type SuggestedDo } from "./actions.js";
import { reviewedOnHead } from "./facts.js";
import type { MirrorRequest } from "./render.js";

export class DoNotRunnableError extends Error {}

/** `request` is the verdict's own mirror request: it names the pull request, and a close sends its labels and comment as the pane's Close does. */
export type DoInput = { request: MirrorRequest; step: SuggestedDo };

/** `satisfied` means GitHub already had the state, so nothing was written. */
export type DoOutcome = { status: "done" | "satisfied"; result: unknown };

export function doMarker(effectId: string): string {
  return `<!-- corbits-do:${effectId} -->`;
}

type People = { users: string[]; teams: string[] };

async function people(gh: GithubFetch, repo: string, number: number, target: ResolvedTarget): Promise<People> {
  if ("users" in target) return { users: target.users, teams: "teams" in target ? target.teams : [] };
  if (!("unresolved" in target) || target.unresolved !== "codeowners") throw new Error("this Do names no people");
  const owners = await codeownersForPr(gh, repo, number);
  if (!owners.users.length && !owners.teams.length) throw new DoNotRunnableError("no code owners for the changed files");
  return owners;
}

/** Writes one Do unless GitHub already shows it, so a repeat after a lost audit write changes nothing. */
export async function executeDo(gh: GithubFetch, { request, step }: DoInput): Promise<DoOutcome> {
  const { repo, number } = request;
  const { target } = step;
  switch (step.kind) {
    case "labels": {
      if (!("labels" in target)) throw new DoNotRunnableError("labels derived from the pull request cannot run yet");
      const labels = missingFrom((await readPr(gh, repo, number)).labels, target.labels);
      if (!labels.length) return { status: "satisfied", result: { labels } };
      return { status: "done", result: await addLabels(gh, { repo, number, labels }) };
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
    case "close": {
      if ((await readPr(gh, repo, number)).state === "closed") return { status: "satisfied", result: { closed: true } };
      return { status: "done", result: await mirror(gh, { ...request, close: true }) };
    }
    case "comment": {
      if (!("body" in target)) throw new Error("this comment Do has no body");
      const marker = doMarker(step.effectId);
      const posted = (await listIssueComments(gh, repo, number)).find((c) => c.bot && c.body.includes(marker));
      if (posted) return { status: "satisfied", result: { commentId: posted.id } };
      return { status: "done", result: await createIssueComment(gh, { repo, number, body: `${marker}\n${target.body}` }) };
    }
    case "agent":
      throw new DoNotRunnableError("agent Dos cannot run yet");
  }
}
