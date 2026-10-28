import type { EffectContext, PerformScope } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { ACTION_KINDS, catalogCheckEnabled, classificationSources, customCheckEnabled, DEFAULT_RISK, emptyPack, isPatternsCheck, PolicySourceShape, repoPolicy, repoSourceOf, triageEventsOf, trustedRequestOf, visibleText, type ActionKind, type CheckPack, type PolicySource, type RepoSource, type TriageEvent } from "@corbits/triage-contracts";
import { repoDocs, type ClosedPr, type IssueComment, type RepoDocsPage, type Review, type RuleSpan } from "@corbits/github-reads";
import { isRecord } from "@corbits/common";
import { DEPLOYMENT_UNREADABLE, hasModelChecks, NEEDS_SETUP_REASON, packFromInput, type PrFacts } from "../logic/checks.js";
import { asText } from "../logic/extract.js";
import { addFilesPage, assembleItem, fileFacts, FIRST_FILES_PAGE, optionalCount, namedTeams, type CheckRun, type FilesCursor, type FilesPage, type ListedFiles, type PrData, type PullData, type RepoDocs } from "../logic/facts.js";
import { couldRepeat, MAX_OPEN_PULLS, overlapping, type OpenPull, type OpenPulls, type PullPrint } from "../logic/duplicates.js";
import type { History } from "../logic/history.js";
import { filesToRead, patternsResult, type PatternsResult } from "../logic/patterns.js";
import { call, data, hostCalls, READ_PULL_REQUEST, runAll, toolName, type HostCall } from "../logic/host.js";
import { fixCount, historyPaths } from "../logic/risk.js";
import { POLICY_UNREADABLE } from "../logic/settled.js";
import type { RulesItem } from "./rules.js";

export type FactsOutput = { items: RulesItem[]; batch: boolean } | History;

function ruleSpans(rows: unknown[]): RuleSpan[] {
  return rows.flatMap((span) => {
    if (!isRecord(span) || typeof span.path !== "string") return [];
    const docsBytes = optionalCount(span.docsBytes);
    const rulesBytes = optionalCount(span.rulesBytes);
    return docsBytes === undefined || rulesBytes === undefined ? [] : [{ path: span.path, docsBytes, rulesBytes }];
  });
}

/** An unreadable docs page would hide docs the judge needs, so it is an error instead. */
function docsPage(tool: string, r: ToolResult | undefined): RepoDocsPage | string {
  if (!r) return `${tool} did not answer`;
  if (r.isError) return `${tool} failed: ${asText(r.content)}`;
  const content = data<{ docs?: unknown; rules?: unknown; ref?: unknown; next?: unknown }>(r);
  if (!content || !Array.isArray(content.docs) || !Array.isArray(content.rules) || typeof content.ref !== "string") return `${tool} result is unreadable`;
  const next = optionalCount(content.next);
  const docs = content.docs.flatMap((doc) => (isRecord(doc) && typeof doc.path === "string" && typeof doc.text === "string" ? [{ path: doc.path, text: doc.text }] : []));
  return { docs, rules: ruleSpans(content.rules), ref: content.ref, ...(next === undefined ? {} : { next }) };
}

/** Unread templates would leave their comments to be flagged as the author's, so they are an error instead. */
function templatesRead(tool: string, r: ToolResult | undefined): string[] | string {
  if (!r) return `${tool} did not answer`;
  if (r.isError) return `${tool} failed: ${asText(r.content)}`;
  const templates = data<{ templates?: unknown }>(r)?.templates;
  if (!Array.isArray(templates) || !templates.every((text) => typeof text === "string")) return `${tool} result is unreadable`;
  return templates;
}

/** An unreadable file list would read as a pull request that changes nothing, so it is an error instead. */
function filesPage(tool: string, r: ToolResult | undefined): FilesPage | string {
  if (!r) return `${tool} did not answer`;
  if (r.isError) return `${tool} failed: ${asText(r.content)}`;
  const content = data<{ files?: unknown; next?: unknown; patchNext?: unknown }>(r);
  if (!content || !Array.isArray(content.files)) return `${tool} result is unreadable`;
  const next = optionalCount(content.next);
  const patchNext = optionalCount(content.patchNext);
  return { files: content.files.flatMap(fileFacts), ...(next === undefined ? {} : { next }), ...(patchNext === undefined ? {} : { patchNext }) };
}

/** The policy versions the hub's mail names; a mail from before it named them has none. */
function policySource(request: Record<string, unknown>): PolicySource | undefined {
  const source = isRecord(request.policy) ? PolicySourceShape(request.policy.source) : undefined;
  return source instanceof type.errors ? undefined : source;
}

/** The Do kinds the hub's mail says the pr-triage role is granted; only the hub's mail is trusted to grant any. Undefined when that mail names no list, which fails the read. */
function automaticKinds(trusted: boolean, request: Record<string, unknown> | undefined): ActionKind[] | undefined {
  const kinds = request?.automatic;
  if (!trusted) return [];
  if (!Array.isArray(kinds)) return undefined;
  return ACTION_KINDS.filter((kind) => kinds.includes(kind));
}

/** The head the mail names for each pull request: one as `prNumber`/`headSha`, or several as `items` of the same. */
function mailHeads(request: Record<string, unknown>): Map<number, string> {
  const named = Array.isArray(request.items) ? request.items : [request];
  return new Map(named.flatMap((item): Array<[number, string]> => (isRecord(item) && typeof item.prNumber === "number" && typeof item.headSha === "string" ? [[item.prNumber, item.headSha]] : [])));
}

/** What each item read for a pull request carries besides its facts. */
interface Stamp {
  automatic: ActionKind[];
  source?: PolicySource;
  repoSource: RepoSource;
  noWait: boolean;
  /** The head is new enough that its CI may not have started, so no checks yet reads as checks pending. */
  ciStarting: boolean;
  /** The mail names blocks, so the comment lists no Dos and approve and merge wait in Needs you. */
  blocksOn: boolean;
  /** The head the mail names for each pull request. */
  heads: Map<number, string>;
  /** The App's bot account the hub's mail names, whose marked reviews are triage's own. */
  appLogin?: string;
}

interface Host {
  host: HostCall;
  stamp: Stamp;
}

type ListPart = "reviews" | "comments" | "commits" | "checks";

interface FetchContext {
  policy: ReturnType<typeof repoPolicy>;
  pack: CheckPack;
  events: TriageEvent[];
  docs: RepoDocs | string;
  templates: string[] | string;
  firstFiles: FilesCursor;
  /** A list that could not be read would read as none, hiding a review asking for changes or a failing check, so one the caller uses leaves the pull request unread. */
  lists: ListPart[];
}

/** A scan reads paths and sizes, not patches. */
const HISTORY_FILES_PAGE: FilesCursor = { offset: 0, patches: false };

/** Pull requests, file histories or file contents read at once, so the host sees a bounded number of concurrent requests. */
export const READ_CHUNK = 10;

/** The changed paths whose history one pull request reads, GitHub's own diff limit; the rest count as unread, so one pull request's reads stay bounded. */
export const MAX_HISTORY_READS = 300;

const HISTORY_LIMIT = 200;

const NO_DOCS: RepoDocs = { docs: {}, rules: {} };

const DAY_MS = 24 * 60 * 60 * 1000;

async function runChunked(host: HostCall, calls: readonly ToolCall[]): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>();
  for (let start = 0; start < calls.length; start += READ_CHUNK) {
    for (const [id, result] of await runAll(host, calls.slice(start, start + READ_CHUNK))) results.set(id, result);
  }
  return results;
}

/** Each file's text at `sha`; a file that could not be read is left out, so its rule cannot pass. */
async function readContents(host: HostCall, tool: string, repo: string, sha: string, paths: string[]): Promise<Record<string, string>> {
  const results = await runChunked(host, paths.map((path) => call(tool, { repo, sha, path, whole: true }, `content:${path}`)));
  return Object.fromEntries(paths.flatMap(function text(path): Array<[string, string]> {
    const read = data<{ text?: unknown }>(results.get(`content:${path}`))?.text;
    return typeof read === "string" ? [[path, read]] : [];
  }));
}

/** Each code-patterns rule's matches, run where the files are read so their text never leaves this step. */
async function patternsOf(host: HostCall, tool: string, repo: string, source: RepoSource, item: { facts: PrFacts; pack: CheckPack }): Promise<Record<string, PatternsResult>> {
  const rules = item.pack.custom.filter(isPatternsCheck).filter(customCheckEnabled);
  const toRead = filesToRead(item.facts.files, source);
  const contents = Array.isArray(toRead) ? await readContents(host, tool, repo, item.facts.headSha, toRead) : {};
  return Object.fromEntries(rules.map((rule) => [rule.id, patternsResult(rule, item.facts.files, contents, source)]));
}

/** An open pull request as the host lists it. */
type ListedPull = { number: number; title: string; sha?: string; draft?: boolean };

/** What the duplicate rules read: prints for no-duplicate, changed paths for duplicates-open-pull-request. */
type DuplicateReads = { prints: boolean; paths: boolean };

/** A pull request being triaged, as the duplicate rules compare it. */
type OwnPull = { number: number; title: string; headSha: string; base: string; paths: string[] };

/** Each pull request's diff hash and commits; either is left out when it could not be read. */
async function readPrints(host: HostCall, tool: (name: string) => string, repo: string, numbers: number[]): Promise<Map<number, PullPrint>> {
  const results = await runChunked(host, numbers.flatMap((n) => [call(tool("pr_diff_hash"), { repo, number: n }, `diff-hash:${n}`), call(tool("list_pr_commits"), { repo, number: n }, `open-commits:${n}`)]));
  return new Map(numbers.map(function printOf(n): [number, PullPrint] {
    const hash = data<{ hash?: unknown }>(results.get(`diff-hash:${n}`))?.hash;
    const commits = data<{ commits?: unknown }>(results.get(`open-commits:${n}`))?.commits;
    const shas = Array.isArray(commits) ? commits.flatMap((commit) => (isRecord(commit) && typeof commit.sha === "string" ? [commit.sha] : [])) : undefined;
    return [n, { number: n, ...((typeof hash === "string" || hash === null) && { diffHash: hash }), ...(shas && { commits: shas }) }];
  }));
}

/**
 * The open pull requests opened earlier on each one's base branch, drafts left out, read only as far as the rules need:
 * one page of changed paths each, then the diff hash and commits only of those whose paths could match. Past
 * `MAX_OPEN_PULLS` of them none is read, so one pull request's reads stay bounded.
 */
async function readOpenPulls(host: HostCall, tool: (name: string) => string, repo: string, own: OwnPull[], reads: DuplicateReads): Promise<Map<number, OpenPulls>> {
  const bases = [...new Set(own.map((pull) => pull.base))];
  const listings = await runAll(host, bases.map((base) => call(tool("list_open_prs"), { repo, base }, `open:${base}`)));
  function earlier(pull: OwnPull): ListedPull[] | string {
    const rows = data<{ prs?: unknown }>(listings.get(`open:${pull.base}`))?.prs;
    if (!Array.isArray(rows)) return `${tool("list_open_prs")} failed for ${pull.base}`;
    const others = (rows as ListedPull[]).filter((row) => row.number < pull.number && row.draft !== true);
    return others.length > MAX_OPEN_PULLS ? `more than ${MAX_OPEN_PULLS} open pull requests on ${pull.base}` : others;
  }
  const others = new Map(own.map((pull) => [pull.number, earlier(pull)]));
  const listed = [...new Set([...others.values()].flatMap((row) => (typeof row === "string" ? [] : row.map((pull) => pull.number))))];
  const firstPages = await runChunked(host, listed.map((n) => call(tool("list_pr_files"), { repo, number: n, offset: 0, patches: false }, `open-files:${n}`)));
  function firstPage(n: number): { paths: string[]; whole: boolean } | undefined {
    const page = filesPage(tool("list_pr_files"), firstPages.get(`open-files:${n}`));
    return typeof page === "string" ? undefined : { paths: page.files.map((file) => file.path), whole: page.next === undefined };
  }
  function candidatesOf(pull: OwnPull, row: ListedPull[]): ListedPull[] {
    return row.filter(function candidate(other) {
      const page = firstPage(other.number);
      return other.sha !== pull.headSha && page !== undefined && couldRepeat(pull.paths, page.paths, page.whole);
    });
  }
  const candidates = new Map(own.map((pull) => {
    const row = others.get(pull.number)!;
    return [pull.number, reads.prints && typeof row !== "string" ? candidatesOf(pull, row) : []];
  }));
  const printed = [...new Set([...own.filter((pull) => candidates.get(pull.number)!.length > 0).map((pull) => pull.number), ...[...candidates.values()].flat().map((pull) => pull.number)])];
  const prints = await readPrints(host, tool, repo, printed);
  function openPullsOf(pull: OwnPull): [number, OpenPulls] {
    const row = others.get(pull.number)!;
    if (typeof row === "string") return [pull.number, { unread: row }];
    const sameHead = row.filter((other) => other.sha === pull.headSha).map((other) => ({ number: other.number, headSha: pull.headSha }));
    const self = { number: pull.number, headSha: pull.headSha, ...prints.get(pull.number) };
    const unread = row.filter((other) => other.sha !== pull.headSha && firstPage(other.number) === undefined).map((other) => other.number);
    const compared = { self, others: [...sameHead, ...candidates.get(pull.number)!.map((other) => prints.get(other.number)!)], unread };
    const read = row.flatMap(function openPull(other): OpenPull[] {
      const page = firstPage(other.number);
      return page ? [{ number: other.number, title: visibleText(other.title), paths: page.paths }] : [];
    });
    return [pull.number, { ...(reads.prints && { prints: compared }), ...(reads.paths && { overlapping: overlapping(pull.title, pull.paths, read) }) }];
  }
  return new Map(own.map(openPullsOf));
}

function fail(reason: string, automatic: ActionKind[]): FactsOutput {
  return { items: [{ error: reason, automatic }], batch: false };
}

/** The hub could not read the policy, so nothing is triaged and each head the mail names is marked failed with why. */
function unreadablePolicy(request: Record<string, unknown>, repo: string, reason: string, appLogin: { appLogin?: string }, automatic: ActionKind[]): FactsOutput {
  const error = `${POLICY_UNREADABLE}${reason}`;
  const heads = [...mailHeads(request)];
  if (heads.length === 0) return fail(error, automatic);
  const repoSource = repoSourceOf(request.repoSource);
  const marked = { automatic, ...(repoSource !== "github" && { repoSource }), ...appLogin };
  return { items: heads.map(([number, headSha]) => ({ error, pull: { repo, number, headSha }, ...marked })), batch: Array.isArray(request.items) };
}

async function fetchTargets({ host, stamp }: Host, repo: string, numbers: number[], { policy, pack, events, docs, templates, firstFiles, lists }: FetchContext): Promise<RulesItem[]> {
  function tool(name: string): string {
    return toolName(stamp.repoSource, name);
  }
  const teams = namedTeams(pack, repo);
  const focused = catalogCheckEnabled(pack, "focused");
  const risk = catalogCheckEnabled(pack, "regression-risk") || catalogCheckEnabled(pack, "risk");
  const listed = new Map<number, ListedFiles>();
  const filesErrors = new Map<number, string>();

  function filesId(n: number, { offset, patchOffset }: FilesCursor): string {
    return `files:${n}:${offset}${patchOffset === undefined ? "" : `:${patchOffset}`}`;
  }

  function filesCall([n, cursor]: [number, FilesCursor]): ToolCall {
    const { offset, patchOffset, patches } = cursor;
    return call(tool("list_pr_files"), { repo, number: n, offset, ...(patchOffset === undefined ? {} : { patchOffset }), ...(patches ? {} : { patches: false }) }, filesId(n, cursor));
  }

  function prCalls(n: number): ToolCall[] {
    return [
      call(tool("get_pr"), { repo, number: n }, `pr:${n}`),
      call(tool("get_reviews"), { repo, number: n, ...(stamp.appLogin && { appLogin: stamp.appLogin }) }, `reviews:${n}`),
      call(tool("list_issue_comments"), { repo, number: n }, `comments:${n}`),
      call(tool("list_pr_commits"), { repo, number: n }, `commits:${n}`),
      filesCall([n, firstFiles]),
      ...(focused ? [call(tool("get_stack"), { repo, number: n }, `stack:${n}`)] : []),
    ];
  }

  function addFiles(n: number, cursor: FilesCursor, result: ToolResult | undefined): FilesCursor | undefined {
    const page = filesPage(tool("list_pr_files"), result);
    const read = listed.get(n) ?? { files: [], patchChars: 0 };
    listed.set(n, read);
    const next = typeof page === "string" ? page : addFilesPage(read, cursor, page);
    if (typeof next !== "string") return next;
    filesErrors.set(n, `${next} for #${n}`);
    return undefined;
  }

  const r1 = await runAll(host, numbers.flatMap(prCalls));
  const prs = new Map(numbers.map((n) => [n, data<PrData>(r1.get(`pr:${n}`))]));

  let cursors: Array<[number, FilesCursor]> = numbers.map((n) => [n, firstFiles]);
  let pages = r1;
  function nextPage([n, cursor]: [number, FilesCursor]): Array<[number, FilesCursor]> {
    const following = addFiles(n, cursor, pages.get(filesId(n, cursor)));
    return following === undefined ? [] : [[n, following]];
  }
  for (cursors = cursors.flatMap(nextPage); cursors.length; cursors = cursors.flatMap(nextPage)) {
    pages = await runAll(host, cursors.map(filesCall));
  }

  function checkCall(n: number): ToolCall[] {
    const sha = prs.get(n)?.sha;
    return sha ? [call(tool("get_checks"), { repo, sha }, `checks:${n}`)] : [];
  }

  function teamsCalls(): ToolCall[] {
    if (!teams.length) return [];
    const authors = new Set(numbers.flatMap((n) => prs.get(n)?.author ?? []));
    return [...authors].map((author) => call(tool("author_teams"), { repo, author, teams }, `teams:${author}`));
  }

  function historyPathsOf(n: number): string[] {
    return historyPaths(listed.get(n)?.files.map((file) => file.path) ?? []);
  }

  function historyCalls(): ToolCall[] {
    if (!risk) return [];
    const since = new Date(Date.now() - DEFAULT_RISK.hotFileDays * DAY_MS).toISOString();
    return [...new Set(numbers.flatMap((n) => historyPathsOf(n).slice(0, MAX_HISTORY_READS)))].map((path) => call(tool("list_path_commits"), { repo, path, since }, `history:${path}`));
  }

  /** A pull request the host read whole, as the duplicate rules compare it. */
  function ownPull(n: number): OwnPull[] {
    const pr = prs.get(n);
    const files = listed.get(n)?.files;
    if (!pr?.sha || !pr.base || pr.title === undefined || !files || filesErrors.has(n)) return [];
    return [{ number: n, title: visibleText(pr.title), headSha: pr.sha, base: pr.base, paths: files.map((file) => file.path) }];
  }

  const r2 = await runAll(host, [...numbers.flatMap(checkCall), ...teamsCalls()]);
  for (const [id, result] of await runChunked(host, historyCalls())) r2.set(id, result);
  const duplicates: DuplicateReads = { prints: catalogCheckEnabled(pack, "no-duplicate"), paths: catalogCheckEnabled(pack, "duplicates-open-pull-request") };
  const openPulls = duplicates.prints || duplicates.paths ? await readOpenPulls(host, tool, repo, numbers.flatMap(ownPull), duplicates) : undefined;

  /** A history that failed, holds more than one page or is past the read limit counts as unread (null), which leaves only the risk rule unconfirmed. */
  function fixesOf(n: number): PullData["fixes"] {
    if (!risk) return undefined;
    return Object.fromEntries(historyPathsOf(n).map(function fixesFor(path) {
      const read = data<{ commits?: Array<{ message?: string }>; truncated?: boolean }>(r2.get(`history:${path}`));
      if (!Array.isArray(read?.commits) || read.truncated !== false) return [path, null];
      return [path, fixCount(read.commits.map((commit) => commit.message ?? ""))];
    }));
  }

  function unreadParts(n: number): ListPart[] {
    const sha = prs.get(n)?.sha;
    return lists.filter(function unread(part) {
      if (part === "checks" && !sha) return false;
      const result = (part === "checks" ? r2 : r1).get(`${part}:${n}`);
      return !Array.isArray(data<Record<string, unknown>>(result)?.[part]);
    });
  }

  /** Names the head the host or else the mail gave, so a write for it never lands on a newer one. */
  function degraded(n: number, error: string): RulesItem {
    const headSha = prs.get(n)?.sha ?? stamp.heads.get(n);
    if (headSha === undefined) return { error, automatic: stamp.automatic };
    return { error, pull: { repo, number: n, headSha }, pack, automatic: stamp.automatic, ...(stamp.repoSource !== "github" && { repoSource: stamp.repoSource }), ...(stamp.appLogin && { appLogin: stamp.appLogin }) };
  }

  function itemFor(n: number): RulesItem {
    const unread = prs.get(n) ? unreadParts(n) : [];
    if (unread.length > 0) return degraded(n, `could not read the ${unread.join(", ")} of #${n}`);
    const item = assembleItem(n, {
      pr: prs.get(n) ?? null,
      checks: data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [],
      reviews: data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [],
      comments: data<{ comments: IssueComment[] }>(r1.get(`comments:${n}`))?.comments ?? [],
      commits: data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits ?? [],
      stack: data<NonNullable<PullData["stack"]>>(r1.get(`stack:${n}`)),
      files: filesErrors.get(n) ?? listed.get(n)?.files ?? [],
      authorTeams: data<NonNullable<PullData["authorTeams"]>>(r2.get(`teams:${prs.get(n)?.author}`)),
      fixes: fixesOf(n),
    }, { repo, policy, pack, events, docs, templates, source: stamp.repoSource });
    if ("error" in item) return degraded(n, item.error);
    const openPullsRead = openPulls?.get(n);
    // Only where CI green holds the verdict: the head waits as pending and its manager reads it again once the grace ends.
    const started = stamp.ciStarting && item.facts.checks === "none" && catalogCheckEnabled(pack, "ci-green") ? { ...item.facts, checks: "pending" as const } : item.facts;
    const facts = openPullsRead ? { ...started, openPulls: openPullsRead } : started;
    return { ...item, facts, automatic: stamp.automatic, ...(stamp.source && { source: stamp.source }), ...(stamp.repoSource !== "github" && { repoSource: stamp.repoSource }), ...(stamp.noWait && { noWait: true as const }), ...(stamp.blocksOn && { blocksOn: true as const }), ...(stamp.appLogin && { appLogin: stamp.appLogin }) };
  }

  const items = numbers.map(itemFor);
  if (!pack.custom.filter(isPatternsCheck).some(customCheckEnabled)) return items;
  const matched: RulesItem[] = [];
  for (const item of items) {
    matched.push("facts" in item ? { ...item, facts: { ...item.facts, patterns: await patternsOf(host, tool("read_file"), repo, stamp.repoSource, item) } } : item);
  }
  return matched;
}

function docsCall(source: RepoSource, repo: string, offset: number, ref?: string): ToolCall {
  return call(toolName(source, "read_repo_docs"), { repo, offset, ...(ref === undefined ? {} : { ref }) }, `docs:${offset}`);
}

async function readDocs({ host, stamp }: Host, repo: string, first: ToolResult | undefined): Promise<RepoDocs | string> {
  const tool = toolName(stamp.repoSource, "read_repo_docs");
  const pages: RepoDocsPage[] = [];
  let offset = 0;
  let result = first;
  for (;;) {
    const page = docsPage(tool, result);
    if (typeof page === "string") return page;
    pages.push(page);
    const { next, ref } = page;
    if (next === undefined) return repoDocs(pages);
    if (next <= offset) return `${tool} did not advance past offset ${offset}`;
    result = (await runAll(host, [docsCall(stamp.repoSource, repo, next, ref)])).get(`docs:${next}`);
    offset = next;
  }
}

async function fetchListed(read: Host, repo: string, targets: number[] | undefined, batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack, events: TriageEvent[]): Promise<FactsOutput> {
  const judged = hasModelChecks(classificationSources(pack));
  const listTool = toolName(read.stamp.repoSource, "list_open_prs");
  // Only GitHub hides a template's comments, so only there are they told apart from the author's.
  const templated = read.stamp.repoSource === "github" && catalogCheckEnabled(pack, "hidden-content");
  const templatesTool = toolName(read.stamp.repoSource, "read_pr_templates");
  const r = await runAll(read.host, [call(listTool, { repo }), ...(judged ? [docsCall(read.stamp.repoSource, repo, 0)] : []), ...(templated ? [call(templatesTool, { repo }, "templates")] : [])]);
  const list = data<{ prs: Array<{ number: number; draft?: boolean }> }>(r.get(listTool));
  if (!list && targets === undefined) return fail(`${listTool} failed`, read.stamp.automatic);
  const triageable = (list?.prs ?? []).filter((p) => p.draft !== true).map((p) => p.number);
  const docs = judged ? await readDocs(read, repo, r.get("docs:0")) : NO_DOCS;
  const templates = templated ? templatesRead(templatesTool, r.get("templates")) : [];
  const items = await fetchTargets(read, repo, targets ?? triageable, { policy, pack, events, docs, templates, firstFiles: FIRST_FILES_PAGE, lists: ["reviews", "comments", "commits", "checks"] });
  return { items, batch };
}

/** Lists the closed pull requests a page at a time, then reads their facts a chunk at a time, without patches or a policy. */
async function fetchHistory(read: Host, repo: string, limit: number): Promise<FactsOutput> {
  const closed: ClosedPr[] = [];
  const items: RulesItem[] = [];
  const listTool = toolName(read.stamp.repoSource, "list_closed_prs");
  const context: FetchContext = { policy: repoPolicy(undefined), pack: emptyPack(repo), events: [], docs: NO_DOCS, templates: [], firstFiles: HISTORY_FILES_PAGE, lists: ["reviews", "commits", "checks"] };
  for (let page: number | undefined = 1; page !== undefined && closed.length < limit;) {
    const results = await runAll(read.host, [call(listTool, { repo, page })]);
    const listed = data<{ prs: ClosedPr[]; next?: number }>(results.get(listTool));
    if (!listed) return fail(`${listTool} failed on page ${page}`, read.stamp.automatic);
    closed.push(...listed.prs.slice(0, limit - closed.length));
    page = listed.next;
  }
  for (let start = 0; start < closed.length; start += READ_CHUNK) {
    const numbers = closed.slice(start, start + READ_CHUNK).map((pr) => pr.number);
    items.push(...await fetchTargets(read, repo, numbers, context));
  }
  return { repo, closed, items };
}

/** Reads what the trigger mail asks for from the pull request's host through `hostFor`. */
export async function readFacts(input: unknown, hostFor: (source: RepoSource) => HostCall): Promise<FactsOutput> {
  const { request, trusted } = trustedRequestOf(input);
  const repo = request?.repo;
  // Only the hub's mail names the App's account; without it a marked review from any App account is triage's own, never a person's.
  const appLogin = trusted && typeof request?.appLogin === "string" ? { appLogin: request.appLogin } : {};
  if (request?.kind === "history") {
    const limit = request.limit ?? HISTORY_LIMIT;
    const stamp: Stamp = { automatic: [], repoSource: "github", noWait: false, ciStarting: false, blocksOn: false, heads: new Map(), ...appLogin };
    if (typeof repo !== "string") return fail("facts: input has no repo", stamp.automatic);
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) return fail("facts: history limit must be a positive integer", stamp.automatic);
    return fetchHistory({ host: hostFor("github"), stamp }, repo, limit as number);
  }
  const kinds = automaticKinds(trusted, request);
  const policy = repoPolicy(request?.policy);
  if (!request || typeof repo !== "string") return fail("facts: input has no repo", kinds ?? []);
  if (kinds === undefined) throw new Error("facts: the hub's mail names no automatic grants");
  const granted = kinds;
  if (!policy.enabled) return fail("Triage is disabled for this repository.", granted);
  if (trusted && typeof request.policyUnreadable === "string") return unreadablePolicy(request, repo, request.policyUnreadable, appLogin, granted);
  const rawPack = request.pack ?? request.checkPack;
  if (rawPack === undefined || rawPack === null) return fail(NEEDS_SETUP_REASON, granted);
  let pack: CheckPack;
  try {
    pack = packFromInput(rawPack);
  } catch (error) {
    return fail(`${DEPLOYMENT_UNREADABLE}${error instanceof Error ? error.message : String(error)}`, granted);
  }
  const repoSource = repoSourceOf(request.repoSource);
  const source = policySource(request);
  const items = request.kind === "pr" && Array.isArray(request.items) ? request.items : undefined;
  const read = { host: hostFor(repoSource), stamp: { automatic: granted, repoSource, noWait: request.noWait === true, ciStarting: request.ciStarting === true, blocksOn: Array.isArray(request.blocks) && request.blocks.length > 0, heads: mailHeads(request), ...(source && { source }), ...appLogin } };
  if (request.kind === "backlog") return fetchListed(read, repo, undefined, true, policy, pack, ["catch-up"]);
  if (request.kind !== "pr") return fail("facts: input is neither pr nor backlog", granted);
  // A catch-up mail names several heads as `items`; each is triaged like a single mail and evaluated in this order.
  if (items) {
    const numbers = items.flatMap((item) => (isRecord(item) && typeof item.prNumber === "number" ? [item.prNumber] : []));
    if (numbers.length === 0) return fail("facts: batch names no pull request", granted);
    return fetchListed(read, repo, numbers, true, policy, pack, ["catch-up"]);
  }
  const number = request.prNumber;
  if (typeof number !== "number") return fail("facts: pr input has no prNumber", granted);
  const events = triageEventsOf({ event: request.event, action: request.action, review: request.review, events: request.events });
  return fetchListed(read, repo, [number], false, policy, pack, events);
}

/** Reads the pull request's facts from its host as one effect, so a resumed run does not read them again. */
export async function facts(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<FactsOutput> {
  function run({ credentials }: PerformScope) {
    return readFacts(input, (source) => hostCalls(source, credentials));
  }
  return await ctx.perform({ effectId: "facts", capability: READ_PULL_REQUEST, run }) as FactsOutput;
}
