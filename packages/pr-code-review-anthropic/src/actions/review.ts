import { type } from "arktype";
import { triggerRequestOf } from "@corbits/triage-contracts";
import { changedFiles, parseFindings, samePath, type Finding } from "../findings.js";
import { BUDGET_EXHAUSTED, budgetTag, Checkout, DEFAULT_BUDGET, repositoryTag } from "./checkout.js";

const MAX_OUTPUT_TOKENS = 16_000;
const CONTEXT_LINES = 20;
const MAX_GATHERED_PATHS = 20;

const Effort = type("'low' | 'medium' | 'high'");

const ROLES = ["plan", "diffFinder", "repoFinder", "converge", "check", "write"] as const;
type Role = (typeof ROLES)[number];

const DEFAULT_EFFORTS: Record<Role, typeof Effort.infer> = { plan: "medium", diffFinder: "medium", repoFinder: "medium", converge: "medium", check: "medium", write: "low" };

const ReviewRequest = type({
  kind: "'code-review'",
  title: "string",
  description: "string",
  diff: "string",
  checkout: Checkout,
  "efforts?": { "plan?": Effort, "diffFinder?": Effort, "repoFinder?": Effort, "converge?": Effort, "check?": Effort, "write?": Effort },
  "budgets?": { "repoFinder?": "number.integer > 0" },
});
type ReviewRequest = typeof ReviewRequest.infer;

type Finder = "diff" | "repo";

interface Candidate extends Finding {
  finder: Finder;
}

interface Verdict {
  verdict: "real" | "not_real";
  reason: string;
}

interface Steps {
  reviewInput?: { output: ReviewInput };
  plan?: { output: unknown };
  findDiff?: { output: unknown };
  findRepo?: { output: unknown };
  candidates?: { output: Candidates };
  gather?: { output: unknown };
  merge?: { output: Merged };
  converge?: { output: unknown };
  checks?: { output: Checks };
  check?: { output: unknown[] };
  writeInput?: { output: WriteInput };
  write?: { output: unknown };
}

interface StepInference {
  effort: typeof Effort.infer;
  maxTokens: number;
}

interface ReviewInput {
  request: ReviewRequest;
  plan: string;
  inference: Record<Role, StepInference>;
}

interface Candidates {
  found: Candidate[];
  budgetExhausted: boolean;
  gather: string;
}

interface Merged {
  candidates: Candidate[];
  dropped: number;
  converge: string;
  inference: StepInference;
}

interface Fix {
  path: string;
  line: number;
  edit: string;
}

export interface Group {
  defect: string;
  fix?: Fix;
  members: number[];
  representative: number;
}

interface Checks {
  groups: Group[];
  candidates: Candidate[];
  checks: { text: string; inference: StepInference }[];
}

interface WriteInput {
  budgetExhausted: boolean;
  verdicts: Verdict[];
  confirmed: Candidate[];
  text: string;
  inference: StepInference;
}

function replyOf(output: unknown): string {
  if (typeof output === "object" && output !== null && "reply" in output && typeof output.reply === "string") return output.reply;
  throw new Error(`step output has no reply: ${JSON.stringify(output)?.slice(0, 200)}`);
}

/** A structured step's JSON reply; a step whose model call failed replies with text saying so. */
function jsonReply<T>(output: unknown): T {
  const reply = replyOf(output).replace(BUDGET_EXHAUSTED, "");
  try {
    return JSON.parse(reply) as T;
  } catch {
    throw new Error(`step replied without JSON: ${reply.slice(0, 200)}`);
  }
}

function stepOutput<K extends keyof Steps>(steps: Steps, id: K): NonNullable<Steps[K]>["output"] {
  const step = steps[id];
  if (!step) throw new Error(`missing step output ${id}`);
  return step.output as NonNullable<Steps[K]>["output"];
}

function aboutPullRequest(request: ReviewRequest): string {
  return `<pull_request>\n<title>${request.title}</title>\n<description>${request.description}</description>\n</pull_request>`;
}

function pullRequest(request: ReviewRequest): string {
  return `${aboutPullRequest(request)}\n\n<diff>\n${request.diff}\n</diff>`;
}

/** The request from the trigger mail, the plan's user message and every role's per-call options. */
export async function reviewInput(input: unknown): Promise<ReviewInput> {
  const parsed = ReviewRequest(triggerRequestOf(input));
  if (parsed instanceof type.errors) throw new Error(`reviewInput: invalid request: ${parsed.summary}`);
  const request = parsed;
  function inference(role: Role): [Role, StepInference] {
    return [role, { effort: request.efforts?.[role] ?? DEFAULT_EFFORTS[role], maxTokens: MAX_OUTPUT_TOKENS }];
  }
  const inferences = Object.fromEntries(ROLES.map(inference)) as Record<Role, StepInference>;
  return { request, plan: `${pullRequest(request)}\n\nPlan the review of this pull request.`, inference: inferences };
}

/** Both finders' user messages with the plan appended; the repository finder's names its checkout and token budget. */
export async function findersInput(steps: Steps) {
  const { request } = stepOutput(steps, "reviewInput");
  const plan = replyOf(stepOutput(steps, "plan"));
  const message = `${pullRequest(request)}\n\n<plan>\n${plan}\n</plan>\n\nReview the diff above and report the defects this change introduces.`;
  return { diff: message, repo: `${repositoryTag(request.checkout)}${budgetTag(request.budgets?.repoFinder ?? DEFAULT_BUDGET)}${message}` };
}

function findingsOf(output: unknown, finder: Finder): Candidate[] {
  const parsed = parseFindings(replyOf(output).replace(BUDGET_EXHAUSTED, ""));
  if ("unparsable" in parsed) return [];
  return parsed.findings.map((finding) => ({ ...finding, finder }));
}

/** Both finders' findings, whether the repository finder's budget ran out, and the gather step's message naming the files they cite. */
export async function candidates(steps: Steps): Promise<Candidates> {
  const { request } = stepOutput(steps, "reviewInput");
  const found = [...findingsOf(stepOutput(steps, "findDiff"), "diff"), ...findingsOf(stepOutput(steps, "findRepo"), "repo")];
  const paths = [...new Set(found.map((f) => f.path))].slice(0, MAX_GATHERED_PATHS);
  const budgetExhausted = replyOf(stepOutput(steps, "findRepo")).startsWith(BUDGET_EXHAUSTED);
  return { found, budgetExhausted, gather: `${repositoryTag(request.checkout)}${JSON.stringify({ paths })}` };
}

// The read tools clip a line past 500 characters and end it with "…".
function showsLine(text: string, code: string): boolean {
  const shown = text.trim();
  return shown === code || (shown.endsWith("…") && code.startsWith(shown.slice(0, -1)));
}

function quotedLine(finding: Finding): string | undefined {
  return finding.code?.split("\n").find((row) => row.trim() !== "")?.trim();
}

/** The candidate moved onto the line its quoted code names, nearest its own line; none when the file lacks that code. */
function anchoredIn(candidate: Candidate, lines: readonly string[]): Candidate | undefined {
  const code = quotedLine(candidate);
  if (!code) return undefined;
  const matches = lines.flatMap((text, i) => (showsLine(text, code) ? [i + 1] : []));
  if (matches.length === 0) return undefined;
  const nearest = matches.reduce((best, line) => (Math.abs(line - candidate.start) < Math.abs(best - candidate.start) ? line : best));
  return { ...candidate, start: nearest, end: nearest + candidate.end - candidate.start };
}

function sameCode(a: Finding, b: Finding): boolean {
  return samePath(a.path, b.path) && a.start <= b.end && a.end >= b.start && quotedLine(a) === quotedLine(b);
}

function fileOf(files: Record<string, string>, path: string): string[] | undefined {
  const key = Object.keys(files).find((name) => samePath(name, path));
  return key === undefined ? undefined : files[key]!.split("\n");
}

function excerpt(lines: readonly string[], candidate: Candidate): string {
  const from = Math.max(1, candidate.start - CONTEXT_LINES);
  const to = Math.min(lines.length, candidate.end + CONTEXT_LINES);
  return lines.slice(from - 1, to).map((text, i) => `${from + i}\t${text}`).join("\n");
}

function checkMessage(request: ReviewRequest, candidate: Candidate, lines: readonly string[]): string {
  const claim = { title: candidate.title, why: candidate.why, trigger: candidate.trigger };
  return [
    aboutPullRequest(request),
    `<candidate path="${candidate.path}" start="${candidate.start}" end="${candidate.end}">\n${JSON.stringify(claim, null, 2)}\n</candidate>`,
    `<quoted_code>\n${candidate.code}\n</quoted_code>`,
    `<file path="${candidate.path}">\n${excerpt(lines, candidate)}\n</file>`,
    "Is this defect real?",
  ].join("\n\n");
}

function filesOf(steps: Steps): Record<string, string> {
  return jsonReply<{ files: Record<string, string> }>(stepOutput(steps, "gather")).files;
}

function convergeMessage(request: ReviewRequest, candidates: readonly Candidate[]): string {
  const listed = candidates.map(({ path, start, end, code, title, why, trigger }, index) => ({ index, path, start, end, code, title, why, trigger }));
  return `${aboutPullRequest(request)}\n\n<candidates>\n${JSON.stringify(listed, null, 2)}\n</candidates>\n\nGroup the candidates by the defect they describe.`;
}

/**
 * Keeps each candidate whose quoted code is in its file, moved onto that line, and drops a later one that quotes the
 * same code on overlapping lines; the converge step's input lists the kept ones.
 */
export async function merge(steps: Steps): Promise<Merged> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { found } = stepOutput(steps, "candidates");
  const files = filesOf(steps);
  const kept: Candidate[] = [];
  for (const candidate of found) {
    const lines = fileOf(files, candidate.path);
    const anchored = lines && anchoredIn(candidate, lines);
    if (!anchored || kept.some((k) => sameCode(k, anchored))) continue;
    kept.push(anchored);
  }
  return { candidates: kept, dropped: found.length - kept.length, converge: convergeMessage(request, kept), inference: inference.converge };
}

/** The converge step's groups, with every candidate it left out or repeated in a group of its own. */
function groupsOf(output: unknown, count: number): Group[] {
  const { groups } = jsonReply<{ groups: Group[] }>(output);
  const seen = new Set<number>();
  const valid: Group[] = [];
  for (const group of groups) {
    const members = group.members.filter((i) => Number.isInteger(i) && i >= 0 && i < count && !seen.has(i));
    if (members.length === 0) continue;
    for (const i of members) seen.add(i);
    valid.push({ defect: group.defect, fix: group.fix, members, representative: members.includes(group.representative) ? group.representative : members[0]! });
  }
  for (let i = 0; i < count; i++) if (!seen.has(i)) valid.push({ defect: "", members: [i], representative: i });
  return valid;
}

/** One check per converged group, of its representative. */
export async function checks(steps: Steps): Promise<Checks> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { candidates: merged } = stepOutput(steps, "merge");
  const files = filesOf(steps);
  const groups = groupsOf(stepOutput(steps, "converge"), merged.length);
  const representatives = groups.map((group) => merged[group.representative]!);
  function check(candidate: Candidate) {
    return { text: checkMessage(request, candidate, fileOf(files, candidate.path)!), inference: inference.check };
  }
  return { groups, candidates: representatives, checks: representatives.map(check) };
}

const STOPPED_EARLY = "<stopped_early>The review spent its budget before it finished reading the repository. Say in the summary that it stopped early and reports what it found.</stopped_early>\n\n";

/** The confirmed candidates and the write step's user message. */
export async function writeInput(steps: Steps): Promise<WriteInput> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { candidates: checked } = stepOutput(steps, "checks");
  const { budgetExhausted } = stepOutput(steps, "candidates");
  const verdicts = stepOutput(steps, "check").map((output) => jsonReply<Verdict>(output));
  const confirmed = checked.filter((_, i) => verdicts[i]?.verdict === "real");
  const findings = confirmed.map(({ path, start, end, title, why, trigger, code }, finding) => ({ finding, path, start, end, title, why, trigger, code }));
  const change = `<pull_request>\n<title>${request.title}</title>\n<description>${request.description}</description>\n<changed_files>\n${changedFiles(request.diff).join("\n")}\n</changed_files>\n</pull_request>`;
  const text = `${change}\n\n<findings>\n${JSON.stringify(findings, null, 2)}\n</findings>\n\n${budgetExhausted ? STOPPED_EARLY : ""}Write the review.`;
  return { budgetExhausted, verdicts, confirmed, text, inference: inference.write };
}

/** The review to post: the summary, each comment anchored where the finding it names is, and whether it stopped early. */
export async function review(steps: Steps) {
  const { confirmed, budgetExhausted } = stepOutput(steps, "writeInput");
  const written = jsonReply<{ summary: string; comments: { finding: number; title: string; body: string }[] }>(stepOutput(steps, "write"));
  function anchored({ finding, title, body }: (typeof written.comments)[number]) {
    const at = confirmed[finding];
    if (!at) throw new Error(`write commented on finding ${finding} of ${confirmed.length}`);
    return { path: at.path, start: at.start, end: at.end, title, body };
  }
  return { summary: written.summary, comments: written.comments.map(anchored), budgetExhausted };
}
