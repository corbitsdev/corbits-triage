// Bitbucket Data Center webhook payloads in the shapes the GitHub bridge produces, under GitHub's event and action
// names so triage events and coalescing read them unchanged. Payloads name neither the default branch nor the files a
// push changed, so every merge counts as a moved base and every branch update as a possible policy file change; the
// policy sync re-reads the file and compares.
import { isTriageComment } from "@corbits/github-reads";
import type { PrMail } from "../github/normalize.js";
import type { HookIntake } from "../provider-hooks/intake.js";

type Json = Record<string, any>;
type Mapped = { event: string; action: string; review: PrMail["review"] };

const PULL_REQUEST: Record<string, Mapped> = {
  "pr:opened": { event: "pull_request", action: "opened", review: null },
  "pr:modified": { event: "pull_request", action: "edited", review: null },
  "pr:from_ref_updated": { event: "pull_request", action: "synchronize", review: null },
  "pr:reviewer:approved": { event: "pull_request_review", action: "submitted", review: { state: "approved" } },
  "pr:reviewer:needs_work": { event: "pull_request_review", action: "submitted", review: { state: "changes_requested" } },
  "pr:reviewer:unapproved": { event: "pull_request_review", action: "dismissed", review: { state: "dismissed" } },
  "pr:comment:added": { event: "issue_comment", action: "created", review: null },
};

/** `PROJECTKEY/slug`, how Bitbucket repositories are named in the tenant's repository records. */
export function repoNameOf(repository: Json | undefined): string | null {
  const key = repository?.project?.key;
  const slug = repository?.slug;
  return typeof key === "string" && typeof slug === "string" ? `${key}/${slug}` : null;
}

/** A modification that flips the draft flag is GitHub's ready_for_review or converted_to_draft. */
function modifiedAction(p: Json): string {
  const draft = p.pullRequest?.draft === true;
  if (typeof p.previousDraft !== "boolean" || p.previousDraft === draft) return "edited";
  return draft ? "converted_to_draft" : "ready_for_review";
}

function prMail(eventKey: string, deliveryId: string, p: Json, { event, action, review }: Mapped): PrMail | null {
  const pr = p.pullRequest;
  const repo = repoNameOf(pr?.toRef?.repository);
  if (repo === null || typeof pr.id !== "number" || pr.state !== "OPEN") return null;
  if (eventKey === "pr:comment:added" && isTriageComment(String(p.comment?.text ?? ""))) return null;
  return {
    kind: "pr",
    repo,
    prNumber: pr.id,
    deliveryId,
    event,
    action: eventKey === "pr:modified" ? modifiedAction(p) : action,
    headSha: pr.fromRef?.latestCommit ?? null,
    author: pr.author?.user?.slug ?? null,
    title: pr.title ?? null,
    body: pr.description ?? null,
    // Instances older than draft pull requests send no flag; none of theirs can be a draft.
    draft: pr.draft === true,
    review,
  };
}

function mergedOf(p: Json): HookIntake | null {
  const repo = repoNameOf(p.pullRequest?.toRef?.repository);
  const merged = p.pullRequest?.id;
  return repo !== null && typeof merged === "number" ? { kind: "base-move", move: { repo, merged } } : null;
}

function refsChangedOf(p: Json): HookIntake | null {
  const repo = repoNameOf(p.repository);
  const changes: Json[] = Array.isArray(p.changes) ? p.changes : [];
  const branches = changes.filter((change) => change?.ref?.type === "BRANCH" && change.type !== "DELETE" && typeof change.ref.displayId === "string").map((change) => change.ref.displayId as string);
  return repo !== null && branches.length > 0 ? { kind: "policy-push", push: { repo, removed: false }, branches } : null;
}

export function normalizeBitbucket(eventKey: string, deliveryId: string, p: Json): HookIntake | null {
  if (eventKey === "pr:merged") return mergedOf(p);
  if (eventKey === "repo:refs_changed") return refsChangedOf(p);
  const mapped = PULL_REQUEST[eventKey];
  if (!mapped) return null;
  const mail = prMail(eventKey, deliveryId, p, mapped);
  return mail && { kind: "pr", mail };
}
