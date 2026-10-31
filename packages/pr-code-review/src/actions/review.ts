import { type } from "arktype";
import { diffFiles, hunksAt } from "@corbits/common/diff-files";
import { isFromTriageSender, triggerRequestOf, type UnreadLines } from "@corbits/triage-contracts";
import { parseFindings, samePath, type Finding } from "../findings.js";
import { Effort, ROLES, type CodeReviewProfile, type Role } from "../profile.js";
import { promptAttribute, promptText } from "../prompt-text.js";
import { BUDGET_EXHAUSTED, budgetTag, Checkout, DEFAULT_BUDGET, DEFAULT_CHECK_BUDGET, DEFAULT_CHECK_TOTAL, repositoryTag } from "./checkout.js";
import { splitBundle } from "../diff-parts.js";

const MAX_OUTPUT_TOKENS = 16_000;
const ReviewRequest = type({
  kind: "'code-review'", title: "string", description: "string", diff: "string", checkout: Checkout,
  "efforts?": { "diffFinder?": Effort, "check?": Effort },
  "budgets?": { "check?": "number.integer > 0", "checkTotal?": "number.integer > 0" },
  "number?": "number.integer > 0",
});
type ReviewRequest = typeof ReviewRequest.infer;

export interface Candidate extends Finding {
  finders: "diff"[];
  reports: number;
}
interface Reported extends Finding {
  agreement: { finders: number; reports: number };
}
interface Steps {
  $prefix?: string;
  reviewInput?: { output: ReviewInput };
  find?: { output: unknown[] };
  candidates?: { output: Candidates };
  checks?: { output: Checks };
  check?: { output: unknown[] };
}
interface StepInference { effort: Effort; maxTokens: number }
interface ReviewInput { request: ReviewRequest; inference: Record<Role, StepInference> }
interface Candidates {
  found: Candidate[];
  kept: Candidate[];
  budgetExhausted: boolean;
  complete: boolean;
  unread: UnreadLines[];
  unreadFiles: number;
}
export const Verdict = type({ verdict: "'real' | 'not_real' | 'unsure'", reason: "string" });
type Verdict = typeof Verdict.infer;
interface Checks { findings: Reported[]; checks: { text: string; inference: StepInference }[] }
const UNCHECKED: Verdict = { verdict: "unsure", reason: "check budget spent" };
interface Judged extends Verdict { finding: Reported }

function replyOf(output: unknown): string {
  if (typeof output === "object" && output !== null && "reply" in output && typeof output.reply === "string") return output.reply;
  throw new Error("step output has no reply");
}
function verdictOf(output: unknown): Verdict {
  let parsed: unknown;
  try { parsed = JSON.parse(replyOf(output).replace(BUDGET_EXHAUSTED, "")); }
  catch { throw new Error("step replied without JSON"); }
  const verdict = Verdict(parsed);
  if (verdict instanceof type.errors) throw new Error("check replied without a verdict");
  return verdict;
}
type StepId = Exclude<keyof Steps, "$prefix">;
function stepOutput<K extends StepId>(steps: Steps, id: K): NonNullable<Steps[K]>["output"] {
  const step = (steps as Record<string, Steps[K]>)[`${steps.$prefix ?? ""}${id}`];
  if (!step) throw new Error(`missing step output ${id}`);
  return step.output as NonNullable<Steps[K]>["output"];
}
function aboutPullRequest(request: ReviewRequest): string {
  return `<pull_request>\n<title>${promptText(request.title)}</title>\n<description>${promptText(request.description)}</description>\n</pull_request>`;
}
function handedOver(input: unknown): boolean {
  return typeof input === "object" && input !== null && "kind" in input && input.kind === "code-review";
}
export function reviewInputFor({ efforts }: Pick<CodeReviewProfile, "efforts">) {
  return async function reviewInput(input: unknown): Promise<ReviewInput> {
    if (!handedOver(input) && !isFromTriageSender(input)) throw new Error("reviewInput: the trigger mail is not from the hub's Triage sender");
    const request = ReviewRequest(triggerRequestOf(input));
    if (request instanceof type.errors) throw new Error(`reviewInput: invalid request: ${request.summary}`);
    const inference = Object.fromEntries(ROLES.map((role) => [role, { effort: request.efforts?.[role] ?? efforts[role], maxTokens: MAX_OUTPUT_TOKENS }])) as Record<Role, StepInference>;
    return { request, inference };
  };
}

/** Each file is assigned independently; only an oversized escaped message splits its patch. */
export async function findersInput(steps: Steps) {
  const { request } = stepOutput(steps, "reviewInput");
  const bundles: string[] = [];
  for (const file of diffFiles(request.diff)) {
    if (file.status === "deleted") continue;
    function message(text: string) {
      return `${repositoryTag(request.checkout)}${budgetTag(DEFAULT_BUDGET)}${aboutPullRequest(request)}\n\n<diff path="${promptAttribute(file.path)}">\n${promptText(text)}\n</diff>\n\nReview the diff and report the defects this change introduces.`;
    }
    bundles.push(...splitBundle(file.patch, message).map(message));
  }
  return { bundles };
}
function findingsOf(output: unknown): Candidate[] {
  const reply = replyOf(output);
  const parsed = parseFindings(reply.replace(BUDGET_EXHAUSTED, ""));
  if ("unparsable" in parsed) {
    if (reply.startsWith(BUDGET_EXHAUSTED)) return [];
    throw new Error(`diff finder: ${parsed.unparsable}`);
  }
  return parsed.findings.map((finding) => ({ ...finding, finders: ["diff"], reports: 1 }));
}
function spaced(text: string | undefined): string | undefined { return text?.trim().replace(/\s+/g, " ") || undefined; }
function normalized(text: string | undefined): string | undefined { return spaced(text)?.toLowerCase(); }
export function isDuplicate(a: Finding, b: Finding): boolean {
  if (!samePath(a.path, b.path) || a.start !== b.start || a.end !== b.end) return false;
  const title = normalized(a.title);
  if (title !== normalized(b.title)) return false;
  if (title !== undefined) return true;
  const why = normalized(a.why);
  if (why === undefined || why !== normalized(b.why)) return false;
  const code = spaced(a.code);
  const other = spaced(b.code);
  return code === undefined || other === undefined || code === other;
}
function withoutDuplicates(found: readonly Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const candidate of found) {
    const index = kept.findIndex((k) => isDuplicate(k, candidate));
    if (index === -1) { kept.push(candidate); continue; }
    const first = kept[index]!;
    kept[index] = { ...first, reports: first.reports + candidate.reports };
  }
  return kept;
}

/** A successful map returned every assigned bundle, independently of tool reads or budget exhaustion. */
export async function candidates(steps: Steps): Promise<Candidates> {
  const outputs = stepOutput(steps, "find");
  const found = outputs.flatMap(findingsOf);
  return { found, kept: withoutDuplicates(found), budgetExhausted: outputs.some((output) => replyOf(output).startsWith(BUDGET_EXHAUSTED)), complete: true, unread: [], unreadFiles: 0 };
}
function checkMessage(request: ReviewRequest, finding: Reported, budget: number): string {
  const claim = { title: finding.title, why: finding.why, trigger: finding.trigger };
  const hunks = hunksAt(request.diff, finding);
  return [
    `${repositoryTag(request.checkout)}${budgetTag(budget)}${aboutPullRequest(request)}`,
    `<finding path="${promptAttribute(finding.path)}" start="${finding.start}" end="${finding.end}">\n${promptText(JSON.stringify(claim, null, 2))}\n</finding>`,
    ...(hunks.length > 0 ? [`<diff path="${promptAttribute(finding.path)}">\n${promptText(hunks.join(""))}\n</diff>`] : []),
    "Verify this finding.",
  ].join("\n\n");
}
export async function checks(steps: Steps): Promise<Checks> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { kept } = stepOutput(steps, "candidates");
  const findings = kept.map((finding) => ({ ...finding, agreement: { finders: 1, reports: finding.reports } })).sort((a, b) => a.priority - b.priority);
  const perCheck = request.budgets?.check ?? DEFAULT_CHECK_BUDGET;
  let left = request.budgets?.checkTotal ?? DEFAULT_CHECK_TOTAL;
  const checked: Checks["checks"] = [];
  for (const finding of findings) {
    const budget = Math.min(perCheck, left);
    if (budget === 0) break;
    left -= budget;
    checked.push({ text: checkMessage(request, finding, budget), inference: inference.check });
  }
  return { findings, checks: checked };
}
export function ownWords({ title, why, trigger, path, start }: Finding) {
  const heading = [title, why].find((part) => part !== undefined && part !== "") ?? `Defect at ${path}:${start}`;
  return { title: heading, body: [why, trigger].filter((part) => part !== undefined).join("\n\n") };
}
function commentOf(finding: Reported) {
  const { path, start, end, agreement, priority, code } = finding;
  return { path, start, end, ...ownWords(finding), priority, ...(code !== undefined && { quoted: code }), agreement };
}
export async function review(steps: Steps) {
  const { budgetExhausted, complete, unread, unreadFiles } = stepOutput(steps, "candidates");
  const { findings } = stepOutput(steps, "checks");
  const verdicts = stepOutput(steps, "check").map(verdictOf);
  const judged = findings.map((finding, i) => ({ finding, ...(verdicts[i] ?? UNCHECKED) }));
  const comments = judged.filter((j) => j.verdict === "real").map((j) => commentOf(j.finding));
  function droppedOf({ finding, verdict, reason }: Judged) { return { ...commentOf(finding), verdict, reason }; }
  const dropped = judged.filter((j) => j.verdict !== "real").map(droppedOf);
  return { summary: comments.length === 0 ? "No defects reported." : "", comments, dropped, budgetExhausted, complete, unread, unreadFiles };
}
