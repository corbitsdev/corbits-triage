import { getChecks, getReviews, listIssueComments, listPrCommits, listPrFilesPage, readPr, readRepoDocsPage, repoDocs, type GithubFetch, type RepoDocsPage, type Review } from "@corbits/github-reads";
import { classificationSources, NO_CHANGES_REQUESTED, QUALITY_CHECK_IDS, repoPolicy, type CheckPack } from "@corbits/triage-contracts";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { parts } from "@corbits/triage-workflows/actions/parts";
import { rules } from "@corbits/triage-workflows/actions/rules";
import { checkName } from "@corbits/triage-contracts";
import type { SuggestedAction, SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { hasModelChecks, type CheckResult, type PrFileFacts } from "@corbits/triage-workflows/logic/checks";
import { addFilesPage, assembleItem, fileFacts, FIRST_FILES_PAGE, type FilesCursor, type ListedFiles, type RepoDocs } from "@corbits/triage-workflows/logic/facts";
import type { Judged } from "@corbits/triage-workflows/logic/item";
import { previewActions } from "@corbits/triage-workflows/logic/preview";
import { commentTitle, NEEDS_JUDGE_REASON, NOTHING_TO_CHANGE, type Verdict } from "@corbits/triage-workflows/logic/render";
import type { PrRef } from "./pr.ts";
import { suggest } from "./suggest.ts";
import { askChunk, type SystemOneSettings } from "./system-one.ts";
import { readinessOf, type TriageView } from "./view.ts";

type EffectContext = Parameters<typeof rules>[1];

const NO_EFFECTS: EffectContext = {
  async perform() {
    throw new Error("local mode performs no effects");
  },
};

function isDo(action: SuggestedAction): action is SuggestedDo {
  return "effectId" in action;
}

/** Every file of the pull request, with patches until the evaluation budget is spent, as the facts director reads them. */
async function listFiles(gh: GithubFetch, repo: string, number: number): Promise<PrFileFacts[]> {
  const listed: ListedFiles = { files: [], patchChars: 0 };
  let cursor: FilesCursor | undefined = FIRST_FILES_PAGE;
  while (cursor) {
    const { offset, patchOffset, patches } = cursor;
    const page = await listPrFilesPage(gh, repo, number, { offset, ...(patchOffset === undefined ? {} : { patchOffset }), patches });
    const next = addFilesPage(listed, cursor, { ...page, files: page.files.flatMap(fileFacts) });
    if (typeof next === "string") throw new Error(`${next} for #${number}`);
    cursor = next;
  }
  return listed.files;
}

/** The repository's docs and contribution rules the decision model reads, by path, as the facts director gathers them. */
async function readDocs(gh: GithubFetch, repo: string): Promise<RepoDocs> {
  const pages: RepoDocsPage[] = [await readRepoDocsPage(gh, repo)];
  for (;;) {
    const { next, ref } = pages.at(-1)!;
    if (next === undefined) return repoDocs(pages);
    const page = await readRepoDocsPage(gh, repo, { ref, offset: next });
    if (page.next !== undefined && page.next <= next) throw new Error(`github_read_repo_docs did not advance past offset ${next}`);
    pages.push(page);
  }
}

/** `docs` reads the repository's docs some other way than `gh`; the API's reads are the fallback when it fails. */
export type LocalRunDeps = { gh: GithubFetch; pack: CheckPack; systemOne?: SystemOneSettings; docs?: (repo: string) => Promise<RepoDocs>; judged?: Judged };

/** Each check run's page by name, from the check runs `getChecks` already read, so no request is made again. */
async function jobPages(gh: GithubFetch, repo: string, sha: string): Promise<Record<string, string>> {
  const res = await gh(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  if (!res.ok) throw new Error(`github check runs for ${sha} -> ${res.status}`);
  const runs = ((await res.json()) as { check_runs?: Array<{ name?: string; html_url?: string }> }).check_runs ?? [];
  // Only GitHub's own pages are linked from the page Triage draws on.
  return Object.fromEntries(runs.flatMap((run) => (run.name && run.html_url?.startsWith("https://github.com/") ? [[run.name, run.html_url]] : [])));
}

/** The repository's docs, read by `own` when given, with the API's reads as the fallback. */
async function docsOf(gh: GithubFetch, repo: string, own: LocalRunDeps["docs"]): Promise<RepoDocs> {
  if (!own) return readDocs(gh, repo);
  try {
    return await own(repo);
  } catch (cause) {
    console.warn(`Read ${repo}'s docs through the GitHub API instead: ${cause instanceof Error ? cause.message : String(cause)}`);
    return readDocs(gh, repo);
  }
}

/** A read only a suggestion needs: when it fails, the run still stands and that suggestion is left out. */
async function withoutSuggestion<T>(read: Promise<T>, nothing: T, what: string): Promise<T> {
  try {
    return await read;
  } catch (cause) {
    console.warn(`Could not read ${what}, so nothing is suggested from it: ${cause instanceof Error ? cause.message : String(cause)}`);
    return nothing;
  }
}

/** A read a run can go without: when it fails, what it feeds is unconfirmed rather than the run failing. */
type Optional<T> = { value: T; failed?: string };

const NOT_READ: Optional<never[]> = { value: [] };

async function optional<T>(read: Promise<T>, nothing: T, what: string): Promise<Optional<T>> {
  try {
    return { value: await read };
  } catch (cause) {
    console.warn(`Could not read ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { value: nothing, failed: `couldn't read ${what} from GitHub` };
  }
}

type Read = "checks" | "reviews" | "comments" | "commits" | "files" | "docs";

/** Which checks each read feeds, by the facts they are decided on. */
const FEEDS: Record<Read, (c: CheckResult) => boolean> = {
  checks: (c) => c.check === "ci-green",
  reviews: (c) => c.check === NO_CHANGES_REQUESTED,
  comments: (c) => c.check === NO_CHANGES_REQUESTED,
  commits: (c) => c.check === "linked-issue" || c.kind === "model",
  files: (c) => c.check === "no-forbidden-paths" || c.kind === "model",
    docs: (c) => c.kind === "model",
};

/** Each check a failed read fed, unconfirmed with why; the verdict then cannot pass, and suggests nothing. */
function unconfirmedBy(failed: Record<Read, string | undefined>, verdict: Verdict): Verdict {
  const reasons = new Map<string, string>();
  for (const [read, why] of Object.entries(failed)) {
    if (!why) continue;
    for (const c of verdict.checks) if (FEEDS[read as Read](c) && !reasons.has(c.check)) reasons.set(c.check, why);
  }
  if (!reasons.size) return verdict;
  const checks = verdict.checks.map((c) => (reasons.has(c.check) ? { ...c, result: "unconfirmed" as const, reason: reasons.get(c.check)!, evidence: [], output: { kind: "could-not-check" as const, reason: reasons.get(c.check)! } } : c));
  const notConfirmed = [...new Set(reasons.values())].map((why) => `Not confirmed: ${why}`);
  const unsure = verdict.verdict === "pass" && { verdict: "unsure" as const, actions: [], feedback: verdict.feedback.replace(commentTitle("pass"), commentTitle("unsure")).replace(NOTHING_TO_CHANGE, "") };
  return { ...verdict, checks, reasons: [...verdict.reasons, ...notConfirmed], ...unsure };
}

const NO_DOCS: RepoDocs = { docs: {}, rules: {} };

function changesRequested(reviews: Review[]): boolean {
  return reviews.some((review) => review.state === "CHANGES_REQUESTED");
}

const QUALITY = new Set<string>(QUALITY_CHECK_IDS);

/** The pack with its model checks off and its custom rules, all judged, left out, for a run with no decision model to ask. */
function withoutModelChecks(pack: CheckPack): CheckPack {
  const checks = Object.fromEntries(Object.entries(pack.checks).map(([id, row]) => [id, QUALITY.has(id) ? { ...row, enabled: false } : row]));
  return { ...pack, checks, custom: [] };
}

/** The pr-triage workflow's facts, rules and evaluate steps on one pull request, read from GitHub without a token; nothing is written. */
export async function runLocal({ repo, number }: PrRef, { gh, pack: packed, systemOne, docs: readOwnDocs, judged }: LocalRunDeps): Promise<TriageView> {
  const modelChecks = hasModelChecks(classificationSources(packed));
  const pack = systemOne ? packed : withoutModelChecks(packed);
  const [pr, reviews, commits, files] = await Promise.all([
    readPr(gh, repo, number),
    optional(getReviews(gh, repo, number), [], "the reviews"),
    optional(listPrCommits(gh, repo, number), [], "the commits"),
    optional(listFiles(gh, repo, number), [], "the changed files"),
  ]);
  const [checks, comments] = await Promise.all([
    pr.sha ? optional(getChecks(gh, repo, pr.sha), [], "CI") : NOT_READ,
    // Comments only tell whether the author answered a request for changes.
    changesRequested(reviews.value) ? optional(listIssueComments(gh, repo, number), [], "the comments") : NOT_READ,
  ]);
  const asking = systemOne !== undefined && modelChecks;
  const docs = asking ? await optional(docsOf(gh, repo, readOwnDocs), NO_DOCS, "the repository's docs") : { value: NO_DOCS };
  const failed = { checks: checks.failed, reviews: reviews.failed, comments: comments.failed, commits: commits.failed, files: files.failed, docs: docs.failed };
  const policy = repoPolicy({});
  // Local mode reads no team membership, so a step for a team is skipped as unknown.
  const facts = { pr, checks: checks.value, reviews: reviews.value, comments: comments.value, commits: commits.value, files: files.value, authorTeams: null };
  const assembled = assembleItem(number, facts, { repo, policy, pack, events: ["catch-up"], docs: docs.value });
  const item = judged && !("error" in assembled) ? { ...assembled, judged } : assembled;

  const signal = new AbortController().signal;
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
  const ruledItem = ruled.items[0]!;
  // Answered by the decision model, now or by an earlier run's answers to the same requests; without one the verdict waits on it.
  const answered = systemOne !== undefined && ruledItem.det.needsJudgment;
  const first = { items: [systemOne === undefined && ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem], batch: false };
  const asked = systemOne !== undefined && ruled.needsJudgment ? { ...first, judge: { output: await Promise.all(ruled.chunks.map((chunk) => askChunk(chunk, systemOne))) } } : first;
  const { chunks } = systemOne !== undefined ? await parts(asked, NO_EFFECTS, signal) : { chunks: [] };
  const second = chunks.length > 0 ? { ...asked, judgeParts: { output: await Promise.all(chunks.map((chunk) => askChunk(chunk, systemOne!))) } } : asked;
  const verdict = unconfirmedBy(failed, await evaluate(second, NO_EFFECTS, signal) as Verdict);

  const waits = verdict.reason === NEEDS_JUDGE_REASON ? "waits-on-judge" as const : verdict.actions;
  const preview = previewActions({ facts: ruledItem.facts, checks: verdict.checks, verdict: verdict.verdict, reason: verdict.reason, pack }, waits);
  const dos = preview.status === "decided" ? preview.dos.filter(isDo) : [];
  const { state, reason, nextAction, actor, feedback, verdict: word, score, reasons, degraded } = verdict;
  const named = verdict.checks.map((c) => ({ ...c, name: checkName(pack, c.check) }));
  const failing = new Set(named.filter((c) => c.result === "fail").map((c) => c.check));
  const jobs = failing.has("ci-green") && pr.sha ? await withoutSuggestion(jobPages(gh, repo, pr.sha), {}, "the failing jobs' pages") : {};
  const { actions: suggested, notes } = suggest({ facts: ruledItem.facts, checks: named, pack, jobs });
  return {
    pr: { repo, number },
    title: String(pr.title ?? ""),
    author: String(pr.author ?? ""),
    headSha: ruledItem.facts.headSha,
    ranAt: new Date().toISOString(),
    // Not run: the pack's model checks were left out, with no decision model to ask.
    judge: answered ? "asked" : modelChecks && !systemOne ? "not-run" : "not-needed",
    ...(verdict.judged ? { judged: verdict.judged } : {}),
    verdict: { state, reason, nextAction, actor, feedback, verdict: word, score, reasons, degraded },
    readiness: readinessOf(verdict.checks, degraded),
    checks: named,
    dos,
    waitingOnJudge: preview.status === "waits-on-judge" ? preview.lists.reduce((count, list) => count + list.dos.length, 0) : 0,
    suggested,
    notes,
    draft: ruledItem.facts.draft,
  };
}
