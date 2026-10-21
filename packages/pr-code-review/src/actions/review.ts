import { type } from "arktype";
import { triggerRequestOf } from "@corbits/triage-contracts";
import { changedFiles, parseFindings, quotedLine, samePath, type Finding, type Site } from "../findings.js";
import { Effort, ROLES, type CodeReviewProfile, type Role } from "../profile.js";
import { promptAttribute, promptText } from "../prompt-text.js";
import { BUDGET_EXHAUSTED, budgetTag, Checkout, DEFAULT_BUDGET, repositoryTag } from "./checkout.js";

const MAX_OUTPUT_TOKENS = 16_000;

const ReviewRequest = type({
  kind: "'code-review'",
  title: "string",
  description: "string",
  diff: "string",
  checkout: Checkout,
  "efforts?": { "plan?": Effort, "diffFinder?": Effort, "repoFinder?": Effort, "consolidate?": Effort, "check?": Effort, "write?": Effort },
  "check?": "boolean",
  "budgets?": { "repoFinder?": "number.integer > 0" },
  /** The pull request's number, so a run can be found by it. */
  "number?": "number.integer > 0",
  /** Set when the diff was cut to its first `lines` of `of` lines to keep the review within its size limit, with the files it cut part-way or left out. */
  "cut?": { lines: "number.integer >= 0", of: "number.integer > 0", "unread?": "string[]" },
});
type ReviewRequest = typeof ReviewRequest.infer;

const FINDERS = ["diff", "repo"] as const;
type Finder = (typeof FINDERS)[number];

/** A finding, the finders that reported it and how many of their findings it stands for. */
interface Candidate extends Finding {
  finders: Finder[];
  reports: number;
}

interface Agreement {
  finders: number;
  reports: number;
}

interface Reported extends Finding {
  defect: string;
  agreement: Agreement;
  /** Set when no member of its group had a line read, so its lines are the finder's alone. */
  unverified?: true;
}

interface Steps {
  /** The review's step ids sit under it in a definition that holds other steps too. */
  $prefix?: string;
  reviewInput?: { output: ReviewInput };
  plan?: { output: unknown };
  findDiff?: { output: unknown };
  findRepo?: { output: unknown };
  candidates?: { output: Candidates };
  consolidate?: { output: unknown };
  checks?: { output: Checks };
  check?: { output: unknown[] };
  writeInput?: { output: WriteInput };
  write?: { output: unknown };
}

interface StepInference {
  effort: Effort;
  maxTokens: number;
}

interface ReviewInput {
  request: ReviewRequest;
  plan: string;
  inference: Record<Role, StepInference>;
}

interface Candidates {
  found: Candidate[];
  kept: Candidate[];
  budgetExhausted: boolean;
  consolidate: string;
  inference: StepInference;
}

interface Group {
  defect: string;
  members: number[];
  representative: number;
}

interface Verdict {
  verdict: "real" | "not_real";
  reason: string;
}

interface Checks {
  findings: Reported[];
  checks: { text: string; inference: StepInference }[];
}

interface WriteInput {
  budgetExhausted: boolean;
  verdicts: Verdict[];
  findings: Reported[];
  text: string;
  inference: StepInference;
}

function replyOf(output: unknown): string {
  if (typeof output === "object" && output !== null && "reply" in output && typeof output.reply === "string") return output.reply;
  throw new Error("step output has no reply");
}

/** A structured step's JSON reply; the error leaves the reply out, as the portal shows it. */
function jsonReply<T>(output: unknown): T {
  const reply = replyOf(output).replace(BUDGET_EXHAUSTED, "");
  try {
    return JSON.parse(reply) as T;
  } catch {
    throw new Error("step replied without JSON");
  }
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

function pullRequest(request: ReviewRequest): string {
  const cut = request.cut ? `\n\nThe diff shows its first ${request.cut.lines} of ${request.cut.of} lines; the rest was left out for size.` : "";
  return `${aboutPullRequest(request)}\n\n<diff>\n${promptText(request.diff)}\n</diff>${cut}`;
}

/** The reviewInput action: the request from the trigger mail, the plan's user message and every role's per-call options; a role's effort is the request's, else the profile's. */
export function reviewInputFor({ efforts }: Pick<CodeReviewProfile, "efforts">) {
  return async function reviewInput(input: unknown): Promise<ReviewInput> {
    const request = ReviewRequest(triggerRequestOf(input));
    if (request instanceof type.errors) throw new Error(`reviewInput: invalid request: ${request.summary}`);
    const inference = Object.fromEntries(ROLES.map((role) => [role, { effort: request.efforts?.[role] ?? efforts[role], maxTokens: MAX_OUTPUT_TOKENS }])) as Record<Role, StepInference>;
    return { request, plan: `${pullRequest(request)}\n\nPlan the review of this pull request.`, inference };
  };
}

/** Both finders' user messages with the plan appended; the repository finder's names its checkout and token budget. */
export async function findersInput(steps: Steps) {
  const { request } = stepOutput(steps, "reviewInput");
  const plan = replyOf(stepOutput(steps, "plan"));
  const message = `${pullRequest(request)}\n\n<plan>\n${promptText(plan)}\n</plan>\n\nReview the diff above and report the defects this change introduces.`;
  return { diff: message, repo: `${repositoryTag(request.checkout)}${budgetTag(request.budgets?.repoFinder ?? DEFAULT_BUDGET)}${message}` };
}

/** A finder's findings; one that spent its budget before answering in JSON found none, and the finder steps fail on any other unreadable reply. */
function findingsOf(output: unknown, finder: Finder): Candidate[] {
  const reply = replyOf(output);
  const parsed = parseFindings(reply.replace(BUDGET_EXHAUSTED, ""));
  if ("unparsable" in parsed) {
    if (reply.startsWith(BUDGET_EXHAUSTED)) return [];
    throw new Error(`${finder} finder: ${parsed.unparsable}`);
  }
  return parsed.findings.map((finding) => ({ ...finding, finders: [finder], reports: 1 }));
}

function sameCode(a: Finding, b: Finding): boolean {
  const quoted = quotedLine(a);
  return quoted !== undefined && quoted === quotedLine(b) && samePath(a.path, b.path) && a.start <= b.end && a.end >= b.start;
}

/** The candidates with each exact duplicate (same file, overlapping lines, same first quoted line) folded into the first. */
function withoutDuplicates(found: readonly Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const candidate of found) {
    const index = kept.findIndex((k) => sameCode(k, candidate));
    if (index === -1) {
      kept.push(candidate);
      continue;
    }
    const first = kept[index]!;
    kept[index] = { ...first, finders: [...new Set([...first.finders, ...candidate.finders])], reports: first.reports + candidate.reports };
  }
  return kept;
}

function consolidateMessage(request: ReviewRequest, kept: readonly Candidate[]): string {
  const listed = kept.map(({ path, start, end, code, title, why, trigger }, index) => ({ index, path, start, end, code, title, why, trigger }));
  return `${repositoryTag(request.checkout)}${aboutPullRequest(request)}\n\n<findings>\n${promptText(JSON.stringify(listed, null, 2))}\n</findings>\n\nGroup the findings by the defect they describe.`;
}

/** Both finders' findings, those left once exact duplicates are folded together, whether the repository finder's budget ran out, and the consolidate step's message. */
export async function candidates(steps: Steps): Promise<Candidates> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const found = [...findingsOf(stepOutput(steps, "findDiff"), "diff"), ...findingsOf(stepOutput(steps, "findRepo"), "repo")];
  const kept = withoutDuplicates(found);
  const budgetExhausted = replyOf(stepOutput(steps, "findRepo")).startsWith(BUDGET_EXHAUSTED);
  return { found, kept, budgetExhausted, consolidate: consolidateMessage(request, kept), inference: inference.consolidate };
}

/** The consolidate step's groups, with every candidate it left out or repeated in a group of its own. */
function groupsOf(groups: readonly Group[], count: number): Group[] {
  const seen = new Set<number>();
  const valid: Group[] = [];
  for (const group of groups) {
    const members = group.members.filter((i) => Number.isInteger(i) && i >= 0 && i < count && !seen.has(i));
    if (members.length === 0) continue;
    for (const i of members) seen.add(i);
    valid.push({ defect: group.defect, members, representative: members.includes(group.representative) ? group.representative : members[0]! });
  }
  for (let i = 0; i < count; i++) if (!seen.has(i)) valid.push({ defect: "", members: [i], representative: i });
  return valid;
}

function overlapsAt(a: Group, b: Group, at: readonly Finding[]): boolean {
  return a.members.some((i) => b.members.some((j) => sameCode(at[i]!, at[j]!)));
}

/** The groups with any that hold the same first quoted line at overlapping anchored lines joined into the first of them. */
function joinedAtAnchors(groups: readonly Group[], kept: readonly Candidate[], sites: readonly Site[]): Group[] {
  const at = kept.map((candidate, i) => ({ ...candidate, ...sites[i]! }));
  let joined: Group[] = [];
  for (const group of groups) {
    const matching = joined.filter((other) => overlapsAt(other, group, at));
    if (matching.length === 0) {
      joined.push(group);
      continue;
    }
    const members = [...matching.flatMap((other) => other.members), ...group.members];
    joined = [...joined.filter((other) => !matching.includes(other)), { ...matching[0]!, members }];
  }
  return joined;
}

/** The group with a member whose lines were read as its representative, when its own were not and one was. */
function readRepresentative(group: Group, unreadFindings: readonly number[]): Group {
  const read = group.members.find((i) => !unreadFindings.includes(i));
  return unreadFindings.includes(group.representative) && read !== undefined ? { ...group, representative: read } : group;
}

/** The group's representative, at its anchored site, with the most severe priority and the agreement of all its members. */
function reportedOf(group: Group, kept: readonly Candidate[], sites: readonly Site[]): Reported {
  const members = group.members.map((i) => kept[i]!);
  const { path, start, end } = sites[group.representative]!;
  const { title, why, trigger, code } = kept[group.representative]!;
  const priorities = members.flatMap((m) => (m.priority === undefined ? [] : [m.priority]));
  const agreement = { finders: new Set(members.flatMap((m) => m.finders)).size, reports: members.reduce((total, m) => total + m.reports, 0) };
  return { path, start, end, title, why, trigger, code, ...(priorities.length > 0 && { priority: Math.min(...priorities) }), defect: group.defect, agreement };
}

function severityOf(finding: Reported): number {
  return finding.priority ?? Number.POSITIVE_INFINITY;
}

function bySeverityThenAgreement(a: Reported, b: Reported): number {
  return severityOf(a) - severityOf(b) || b.agreement.finders - a.agreement.finders || b.agreement.reports - a.agreement.reports;
}

function checkMessage(request: ReviewRequest, finding: Reported, excerpt: string): string {
  const claim = { title: finding.title, why: finding.why, trigger: finding.trigger };
  return [
    aboutPullRequest(request),
    `<candidate path="${promptAttribute(finding.path)}" start="${finding.start}" end="${finding.end}">\n${promptText(JSON.stringify(claim, null, 2))}\n</candidate>`,
    `<quoted_code>\n${promptText(String(finding.code))}\n</quoted_code>`,
    `<file path="${promptAttribute(finding.path)}">\n${promptText(excerpt)}\n</file>`,
    "Is this defect real?",
  ].join("\n\n");
}

/** Every consolidated finding, ordered by severity then agreement, and one check of each when the request asks for the check. */
export async function checks(steps: Steps): Promise<Checks> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { kept } = stepOutput(steps, "candidates");
  const { groups, sites, excerpts, unreadFindings } = jsonReply<{ groups: Group[]; sites: Site[]; excerpts: string[]; unreadFindings: number[] }>(stepOutput(steps, "consolidate"));
  function reported(joined: Group) {
    const group = readRepresentative(joined, unreadFindings);
    const finding = reportedOf(group, kept, sites);
    return { finding: unreadFindings.includes(group.representative) ? { ...finding, unverified: true as const } : finding, excerpt: excerpts[group.representative]! };
  }
  const ordered = joinedAtAnchors(groupsOf(groups, kept.length), kept, sites).map(reported).sort((a, b) => bySeverityThenAgreement(a.finding, b.finding));
  function check({ finding, excerpt }: (typeof ordered)[number]) {
    return { text: checkMessage(request, finding, excerpt), inference: inference.check };
  }
  return { findings: ordered.map((o) => o.finding), checks: request.check ? ordered.map(check) : [] };
}

/** The findings to report, all of them or, when the request asks for the check, those it found real, and the write step's user message. */
export async function writeInput(steps: Steps): Promise<WriteInput> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { budgetExhausted } = stepOutput(steps, "candidates");
  const { findings: checked } = stepOutput(steps, "checks");
  const verdicts = stepOutput(steps, "check").map((output) => jsonReply<Verdict>(output));
  const findings = request.check ? checked.filter((_, i) => verdicts[i]?.verdict === "real") : checked;
  const listed = findings.map(({ path, start, end, title, why, trigger, code }, finding) => ({ finding, path, start, end, title, why, trigger, code }));
  const change = `<pull_request>\n<title>${promptText(request.title)}</title>\n<description>${promptText(request.description)}</description>\n<changed_files>\n${promptText(changedFiles(request.diff).join("\n"))}\n</changed_files>\n</pull_request>`;
  const text = `${change}\n\n<findings>\n${promptText(JSON.stringify(listed, null, 2))}\n</findings>\n\nWrite the review.`;
  return { budgetExhausted, verdicts, findings, text, inference: inference.write };
}

interface Written {
  summary: string;
  comments: { finding: number; title: string; body: string }[];
}

/** A comment from whatever the finder gave: its title or the defect it was grouped under, why and trigger; the quoted code travels beside it. */
function ownWords({ title, defect, why, trigger, path, start }: Reported) {
  const heading = [title, defect, why].find((part) => part !== undefined && part !== "") ?? `Defect at ${path}:${start}`;
  return { title: heading, body: [why, trigger].filter((part) => part !== undefined).join("\n\n") };
}

/**
 * The review: the summary, one comment per finding in order, anchored where the finding is, with the code it quotes, its
 * agreement and whether its lines went unread, and whether it stopped early. A finding the write step left without a
 * comment gets one in its finder's words.
 */
export async function review(steps: Steps) {
  const { request } = stepOutput(steps, "reviewInput");
  const { findings, budgetExhausted } = stepOutput(steps, "writeInput");
  const written = jsonReply<Written>(stepOutput(steps, "write"));
  function comment(finding: Reported, index: number) {
    const { path, start, end, agreement, priority, code, unverified } = finding;
    const { title, body } = written.comments.find((c) => c.finding === index) ?? ownWords(finding);
    return { path, start, end, title, body, ...(priority !== undefined && { priority }), ...(code !== undefined && { quoted: code }), agreement, ...(unverified && { unverified }) };
  }
  return { summary: written.summary, comments: findings.map(comment), budgetExhausted, ...(request.cut && { cut: request.cut }) };
}
