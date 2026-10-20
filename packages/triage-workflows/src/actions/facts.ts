import type { EffectContext, PerformScope } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { ACTION_KINDS, catalogCheckEnabled, classificationSources, emptyPack, isFromTriageSender, PolicySourceShape, repoPolicy, repoSourceOf, triageEventsOf, triggerRequestOf, type ActionKind, type CheckPack, type PolicySource, type RepoSource, type TriageEvent } from "@corbits/triage-contracts";
import { repoDocs, type ClosedPr, type IssueComment, type RepoDocsPage, type Review, type RuleSpan } from "@corbits/github-reads";
import { isRecord } from "@corbits/common";
import { hasModelChecks, NEEDS_SETUP_REASON, packFromInput } from "../logic/checks.js";
import { asText } from "../logic/extract.js";
import { addFilesPage, assembleItem, fileFacts, FIRST_FILES_PAGE, optionalCount, namedTeams, type CheckRun, type FilesCursor, type FilesPage, type ListedFiles, type PrData, type PullData, type RepoDocs } from "../logic/facts.js";
import type { History } from "../logic/history.js";
import { call, data, hostCalls, READ_PULL_REQUEST, runAll, toolName, type HostCall } from "../logic/host.js";
import type { Judged } from "../logic/item.js";
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

/** The judge answers a catch-up mail carried for each pull request it names; only the hub's mail is trusted to carry them. */
function carriedAnswers(items: unknown[]): Map<number, Judged> {
  return new Map(items.flatMap(function answersOf(item): Array<[number, Judged]> {
    if (!isRecord(item) || typeof item.prNumber !== "number" || !isRecord(item.judged)) return [];
    const judged = Object.entries(item.judged).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return judged.length > 0 ? [[item.prNumber, Object.fromEntries(judged)]] : [];
  }));
}

/** The policy versions the hub's mail names; a mail from before it named them has none. */
function policySource(request: Record<string, unknown>): PolicySource | undefined {
  const source = isRecord(request.policy) ? PolicySourceShape(request.policy.source) : undefined;
  return source instanceof type.errors ? undefined : source;
}

/** The Do kinds the hub's mail says the pr-triage role is granted; only the hub's mail is trusted to grant any. */
function automaticKinds(trusted: boolean, request: Record<string, unknown>): ActionKind[] {
  const kinds = request.automatic;
  if (!trusted || !Array.isArray(kinds)) return [];
  return ACTION_KINDS.filter((kind) => kinds.includes(kind));
}

/** What each item read for a pull request carries besides its facts. */
interface Stamp {
  carried: Map<number, Judged>;
  automatic: ActionKind[];
  source?: PolicySource;
  repoSource: RepoSource;
  noWait: boolean;
}

interface Host {
  host: HostCall;
  stamp: Stamp;
}

interface FetchContext {
  policy: ReturnType<typeof repoPolicy>;
  pack: CheckPack;
  events: TriageEvent[];
  docs: RepoDocs | string;
  templates: string[] | string;
  firstFiles: FilesCursor;
  /** A scan counts reviews, commits and checks, so one it could not read leaves the pull request unread instead of empty. */
  wholeReads: boolean;
}

/** A scan reads paths and sizes, not patches. */
const HISTORY_FILES_PAGE: FilesCursor = { offset: 0, patches: false };

/** Pull requests read at once, so the host sees a bounded number of concurrent requests. */
const HISTORY_CHUNK = 10;

const HISTORY_LIMIT = 200;

const NO_DOCS: RepoDocs = { docs: {}, rules: {} };

function fail(reason: string): FactsOutput {
  return { items: [{ error: reason }], batch: false };
}

async function fetchTargets({ host, stamp }: Host, repo: string, numbers: number[], { policy, pack, events, docs, templates, firstFiles, wholeReads }: FetchContext): Promise<RulesItem[]> {
  function tool(name: string): string {
    return toolName(stamp.repoSource, name);
  }
  const teams = namedTeams(pack, repo);
  // Focused is skipped on a stacked branch, so only a pack that asks it reads the stack.
  const focused = catalogCheckEnabled(pack, "focused");
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
      call(tool("get_reviews"), { repo, number: n }, `reviews:${n}`),
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

  const r2 = await runAll(host, [...numbers.flatMap(checkCall), ...teamsCalls()]);

  function unreadParts(n: number): string[] {
    const reads = [r1.get(`reviews:${n}`), r1.get(`commits:${n}`), ...(prs.get(n)?.sha ? [r2.get(`checks:${n}`)] : [])];
    return reads.flatMap((r, i) => (data(r) === null ? [["reviews", "commits", "checks"][i]!] : []));
  }

  function itemFor(n: number): RulesItem {
    const unread = wholeReads ? unreadParts(n) : [];
    if (unread.length > 0) return { error: `could not read the ${unread.join(", ")} of #${n}` };
    const item = assembleItem(n, {
      pr: prs.get(n) ?? null,
      checks: data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [],
      reviews: data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [],
      comments: data<{ comments: IssueComment[] }>(r1.get(`comments:${n}`))?.comments ?? [],
      commits: data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits ?? [],
      stack: data<NonNullable<PullData["stack"]>>(r1.get(`stack:${n}`)),
      files: filesErrors.get(n) ?? listed.get(n)?.files ?? [],
      authorTeams: data<NonNullable<PullData["authorTeams"]>>(r2.get(`teams:${prs.get(n)?.author}`)),
    }, { repo, policy, pack, events, docs, templates, source: stamp.repoSource });
    const judged = stamp.carried.get(n);
    if ("error" in item) return item;
    const stamped = { ...item, automatic: stamp.automatic, ...(stamp.source && { source: stamp.source }), ...(stamp.repoSource !== "github" && { repoSource: stamp.repoSource }), ...(stamp.noWait && { noWait: true as const }) };
    return judged === undefined ? stamped : { ...stamped, judged };
  }

  return numbers.map(itemFor);
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
  if (!list && targets === undefined) return fail(`${listTool} failed`);
  const triageable = (list?.prs ?? []).filter((p) => p.draft !== true).map((p) => p.number);
  const docs = judged ? await readDocs(read, repo, r.get("docs:0")) : NO_DOCS;
  const templates = templated ? templatesRead(templatesTool, r.get("templates")) : [];
  const items = await fetchTargets(read, repo, targets ?? triageable, { policy, pack, events, docs, templates, firstFiles: FIRST_FILES_PAGE, wholeReads: false });
  return { items, batch };
}

/** Lists the closed pull requests a page at a time, then reads their facts a chunk at a time, without patches or a policy. */
async function fetchHistory(read: Host, repo: string, limit: number): Promise<FactsOutput> {
  const closed: ClosedPr[] = [];
  const items: RulesItem[] = [];
  const listTool = toolName(read.stamp.repoSource, "list_closed_prs");
  const context: FetchContext = { policy: repoPolicy(undefined), pack: emptyPack(repo), events: [], docs: NO_DOCS, templates: [], firstFiles: HISTORY_FILES_PAGE, wholeReads: true };
  for (let page: number | undefined = 1; page !== undefined && closed.length < limit;) {
    const results = await runAll(read.host, [call(listTool, { repo, page })]);
    const listed = data<{ prs: ClosedPr[]; next?: number }>(results.get(listTool));
    if (!listed) return fail(`${listTool} failed on page ${page}`);
    closed.push(...listed.prs.slice(0, limit - closed.length));
    page = listed.next;
  }
  for (let start = 0; start < closed.length; start += HISTORY_CHUNK) {
    const numbers = closed.slice(start, start + HISTORY_CHUNK).map((pr) => pr.number);
    items.push(...await fetchTargets(read, repo, numbers, context));
  }
  return { repo, closed, items };
}

/** Reads what the trigger mail asks for from the pull request's host through `hostFor`. */
export async function readFacts(input: unknown, hostFor: (source: RepoSource) => HostCall): Promise<FactsOutput> {
  const request = triggerRequestOf(input);
  const repo = request?.repo;
  if (request?.kind === "history") {
    const limit = request.limit ?? HISTORY_LIMIT;
    if (typeof repo !== "string") return fail("facts: input has no repo");
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) return fail("facts: history limit must be a positive integer");
    return fetchHistory({ host: hostFor("github"), stamp: { carried: new Map(), automatic: [], repoSource: "github", noWait: false } }, repo, limit as number);
  }
  const policy = repoPolicy(request?.policy);
  if (!request || typeof repo !== "string") return fail("facts: input has no repo");
  if (!policy.enabled) return fail("Triage is disabled for this repository.");
  const pack = packFromInput(request.pack ?? request.checkPack);
  if (!pack) return fail(NEEDS_SETUP_REASON);
  const trusted = isFromTriageSender(input);
  const repoSource = repoSourceOf(request.repoSource);
  const source = policySource(request);
  const items = request.kind === "pr" && Array.isArray(request.items) ? request.items : undefined;
  const carried = trusted && items ? carriedAnswers(items) : new Map<number, Judged>();
  const read = { host: hostFor(repoSource), stamp: { carried, automatic: automaticKinds(trusted, request), repoSource, noWait: request.noWait === true, ...(source && { source }) } };
  if (request.kind === "backlog") return fetchListed(read, repo, undefined, true, policy, pack, ["catch-up"]);
  if (request.kind !== "pr") return fail("facts: input is neither pr nor backlog");
  // A catch-up mail names several heads as `items`; each is triaged like a single mail and evaluated in this order.
  if (items) {
    const numbers = items.flatMap((item) => (isRecord(item) && typeof item.prNumber === "number" ? [item.prNumber] : []));
    if (numbers.length === 0) return fail("facts: batch names no pull request");
    return fetchListed(read, repo, numbers, true, policy, pack, ["catch-up"]);
  }
  const number = request.prNumber;
  if (typeof number !== "number") return fail("facts: pr input has no prNumber");
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
