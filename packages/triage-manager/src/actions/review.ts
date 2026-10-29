import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { AUTHOR_KINDS, authorGroupsOf, checkName, EVERYONE, readCheckPack, repoSourceOf, RULE_GATES, rulesGate, VERDICTS, type CheckPack } from "@corbits/triage-contracts";
import { globMatch } from "@corbits/triage-workflows/logic/glob";
import { call, hostWrite, toolName } from "@corbits/triage-workflows/logic/host";
import { codeReviewSummary } from "@corbits/triage-workflows/logic/render";
import { Mailed, type MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, managerMailOf } from "./hub.js";
import { Reviewer, storedReviewer, TakeOutput } from "./manager.js";

/** How long the manager waits for a code review it deployed, from its deploy to its report. */
export const REVIEW_DEADLINE_MS = 60 * 60_000;

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES), "for?": "string[]", "triage?": "string[]", "paths?": "string[]", "again?": "string > 0" });
type CodeReviewPart = typeof CodeReviewPart.infer;
const ScopeInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { items: "object[]" } }, evaluateRules: { output: "unknown" } });
const EarlyInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { items: "object[]" } } });

/** What scope reads of the rules step's pull request: the author and changed files it read, or that it could not read them. */
const RuledItem = type({ error: "string" }).or({
  facts: {
    author: "string",
    "authorKind?": type.enumerated(...AUTHOR_KINDS),
    authorTeams: "string[]",
    authorTeamsUnknown: "string[]",
    changedFiles: "number",
    files: type({ path: "string", "previousPath?": "string" }).array(),
  },
  pack: "object",
});
type ReadItem = Omit<Exclude<typeof RuledItem.infer, { error: string }>, "pack"> & { pack: CheckPack };
type Ruled = { error: string } | ReadItem;

/** Whether `when.paths` takes in `path`: an including glob matches it, or there is none, and no `!` glob does. */
function pathIn(path: string, globs: readonly string[]): boolean {
  const including = globs.filter((glob) => !glob.startsWith("!"));
  const excluding = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  return (including.length === 0 || including.some((glob) => globMatch(path, glob))) && !excluding.some((glob) => globMatch(path, glob));
}

function capitalized(word: string): string {
  return `${word[0]!.toUpperCase()}${word.slice(1)}`;
}

/** Why `for` leaves the author out, failing closed when their groups cannot be told. */
function authorOutside(groups: readonly string[], { facts, pack }: ReadItem): string | undefined {
  if (groups.includes(EVERYONE)) return undefined;
  const held = authorGroupsOf(pack.groups ?? {}, { login: facts.author, kind: facts.authorKind, teams: facts.authorTeams, teamsUnknown: facts.authorTeamsUnknown });
  const named = `the ${groups.join(" or ")} group`;
  if (held === undefined) return `Triage could not tell whether the author is in ${named}`;
  return held.some((group) => groups.includes(group)) ? undefined : `the author is not in ${named}`;
}

/**
 * Why the policy's `for` and `when` leave the pull request out of code review, or undefined when they take it in.
 * Changed files that were not all read never leave it out, and a renamed file counts under its old and new path.
 */
function outOfScope(part: CodeReviewPart, item: ReadItem, verdict: unknown): string | undefined {
  if (part.triage && typeof verdict === "string" && !part.triage.includes(verdict)) return `triage's verdict is ${capitalized(verdict)}, not ${part.triage.map(capitalized).join(" or ")}`;
  const author = part.for && authorOutside(part.for, item);
  if (author) return author;
  const { files, changedFiles } = item.facts;
  if (!part.paths || files.length === 0 || files.length < changedFiles) return undefined;
  const globs = part.paths;
  const taken = files.some((file) => [file.path, file.previousPath].some((path) => path !== undefined && pathIn(path, globs)));
  return taken ? undefined : "every changed file is excluded by the policy's paths";
}

/** Whether `for` or `when` could leave a pull request out. */
function limited(part: CodeReviewPart): boolean {
  return (part.for !== undefined && !part.for.includes(EVERYONE)) || (part.triage !== undefined && VERDICTS.some((verdict) => !part.triage!.includes(verdict))) || part.paths !== undefined;
}

type Scope = { open: boolean; skipped?: string };

/**
 * Whether code review runs past triage's rules and the policy's `for` and `when`, and why not when they leave it out. A
 * pull request triage could not read is not left out: its review waits while `for` or `when` could leave it out.
 */
function scopeOf(part: CodeReviewPart, verdict: Record<string, unknown> | undefined, item: Ruled): Scope {
  const gate = rulesGate(part.rules, verdict?.["checks"]);
  if ("error" in item) return { open: gate.open && !limited(part) };
  if (gate.open === false && gate.outcome === "skipped") return { open: false, skipped: `rules failed: ${gate.failed.map((id) => checkName(item.pack, id)).join(", ")}` };
  if (!gate.open) return { open: false };
  const skipped = outOfScope(part, item, verdict?.["verdict"]);
  return skipped === undefined ? { open: true } : { open: false, skipped };
}

/** The rules step's one pull request, its policy read as triage reads it. */
function ruledItem(items: readonly object[]): Ruled {
  const item = RuledItem(items[0]);
  if (item instanceof type.errors) throw new Error(`reviewScope: ${item.summary}`);
  return "error" in item ? item : { ...item, pack: readCheckPack(item.pack) };
}

/**
 * Whether the pass deploys code review, and whether it posts. Code review runs once per head, when the policy turns it on,
 * triage's rules let it past as its `when.rules` says, the hub read the head's review request and the release publishes
 * a code review for the host. The pass that deploys
 * it, and every pass before its review is in, posts nothing, so the verdict and the review go up together; one that
 * reported a failure or ran past its deadline posts the verdict alone. A later pass on a head whose review settled posts
 * again and deploys no other. A Review again names itself as `again`, so its head is reviewed once more for it, whatever
 * earlier reviews of the head said. A pull request that failed rules, `for` or `when` leave out is not reviewed, and
 * `skipped` says why.
 */
export async function reviewScope(input: unknown): Promise<{ deploy: boolean; post: boolean; reviewed: boolean; skipped?: string }> {
  const parsed = ScopeInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewScope: ${parsed.summary}`);
  const { taken, head, review, reviewFailed, reviewers } = parsed.take.output;
  const part = CodeReviewPart(taken?.["codeReview"]);
  const again = part instanceof type.errors ? undefined : part.again;
  const off: Scope = { open: false };
  const scope = part instanceof type.errors || !part.on ? off : scopeOf(part, asRecord(parsed.evaluateRules.output), ruledItem(parsed.rules.output.items));
  const reviewed = scope.open;
  if (scope.skipped !== undefined) return { deploy: false, post: true, reviewed, skipped: scope.skipped };
  const published = publishedFor(repoSourceOf(managerMailOf(parsed.payload).pullRequest.source), "codeReview") !== undefined;
  const own = reviewers.filter((reviewer) => reviewer.kind === "code-review" && reviewer.head === head && (again === undefined || reviewer.again === again));
  const settled = own.some((reviewer) => reviewer.result !== undefined || Date.parse(reviewer.deadline) <= Date.now());
  // A report on this pass is from an earlier review until the one deployed for this Review again is out.
  const reported = (review !== undefined || reviewFailed !== undefined) && (again === undefined || own.length > 0);
  if (!reviewed || !published || reported || settled || taken?.["codeReviewRequest"] === undefined) return { deploy: false, post: true, reviewed };
  return { deploy: own.length === 0, post: false, reviewed };
}

/**
 * Whether a pass that mailed the judge deploys code review with it, rather than once the verdict is in: the
 * policy turns it on, its `when` leaves out no verdict, which the judge has still to decide, and runs it whatever the
 * rules say (`rules: any`), since the judge's own rules could still shut a `rules: pass` gate; `for`
 * and `when.paths` take the pull request in, the hub read the head's review request, the release publishes a code
 * review for the host, and no review of the head is out or in. Its report is posted with the final verdict.
 */
export async function reviewEarly(input: unknown): Promise<{ deploy: boolean }> {
  const parsed = EarlyInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewEarly: ${parsed.summary}`);
  const { taken, head, review, reviewFailed, reviewers } = parsed.take.output;
  const part = CodeReviewPart(taken?.["codeReview"]);
  const no = { deploy: false };
  const byVerdict = part instanceof type.errors || (part.triage !== undefined && VERDICTS.some((verdict) => !part.triage!.includes(verdict)));
  // Under `rules: pass` the judge's rules could still shut the gate, so only `rules: any` goes out with the judge.
  if (part instanceof type.errors || !part.on || part.rules !== "any" || part.again !== undefined || byVerdict) return no;
  const item = ruledItem(parsed.rules.output.items);
  if ("error" in item || outOfScope(part, item, undefined) !== undefined) return no;
  if (publishedFor(repoSourceOf(managerMailOf(parsed.payload).pullRequest.source), "codeReview") === undefined) return no;
  const reported = review !== undefined || reviewFailed !== undefined;
  const own = reviewers.some((reviewer) => reviewer.kind === "code-review" && reviewer.head === head);
  return { deploy: !reported && !own && taken?.["codeReviewRequest"] !== undefined };
}

const DeployInput = type({ payload: "unknown", take: { output: TakeOutput } });

/**
 * Deploys code review from the host's published release; it is mailed the head's review request, and reports its result
 * to the hub, which wakes the pull request's manager. The mail waits for the new run to publish its public key, giving
 * up when the run ends first or at the review's deadline.
 */
export async function deployReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ reviewer: Reviewer; mail: MailInput }> {
  const parsed = DeployInput(input);
  if (parsed instanceof type.errors) throw new Error(`deployReview: ${parsed.summary}`);
  const { tenantId, runId, pullRequest } = managerMailOf(parsed.payload);
  const { head, taken } = parsed.take.output;
  if (head === undefined || !taken) throw new Error("deployReview: the pass names no head");
  const release = publishedFor(repoSourceOf(pullRequest.source), "codeReview");
  if (!release) throw new Error("deployReview: release.json publishes no code review for the host");
  const again = asRecord(taken["codeReview"])?.["again"];
  const reviewRun = await deploy(ctx, "deploy", tenantId, release);
  const deadline = new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString();
  const content = JSON.stringify({ ...asRecord(taken["codeReviewRequest"]), tenantId });
  return { reviewer: { kind: "code-review", head, runId: reviewRun, deployedBy: runId, deadline, ...(typeof again === "string" && { again }) }, mail: { tenantId, to: reviewRun, content, readyBy: deadline } };
}

const MailedInput = type({ deployReview: { output: { reviewer: Reviewer } }, mailReview: { output: { reply: "string" } } });
const EarlyMailedInput = type({ deployEarlyReview: { output: { reviewer: Reviewer } }, mailEarlyReview: { output: { reply: "string" } } });

function mailedReview(reviewer: Reviewer, reply: string): { reviewer?: Reviewer; post: boolean } {
  const mailed = Mailed(reply);
  if (mailed instanceof type.errors) throw new Error(`reviewMailed: ${mailed.summary}`);
  return mailed.mailed ? { reviewer, post: false } : { post: true };
}

/**
 * The review becomes a reviewer to wait for once its mail went. A mail that failed, because the run ended before it
 * was ready or its deadline passed, leaves the pass to post the verdict without code review.
 */
export async function reviewMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = MailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewMailed: ${parsed.summary}`);
  return mailedReview(parsed.deployReview.output.reviewer, parsed.mailReview.output.reply);
}

/** `reviewMailed` for a review deployed with the judge. */
export async function earlyReviewMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = EarlyMailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`earlyReviewMailed: ${parsed.summary}`);
  return mailedReview(parsed.deployEarlyReview.output.reviewer, parsed.mailEarlyReview.output.reply);
}

const PostInput = type({ payload: "unknown", take: { output: TakeOutput }, reviewScope: { output: { reviewed: "boolean" } } });
const Sent = type({ skipped: "string" }).or({ threads: "(number | null)[] | null", "unread?": "string" });

/** This pass's report and the run that made it, or else the review an earlier pass stored. */
function toPost(review: TakeOutput["review"], runId: string | undefined, stored: ReturnType<typeof storedReviewer>): ReturnType<typeof storedReviewer> {
  if (review && runId !== undefined) return { review, runId };
  return stored;
}

/**
 * Posts the code review reported on its head after the verdict: this pass's, or one an earlier pass stored when this
 * pass's rules still let code review past. The host writes nothing for a review already there. `threads` names each
 * finding's inline comment under the run that reported the review, for the hub to keep on its findings, or `unread`
 * why the host could not read them back.
 */
export async function postReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ posted: boolean; threads?: { runId: string; ids: (number | null)[] }; unread?: string }> {
  const parsed = PostInput(input);
  if (parsed instanceof type.errors) throw new Error(`postReview: ${parsed.summary}`);
  const { head, taken, reviewers, review, reviewRun } = parsed.take.output;
  if (head === undefined || !taken) return { posted: false };
  const found = toPost(review, reviewRun, parsed.reviewScope.output.reviewed ? storedReviewer(reviewers, head) : undefined);
  if (!found) return { posted: false };
  const summary = codeReviewSummary(found.review);
  if (!summary && found.review.comments.length === 0) return { posted: false };
  const { pullRequest } = managerMailOf(parsed.payload);
  const source = repoSourceOf(pullRequest.source);
  const args = { repo: pullRequest.repo, number: pullRequest.number, sha: head, summary, comments: found.review.comments.map(({ thread: _thread, ...finding }) => finding), appLogin: taken["appLogin"] };
  const result = await hostWrite(ctx)(source, call(toolName(source, "send_code_review"), args, `review:${head}`));
  if (result.isError) throw new Error(`postReview: ${JSON.stringify(result.content)}`);
  const sent = Sent.assert(result.content);
  // A review the host skipped, as one whose head moved on, names no comments.
  if ("skipped" in sent) return { posted: true };
  if (sent.threads === null) return { posted: true, ...(sent.unread !== undefined && { unread: sent.unread }) };
  return { posted: true, threads: { runId: found.runId, ids: sent.threads } };
}
