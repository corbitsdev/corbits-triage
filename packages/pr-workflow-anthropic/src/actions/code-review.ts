import { type } from "arktype";
import { isRecord } from "@corbits/common";
import { AUTHOR_KINDS, authorGroupsOf, blockCleanSchema, EVERYONE, fileGroupSchema, isFromTriageSender, SEVERITIES, triggerRequestOf, VERDICTS, type VerdictWord } from "@corbits/triage-contracts";
import { globMatch } from "@corbits/triage-workflows/logic/glob";

/** The code review block's outcome step; every other step of the block has its id under `CODE_REVIEW_PREFIX`. */
export const CODE_REVIEW = "codeReview";
export const CODE_REVIEW_PREFIX = `${CODE_REVIEW}_`;
export const CODE_REVIEW_SCOPE = `${CODE_REVIEW_PREFIX}scope`;
export const CODE_REVIEW_REVIEW = `${CODE_REVIEW_PREFIX}review`;

/**
 * Code review's part of the PR workflow's trigger, filled from the parsed policy: whether it is on, the groups it is
 * for, the triage verdicts it runs on and, when set, the globs a changed file must match and the block's `clean`. Nothing
 * here is defaulted: a part that does not parse leaves the review incomplete. The author's groups are the pack's, read
 * from triage's facts.
 */
const CodeReviewTrigger = type({ on: "boolean", for: "string[]", triage: type.enumerated(...VERDICTS).array(), "paths?": "string[]", "clean?": blockCleanSchema });

const Groups = type({ "[string]": fileGroupSchema });

const Trigger = type({ codeReview: CodeReviewTrigger, "codeReviewRequest?": "object", pack: { "groups?": Groups } });

const Author = type({ author: "string", "authorKind?": type.enumerated(...AUTHOR_KINDS), authorTeams: "string[]", authorTeamsUnknown: "string[]" });

const Review = type({ comments: "object[]", budgetExhausted: "boolean", "cut?": "object" });

export type Steps = Record<string, { output: unknown } | undefined>;

type Clean = typeof blockCleanSchema.infer;
type Severity = (typeof SEVERITIES)[number];
type Closed = { open: false; outcome: "skipped" | "incomplete"; reason: string };
type Scope = { open: true; request: object; clean: Clean } | Closed;

/** A step's output, unless it was pruned: a resumed run hydrates a pruned step's skip sentinel, which a live run never shows. */
export function settled(steps: Steps, id: string): unknown {
  const output = steps[id]?.output;
  return isRecord(output) && output.skipped === true ? undefined : output;
}

/** Triage's verdict, from whichever of its branches ran. */
export function verdictOutput(steps: Steps): unknown {
  return settled(steps, "evaluate") ?? settled(steps, "evaluateRules");
}

function verdictOf(steps: Steps): VerdictWord | undefined {
  const verdict = verdictOutput(steps);
  const word = isRecord(verdict) ? verdict.verdict : undefined;
  return VERDICTS.find((known) => known === word);
}

/** The one pull request's facts; undefined when facts could not read it. */
function factsOf(steps: Steps): Record<string, unknown> | undefined {
  const facts = settled(steps, "facts");
  const item = isRecord(facts) && Array.isArray(facts.items) && facts.items.length === 1 ? facts.items[0] : undefined;
  return isRecord(item) && isRecord(item.facts) ? item.facts : undefined;
}

/** Every changed path, a renamed file's old one too; undefined when facts could not read every changed file. */
function changedPaths(steps: Steps): string[] | undefined {
  const read = factsOf(steps);
  if (!read || !Array.isArray(read.files) || typeof read.changedFiles !== "number" || read.files.length < read.changedFiles) return undefined;
  return read.files.flatMap((file) => (isRecord(file) ? [file.path, file.previousPath].filter((path) => typeof path === "string") : []));
}

/** A path matches a glob without `!`, or any path does when every glob has one, and no glob with `!`. */
function inPaths(path: string, globs: readonly string[]): boolean {
  const included = globs.filter((glob) => !glob.startsWith("!"));
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  return (included.length === 0 || included.some((glob) => globMatch(path, glob))) && !excluded.some((glob) => globMatch(path, glob));
}

/** Undefined when the facts do not say who the author is, or not enough to tell their group. */
function authorGroups(steps: Steps, groups: typeof Groups.infer): string[] | undefined {
  const facts = Author(factsOf(steps));
  if (facts instanceof type.errors) return undefined;
  const { author, authorKind, authorTeams, authorTeamsUnknown } = facts;
  return authorGroupsOf(groups, { login: author, ...(authorKind && { kind: authorKind }), teams: authorTeams, teamsUnknown: authorTeamsUnknown });
}

function skipped(reason: string): Closed {
  return { open: false, outcome: "skipped", reason };
}

function incomplete(reason: string): Closed {
  return { open: false, outcome: "incomplete", reason };
}

/**
 * Whether code review runs on this pull request, from the trigger's code review part, triage's verdict and the changed
 * files. In doubt it never opens: whatever it cannot read leaves the review incomplete.
 */
export function scopeOf(trigger: unknown, steps: Steps): Scope {
  if (!isFromTriageSender(trigger)) return incomplete("the trigger mail is not from the hub's Triage sender");
  const parsed = Trigger(triggerRequestOf(trigger));
  if (parsed instanceof type.errors) return incomplete(`the trigger's code review part is invalid: ${parsed.summary}`);
  const { codeReview, codeReviewRequest, pack } = parsed;
  if (!codeReview.on) return skipped("code review is off");
  if (!codeReviewRequest) return incomplete("code review is on but the trigger carries no review request");
  if (!codeReview.for.includes(EVERYONE)) {
    const groups = authorGroups(steps, pack.groups ?? {});
    if (groups === undefined) return incomplete("triage could not tell the author's groups");
    if (!codeReview.for.some((group) => groups.includes(group))) return skipped(`the author is in ${groups.join(", ")}, not ${codeReview.for.join(" or ")}`);
  }
  const verdict = verdictOf(steps);
  if (verdict === undefined) return incomplete("triage gave no verdict");
  if (!codeReview.triage.includes(verdict)) return skipped(`triage is ${verdict}, not ${codeReview.triage.join(" or ")}`);
  if (codeReview.paths) {
    const changed = changedPaths(steps);
    if (changed === undefined) return incomplete("triage could not read the changed files");
    if (!changed.some((path) => inPaths(path, codeReview.paths!))) return skipped(`no changed file matches ${codeReview.paths.join(", ")}`);
  }
  return { open: true, request: codeReviewRequest, clean: codeReview.clean ?? {} };
}

/** The scope action: its input is every settled step's output beside the trigger as `payload`. */
export async function codeReviewScope(input: unknown): Promise<Scope> {
  if (!isRecord(input)) throw new Error("codeReviewScope: input is not an object");
  const { payload, ...steps } = input;
  return scopeOf(payload, steps as Steps);
}

/** Code review's priorities, 0 the most severe and 3 the least. */
const BY_PRIORITY: readonly Severity[] = [...SEVERITIES].reverse();

/** A finding whose priority is not one of code review's, or is missing, is the most severe. */
function severityOf(comment: object): Severity {
  const priority = "priority" in comment ? comment.priority : undefined;
  return (typeof priority === "number" && BY_PRIORITY[priority]) || "critical";
}

/**
 * Incomplete when the review read less than the whole change or cannot be read, whatever it found; else findings, with
 * the worst, when a finding at `below` or worse remains, or clean.
 */
function outcomeOf(review: unknown, { below }: Clean) {
  const parsed = Review(review);
  if (parsed instanceof type.errors || parsed.budgetExhausted || parsed.cut) return { outcome: "incomplete" };
  const counted = below === undefined ? parsed.comments : parsed.comments.filter((comment) => SEVERITIES.indexOf(severityOf(comment)) >= SEVERITIES.indexOf(below));
  if (counted.length === 0) return { outcome: "clean" };
  return { outcome: "findings", worst: SEVERITIES[Math.max(...counted.map((comment) => SEVERITIES.indexOf(severityOf(comment))))] };
}

/**
 * The one place a review that did not finish is recorded: stock runs a step whose dependencies failed, so a failed scope
 * or review step leaves no output here, and that is incomplete. Otherwise the scope's outcome when it closed, or the
 * review's.
 */
function outcomeIn(steps: Steps) {
  const scope = settled(steps, CODE_REVIEW_SCOPE) as Scope | undefined;
  if (scope === undefined) return { outcome: "incomplete", reason: "the scope did not settle" };
  if (!scope.open) return { outcome: scope.outcome, reason: scope.reason };
  const review = settled(steps, CODE_REVIEW_REVIEW);
  if (review === undefined) return { outcome: "incomplete", reason: "the review did not finish" };
  return { ...outcomeOf(review, scope.clean), review };
}

/** The block's outcome. */
export async function codeReviewOutcome(input: unknown) {
  return outcomeIn(input as Steps);
}
