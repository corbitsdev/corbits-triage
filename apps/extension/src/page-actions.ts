import type { ActionKind } from "@corbits/triage-contracts";
import type { SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { decidesDos } from "@corbits/triage-workflows/logic/settled";
import { draftsOf } from "./drafts.ts";
import { githubHref } from "./github-href.ts";
import { doLabel } from "./prose.ts";
import type { TriageView } from "./view.ts";

/**
 * Something the person applies on GitHub's page, signed in as themselves: a suggested Do, or a step a failing check
 * points to. `values` are the labels, logins or team slugs it adds; a comment carries its `body`, posted only when the
 * person asks, never on its own. `edit-body` opens the description's editor with `body` added to its end,
 * `edit-title` opens the title's editor beside `hint`, `link` opens `href`, and `ready` marks a draft ready for review.
 */
/** The Do kinds GitHub's page lets the person apply as themselves; the others run only from the hub. */
const PAGE_DO_KINDS = ["labels", "assign", "request-review", "comment", "close"] as const satisfies readonly ActionKind[];
type PageDoKind = (typeof PAGE_DO_KINDS)[number];

function onPage(kind: ActionKind): kind is PageDoKind {
  return (PAGE_DO_KINDS as readonly ActionKind[]).includes(kind);
}

export type PageAction = {
  id: string;
  kind: PageDoKind | "edit-body" | "edit-title" | "link" | "ready";
  title: string;
  why: string;
  values: string[];
  teams: string[];
  body?: string;
  hint?: string;
  href?: string;
  /** Applied on its own when the person turned that on for the repository. */
  auto: boolean;
  /** A pack Do, or a step derived from the failing check it names. */
  source: "do" | "check";
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function fromDo(step: SuggestedDo, repo: string, settled: boolean): PageAction[] {
  const title = doLabel(step, repo);
  // Comment Dos are drafts, listed with the other comments.
  if (title === null || !onPage(step.kind) || step.kind === "comment") return [];
  const target = step.target as Record<string, unknown>;
  const values = step.kind === "labels" ? strings(target.labels) : strings(target.users);
  // Only labels run on its own, on a verdict that decides Dos; every other Do waits for a click.
  const auto = settled && step.kind === "labels";
  return [{ id: step.effectId, kind: step.kind, title, why: step.reason, values, teams: strings(target.teams), auto, source: "do" }];
}

function includesAll(have: string[], wanted: string[]): boolean {
  return wanted.every((value) => have.some((each) => each.toLowerCase() === value.toLowerCase()));
}

/** A step from a check that a Do already takes adds nothing, so only the Do shows. */
function covered(action: PageAction, dos: PageAction[]): boolean {
  return dos.some((step) => step.kind === action.kind && includesAll(step.values, action.values) && includesAll(step.teams, action.teams));
}

/** The view's Dos, the steps its failing checks point to, then its comments, in that order. */
export function pageActions(view: TriageView): PageAction[] {
  // A merged or closed pull request has nothing left to apply.
  if (view.ended) return [];
  const comments = draftsOf(view).map((draft): PageAction => ({ id: draft.id, kind: "comment", title: draft.title, why: draft.why, values: [], teams: [], body: draft.body, auto: false, source: draft.source }));
  const settled = decidesDos({ ...view.verdict, headSha: view.headSha, checks: view.checks });
  const dos = view.dos.flatMap((step) => fromDo(step, view.pr.repo, settled));
  const steps = (view.suggested ?? []).filter((action) => action.kind !== "comment" && !covered(action, dos) && (action.kind !== "link" || githubHref(action.href) !== undefined));
  return [...dos, ...steps, ...comments];
}

/** The draft the comment box is filled with on its own: every failing check together when there are several, else the first. */
export function bestDraft(actions: PageAction[]): PageAction | undefined {
  const comments = actions.filter((action) => action.kind === "comment" && action.body);
  return comments.find((action) => action.id === "feedback") ?? comments[0];
}
