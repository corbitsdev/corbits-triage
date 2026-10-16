import { type } from "arktype";
import { triggerRequestOf } from "@corbits/triage-contracts";
import { changedFiles, firstJsonObject, isRecord, parseFindings, quotedLine, samePath, type Finding, type Site } from "../findings.js";
import { BUDGET_EXHAUSTED, budgetTag, Checkout, DEFAULT_BUDGET, repositoryTag } from "./checkout.js";

const MAX_OUTPUT_TOKENS = 16_000;

// The check's budget of billable tokens for each finding it verifies.
const CHECK_BUDGET_PER_FINDING = 40_000;

const Effort = type("'low' | 'medium' | 'high'");

const ROLES = ["plan", "diffFinder", "repoFinder", "consolidate", "check", "write"] as const;
type Role = (typeof ROLES)[number];

const DEFAULT_EFFORTS: Record<Role, typeof Effort.infer> = { plan: "medium", diffFinder: "medium", repoFinder: "medium", consolidate: "medium", check: "medium", write: "low" };

const ReviewRequest = type({
  kind: "'code-review'",
  title: "string",
  description: "string",
  diff: "string",
  checkout: Checkout,
  "efforts?": { "plan?": Effort, "diffFinder?": Effort, "repoFinder?": Effort, "consolidate?": Effort, "check?": Effort, "write?": Effort },
  "check?": "boolean",
  "budgets?": { "repoFinder?": "number.integer > 0" },
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
}

interface Steps {
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

/** A finder's own report of a defect a group stands for. */
interface Reasoning {
  finders: Finder[];
  title?: string;
  why?: string;
  trigger?: string;
}

const Line = "number.integer > 0";

const Verdict = type({
  finding: "number.integer >= 0",
  verdict: "'keep' | 'uncertain' | 'refuted'",
  reason: "string",
  "refutation?": { path: "string > 0", start: Line, end: Line, code: "string" },
  "start?": Line,
  "end?": Line,
  "priority?": "0 | 1 | 2 | 3",
  "why?": "string",
});
type Verdict = typeof Verdict.infer;

/** A finding the review posts, and why the check left it uncertain when it did. */
interface Posted extends Reported {
  uncertain?: string;
}

/** A finding the check proved wrong, with the reason and the lines that prove it. */
interface Refuted extends Reported {
  reason: string;
  refutation: NonNullable<Verdict["refutation"]>;
}

interface Checks {
  findings: Reported[];
  checks: { text: string; inference: StepInference }[];
}

interface WriteInput {
  budgetExhausted: boolean;
  findings: Posted[];
  refuted: Refuted[];
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
  return `${repositoryTag(request.checkout)}${aboutPullRequest(request)}\n\n<findings>\n${JSON.stringify(listed, null, 2)}\n</findings>\n\nGroup the findings by the defect they describe.`;
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

function reasoningOf(group: Group, kept: readonly Candidate[]): Reasoning[] {
  return group.members.map((i) => kept[i]!).map(({ finders, title, why, trigger }) => ({ finders, title, why, trigger }));
}

interface Ordered {
  finding: Reported;
  excerpt: string;
  reasoning: Reasoning[];
}

function checkMessage(request: ReviewRequest, ordered: readonly Ordered[]): string {
  function listed({ finding: { path, start, end, code, priority, agreement }, excerpt, reasoning }: Ordered, finding: number) {
    return { finding, path, start, end, code, priority, agreement, reports: reasoning, cited_code: excerpt };
  }
  const findings = JSON.stringify(ordered.map(listed), null, 2);
  return `${repositoryTag(request.checkout)}${budgetTag(ordered.length * CHECK_BUDGET_PER_FINDING)}${pullRequest(request)}\n\n<findings>\n${findings}\n</findings>\n\nVerify each finding.`;
}

/** Every consolidated finding, ordered by severity then agreement, and one check of them all when the request asks for the check and there are any. */
export async function checks(steps: Steps): Promise<Checks> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { kept } = stepOutput(steps, "candidates");
  const { groups, sites, excerpts } = jsonReply<{ groups: Group[]; sites: Site[]; excerpts: string[] }>(stepOutput(steps, "consolidate"));
  function ordered(group: Group): Ordered {
    return { finding: reportedOf(group, kept, sites), excerpt: excerpts[group.representative]!, reasoning: reasoningOf(group, kept) };
  }
  const all = joinedAtAnchors(groupsOf(groups, kept.length), kept, sites).map(ordered).sort((a, b) => bySeverityThenAgreement(a.finding, b.finding));
  const checked = request.check && all.length > 0 ? [{ text: checkMessage(request, all), inference: inference.check }] : [];
  return { findings: all.map((o) => o.finding), checks: checked };
}

const STOPPED_EARLY = "<stopped_early>The review spent its budget before it finished reading the repository. Say in the summary that it stopped early and reports what it found.</stopped_early>\n\n";

const UNSETTLED = "The check did not settle it.";

/** The check's verdict on each finding by number; a finding it gave no valid verdict is uncertain. */
function verdictsOf(output: unknown, count: number): Verdict[] {
  const json = firstJsonObject(replyOf(output).replace(BUDGET_EXHAUSTED, ""));
  const given = isRecord(json) && Array.isArray(json.verdicts) ? json.verdicts.map((v) => Verdict(v)) : [];
  const valid = given.filter((v): v is Verdict => !(v instanceof type.errors));
  function verdict(finding: number): Verdict {
    return valid.find((v) => v.finding === finding) ?? { finding, verdict: "uncertain", reason: UNSETTLED };
  }
  return Array.from({ length: count }, (_, finding) => verdict(finding));
}

/** The finding with the lines, priority and explanation the check corrected. */
function corrected(finding: Reported, { start, end, priority, why }: Verdict): Reported {
  const lines = start !== undefined && end !== undefined && start <= end ? { start, end } : {};
  return { ...finding, ...lines, ...(priority !== undefined && { priority }), ...(why !== undefined && { why }) };
}

/** The findings to post, corrected and with the uncertain ones marked (all of them as found when the check did not run), the refuted ones, and the write step's user message. */
export async function writeInput(steps: Steps): Promise<WriteInput> {
  const { request, inference } = stepOutput(steps, "reviewInput");
  const { budgetExhausted } = stepOutput(steps, "candidates");
  const { findings: checked } = stepOutput(steps, "checks");
  const [check] = stepOutput(steps, "check");
  const verdicts = check === undefined ? [] : verdictsOf(check, checked.length);
  const findings: Posted[] = [];
  const refuted: Refuted[] = [];
  for (const [i, finding] of checked.entries()) {
    const verdict = verdicts[i];
    if (!verdict) {
      findings.push(finding);
      continue;
    }
    const { refutation } = verdict;
    // A refutation that cites no code leaves the finding open.
    if (verdict.verdict === "refuted" && refutation) refuted.push({ ...finding, reason: verdict.reason, refutation });
    else if (verdict.verdict === "keep") findings.push(corrected(finding, verdict));
    else findings.push({ ...corrected(finding, verdict), uncertain: verdict.reason });
  }
  const listed = findings.map(({ path, start, end, title, why, trigger, code }, finding) => ({ finding, path, start, end, title, why, trigger, code }));
  const change = `<pull_request>\n<title>${request.title}</title>\n<description>${request.description}</description>\n<changed_files>\n${changedFiles(request.diff).join("\n")}\n</changed_files>\n</pull_request>`;
  const text = `${change}\n\n<findings>\n${JSON.stringify(listed, null, 2)}\n</findings>\n\n${budgetExhausted ? STOPPED_EARLY : ""}Write the review.`;
  return { budgetExhausted, findings, refuted, text, inference: inference.write };
}

interface Written {
  summary: string;
  comments: { finding: number; title: string; body: string }[];
}

/** A comment from whatever the finder gave: its title or the defect it was grouped under, why, trigger and quoted code. */
function ownWords({ title, defect, why, trigger, code, path, start }: Reported) {
  const quoted = code === undefined ? undefined : `\`\`\`\n${code}\n\`\`\``;
  const heading = [title, defect, why].find((part) => part !== undefined && part !== "") ?? `Defect at ${path}:${start}`;
  return { title: heading, body: [why, trigger, quoted].filter((part) => part !== undefined).join("\n\n") };
}

function agreementLine({ finders, reports }: Agreement): string {
  return `_Found by ${finders} of ${FINDERS.length} finders, ${reports} ${reports === 1 ? "report" : "reports"}._`;
}

/**
 * The review to post: the summary, one comment per finding in order, anchored where the finding is and ending with what
 * the check left open, if anything, and its agreement, and whether it stopped early. A finding the write step left
 * without a comment gets one in its finder's words.
 */
export async function review(steps: Steps) {
  const { findings, budgetExhausted } = stepOutput(steps, "writeInput");
  const written = jsonReply<Written>(stepOutput(steps, "write"));
  function comment(finding: Posted, index: number) {
    const { path, start, end, agreement, priority, uncertain } = finding;
    const { title, body } = written.comments.find((c) => c.finding === index) ?? ownWords(finding);
    return { path, start, end, title, body: [body, ...(uncertain === undefined ? [] : [`_Unconfirmed: ${uncertain}_`]), agreementLine(agreement)].join("\n\n"), ...(priority !== undefined && { priority }), agreement };
  }
  return { summary: written.summary, comments: findings.map(comment), budgetExhausted };
}
