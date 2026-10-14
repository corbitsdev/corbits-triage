import { defineDirector } from "@intx/agent";
import type {
  AssistantTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  InboundMessage,
  ReactorInboundEvent,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";
import { type } from "arktype";
import { ACTION_KINDS, classificationSources, isFromTriageSender, PolicySourceShape, repoPolicy, triageEventsOf, type ActionKind, type CheckPack, type PolicySource, type TriageEvent } from "@corbits/triage-contracts";
import type { DoInput, DoOutcome } from "@corbits/github-tool/do";
import { repoDocs, type IssueComment, type RepoDocsPage, type Review, type RuleSpan } from "@corbits/github-reads";
import type { SuggestedAction, SuggestedDo } from "./logic/actions.js";
import { hasModelChecks, NEEDS_SETUP_REASON, packFromInput } from "./logic/checks.js";
import { unrunnable } from "./logic/execute-do.js";
import { isRecord } from "@corbits/common";
import { asText, parseJsonText } from "./logic/extract.js";
import { addFilesPage, assembleItem, fileFacts, FIRST_FILES_PAGE, optionalCount, namedTeams, type CheckRun, type FilesCursor, type FilesPage, type ListedFiles, type PrData, type PullData, type RepoDocs } from "./logic/facts.js";
import type { Verdict } from "./logic/render.js";
import { decidesDos } from "./logic/settled.js";
import type { ApprovalOutput } from "./actions/approval.js";
import type { Judgment } from "./actions/evaluate.js";
import type { Judged } from "./logic/item.js";
import type { RulesItem } from "./actions/rules.js";

export type Role = "facts" | "judge" | "execute" | "mirror";

export interface TriageDirectorConfig {
  role: Role;
}

/** What stock hands a director: the headers it parsed, and the text body apart from them. */
type InboundMail = Pick<InboundMessage, "headers" | "content">;

/** The step input arrives as the inbound message text: the trigger mail, or the output of the action before it. */
function parseInput(content: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseJsonText(content ?? "");
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.kind === "string" && typeof parsed.repo === "string") return parsed;
  if (typeof parsed.text === "string") {
    const inner = parseInput(parsed.text);
    if (inner) return inner;
  }
  const parts = parsed.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part) || typeof part.text !== "string") continue;
      const inner = parseInput(part.text);
      if (inner) return inner;
    }
  }
  if (typeof parsed.content === "string") {
    const inner = parseInput(parsed.content);
    if (inner) return inner;
  }
  if (isRecord(parsed.payload)) {
    const inner = parseInput(JSON.stringify(parsed.payload));
    if (inner) return inner;
  }
  return parsed;
}

function verdictsOf(input: Record<string, unknown>): { verdicts: Verdict[]; batch: boolean } {
  return Array.isArray(input.items)
    ? { verdicts: input.items as Verdict[], batch: true }
    : { verdicts: [input as unknown as Verdict], batch: false };
}

function turnText(turn: AssistantTurn) {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

function data<T>(r: ToolResult | undefined): T | null {
  if (!r || r.isError) return null;
  const content = typeof r.content === "string" ? parseJsonText(r.content) : r.content;
  return isRecord(content) ? (content as T) : null;
}

type BatchResults = Map<string, ToolResult>;
type DirectorActions = ReactorAction | ReactorAction[] | Promise<ReactorAction | ReactorAction[]>;

function noFollowUp(): DirectorActions {
  return [];
}

/** Runs one parallel tool batch at a time and hands the collected results to `then` when every call has answered. */
function batcher(caps: ReactorCapabilities) {
  let outstanding = 0;
  let results: BatchResults = new Map();
  let then: (r: BatchResults) => DirectorActions = noFollowUp;
  function run(calls: ToolCall[], next: typeof then): DirectorActions {
    if (!calls.length) return next(new Map());
    results = new Map();
    outstanding = calls.length;
    then = next;
    return caps.executeTools(calls, true);
  }
  function settle(result: ToolResult): DirectorActions {
    results.set(result.callId, result);
    return --outstanding > 0 ? [] : then(results);
  }
  return { run, settle };
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

const TRUNCATED_RESULT = "[Tool output truncated";

function ruleSpans(rows: unknown[]): RuleSpan[] {
  return rows.flatMap((span) => {
    if (!isRecord(span) || typeof span.path !== "string") return [];
    const docsBytes = optionalCount(span.docsBytes);
    const rulesBytes = optionalCount(span.rulesBytes);
    return docsBytes === undefined || rulesBytes === undefined ? [] : [{ path: span.path, docsBytes, rulesBytes }];
  });
}

/** A cut-off or unreadable docs page would hide docs the judge needs, so it is an error instead. */
function docsPage(r: ToolResult | undefined): RepoDocsPage | string {
  if (!r) return "github_read_repo_docs did not answer";
  if (r.isError) return `github_read_repo_docs failed: ${asText(r.content)}`;
  if (typeof r.content === "string" && r.content.includes(TRUNCATED_RESULT)) return "github_read_repo_docs result was truncated";
  const content = data<{ docs?: unknown; rules?: unknown; ref?: unknown; next?: unknown }>(r);
  if (!content || !Array.isArray(content.docs) || !Array.isArray(content.rules) || typeof content.ref !== "string") return "github_read_repo_docs result is unreadable";
  const next = optionalCount(content.next);
  const docs = content.docs.flatMap((doc) => (isRecord(doc) && typeof doc.path === "string" && typeof doc.text === "string" ? [{ path: doc.path, text: doc.text }] : []));
  return { docs, rules: ruleSpans(content.rules), ref: content.ref, ...(next === undefined ? {} : { next }) };
}

/** A cut-off or unreadable file list would read as a pull request that changes nothing, so it is an error instead. */
function filesPage(r: ToolResult | undefined): FilesPage | string {
  if (!r) return "github_list_pr_files did not answer";
  if (r.isError) return `github_list_pr_files failed: ${asText(r.content)}`;
  if (typeof r.content === "string" && r.content.includes(TRUNCATED_RESULT)) return "github_list_pr_files result was truncated";
  const content = data<{ files?: unknown; next?: unknown; patchNext?: unknown }>(r);
  if (!content || !Array.isArray(content.files)) return "github_list_pr_files result is unreadable";
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
function policySource(input: Record<string, unknown> | undefined): PolicySource | undefined {
  const source = isRecord(input?.policy) ? PolicySourceShape(input.policy.source) : undefined;
  return source instanceof type.errors ? undefined : source;
}

/** The Do kinds the hub's mail says the pr-triage role is granted; only the hub's mail, told by its headers, is trusted to grant any. */
function automaticKinds(message: InboundMail, input: Record<string, unknown> | undefined): ActionKind[] {
  const kinds = input?.automatic;
  if (!isFromTriageSender(message) || !Array.isArray(kinds)) return [];
  return ACTION_KINDS.filter((kind) => kinds.includes(kind));
}

function factsDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  let carried = new Map<number, Judged>();
  let automatic: ActionKind[] = [];
  let source: PolicySource | undefined;
  function reply(items: RulesItem[], batch: boolean) {
    return caps.reply(JSON.stringify({ items, batch }));
  }
  function fail(reason: string) {
    return reply([{ error: reason }], false);
  }

  function fetchTargets(repo: string, numbers: number[], batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack, events: TriageEvent[], docs: RepoDocs | string) {
    function prCalls(n: number): ToolCall[] {
      return [
        call("github_get_pr", { repo, number: n }, `pr:${n}`),
        call("github_get_reviews", { repo, number: n }, `reviews:${n}`),
        call("github_list_issue_comments", { repo, number: n }, `comments:${n}`),
        call("github_list_pr_commits", { repo, number: n }, `commits:${n}`),
        filesCall(n, FIRST_FILES_PAGE),
      ];
    }

    const teams = namedTeams(pack, repo);
    const listed = new Map<number, ListedFiles>();
    const filesErrors = new Map<number, string>();

    function filesId(n: number, { offset, patchOffset }: FilesCursor): string {
      return `files:${n}:${offset}${patchOffset === undefined ? "" : `:${patchOffset}`}`;
    }

    function filesCall(n: number, cursor: FilesCursor): ToolCall {
      const { offset, patchOffset, patches } = cursor;
      return call("github_list_pr_files", { repo, number: n, offset, ...(patchOffset === undefined ? {} : { patchOffset }), ...(patches ? {} : { patches: false }) }, filesId(n, cursor));
    }

    /** Adds one page of files and returns where the next page starts, if any. */
    function addFiles(n: number, cursor: FilesCursor, result: ToolResult | undefined): FilesCursor | undefined {
      const page = filesPage(result);
      const read = listed.get(n) ?? { files: [], patchChars: 0 };
      listed.set(n, read);
      const next = typeof page === "string" ? page : addFilesPage(read, cursor, page);
      if (typeof next !== "string") return next;
      filesErrors.set(n, `${next} for #${n}`);
      return undefined;
    }

    function onPrs(r1: BatchResults) {
      const prs = new Map(numbers.map((n) => [n, data<PrData>(r1.get(`pr:${n}`))]));

      function checkCall(n: number): ToolCall[] {
        const sha = prs.get(n)?.sha;
        return sha ? [call("github_get_checks", { repo, sha }, `checks:${n}`)] : [];
      }

      function teamsCalls(): ToolCall[] {
        if (!teams.length) return [];
        const authors = new Set(numbers.flatMap((n) => prs.get(n)?.author ?? []));
        return [...authors].map((author) => call("github_author_teams", { repo, author, teams }, `teams:${author}`));
      }

      function readFiles(r: BatchResults, cursors: Array<[number, FilesCursor]>): DirectorActions {
        const next = cursors.flatMap(function nextPage([n, cursor]): Array<[number, FilesCursor]> {
          const following = addFiles(n, cursor, r.get(filesId(n, cursor)));
          return following === undefined ? [] : [[n, following]];
        });
        function onNextFiles(r3: BatchResults) {
          return readFiles(r3, next);
        }
        if (next.length) return b.run(next.map(([n, cursor]) => filesCall(n, cursor)), onNextFiles);
        return b.run([...numbers.flatMap(checkCall), ...teamsCalls()], onChecks);
      }

      function onChecks(r2: BatchResults) {
        function itemFor(n: number): RulesItem {
          const item = assembleItem(n, {
            pr: prs.get(n) ?? null,
            checks: data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [],
            reviews: data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [],
            comments: data<{ comments: IssueComment[] }>(r1.get(`comments:${n}`))?.comments ?? [],
            commits: data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits ?? [],
            files: filesErrors.get(n) ?? listed.get(n)?.files ?? [],
            authorTeams: data<NonNullable<PullData["authorTeams"]>>(r2.get(`teams:${prs.get(n)?.author}`)),
          }, { repo, policy, pack, events, docs });
          const judged = carried.get(n);
          if ("error" in item) return item;
          const stamped = { ...item, automatic, ...(source && { source }) };
          return judged === undefined ? stamped : { ...stamped, judged };
        }
        return reply(numbers.map(itemFor), batch);
      }

      return readFiles(r1, numbers.map((n) => [n, FIRST_FILES_PAGE]));
    }

    return b.run(numbers.flatMap(prCalls), onPrs);
  }

  function docsCall(repo: string, offset: number, ref?: string): ToolCall {
    return call("github_read_repo_docs", { repo, offset, ...(ref === undefined ? {} : { ref }) }, `docs:${offset}`);
  }

  /** Reads the repository's docs page by page from `offset` onto `pages`, then hands them, or why they failed, to `then`. */
  function readDocs(repo: string, offset: number, result: ToolResult | undefined, pages: RepoDocsPage[], then: (docs: RepoDocs | string) => DirectorActions): DirectorActions {
    const page = docsPage(result);
    if (typeof page === "string") return then(page);
    pages.push(page);
    const { next, ref } = page;
    if (next === undefined) return then(repoDocs(pages));
    if (next <= offset) return then(`github_read_repo_docs did not advance past offset ${offset}`);
    function onNextDocs(r: BatchResults) {
      return readDocs(repo, next!, r.get(`docs:${next}`), pages, then);
    }
    return b.run([docsCall(repo, next, ref)], onNextDocs);
  }

  /** Lists the open pull requests and reads the docs the judge needs, then gathers facts for `targets`, or for all of them when none are named. */
  function fetchListed(repo: string, targets: number[] | undefined, batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack, events: TriageEvent[]) {
    const judged = hasModelChecks(classificationSources(pack));
    return b.run([call("github_list_open_prs", { repo }), ...(judged ? [docsCall(repo, 0)] : [])], function onPrList(r) {
      const list = data<{ prs: Array<{ number: number; draft?: boolean }> }>(r.get("github_list_open_prs"));
      if (!list && targets === undefined) return fail("github_list_open_prs failed");
      const listed = list?.prs ?? [];
      const triageable = listed.filter((p) => p.draft !== true).map((p) => p.number);
      function withDocs(docs: RepoDocs | string) {
        return fetchTargets(repo, targets ?? triageable, batch, policy, pack, events, docs);
      }
      return judged ? readDocs(repo, 0, r.get("docs:0"), [], withDocs) : withDocs({ docs: {}, rules: {} });
    });
  }

  function start(message: InboundMail) {
    const input = parseInput(message.content);
    const repo = input?.repo;
    const policy = repoPolicy(input?.policy);
    if (typeof repo !== "string") return fail("facts: input has no repo");
    if (!policy.enabled) return fail("Triage is disabled for this repository.");
    const pack = packFromInput(input?.pack ?? input?.checkPack);
    if (!pack) return fail(NEEDS_SETUP_REASON);
    automatic = automaticKinds(message, input);
    source = policySource(input);
    if (input?.kind === "backlog") return fetchListed(repo, undefined, true, policy, pack, ["catch-up"]);
    if (input?.kind !== "pr") return fail("facts: input is neither pr nor backlog");
    // A catch-up mail names several heads as `items`; each is triaged like a single mail and evaluated in this order.
    if (Array.isArray(input.items)) {
      const numbers = input.items.flatMap((item) => (isRecord(item) && typeof item.prNumber === "number" ? [item.prNumber] : []));
      if (numbers.length === 0) return fail("facts: batch names no pull request");
      carried = isFromTriageSender(message) ? carriedAnswers(input.items) : new Map();
      return fetchListed(repo, numbers, true, policy, pack, ["catch-up"]);
    }
    const number = input.prNumber;
    if (typeof number !== "number") return fail("facts: pr input has no prNumber");
    const events = triageEventsOf({ event: input.event, action: input.action, review: input.review, events: input.events });
    return fetchListed(repo, [number], false, policy, pack, events);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return start(event.message);
        case "tool.done":
          return b.settle(event.result);
        case "abort":
        case "inference.error":
          return fail(`facts interrupted: ${event.type}`);
        default:
          return [];
      }
    },
  };
}

/** The only inference path: one System One call for one rules chunk, replied as that chunk's `Judgment`. */
function judgeDirector(caps: ReactorCapabilities, systemPrompt: string): ReactorDirector {
  function answer(judgment: Judgment) {
    return caps.reply(JSON.stringify(judgment));
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const chunk = parseInput(event.message.content);
          if (!isRecord(chunk?.state) || !Array.isArray(chunk.questions)) return answer({ judgeError: "judge input is not a chunk" });
          return caps.infer({ systemPrompt, tools: [], providerOptions: { systemOne: { state: chunk.state, questions: chunk.questions } } });
        }
        case "inference.done":
          return answer({ judge: turnText(event.turn) });
        case "inference.error":
          return answer({ judgeError: event.error.message });
        case "abort":
          return answer({});
        default:
          return [];
      }
    },
  };
}

const MIRRORED_KINDS: readonly ActionKind[] = ["comment", "labels", "approve", "request-changes"];

/**
 * A settled head that may not be approved takes back the approve Do's approvals, of it or earlier heads, in a pack that approves;
 * one with nothing left for the author to fix takes back the request-changes Do's requests, in a pack that requests changes.
 */
function dismissals(v: Verdict) {
  const settled = v.headSha !== null && decidesDos(v);
  return { ...(settled && v.approvable === false && { notReadyHead: v.headSha }), ...(settled && v.changesWanted === false && { fixedHead: v.headSha }) };
}

/** Whether the mirror writes anything for the verdict: what the pr-triage role is granted, or what an earlier Do left to take back. */
function mirrors(v: Verdict): boolean {
  if (v.mirror !== true || !v.request || !Array.isArray(v.automatic)) return false;
  return MIRRORED_KINDS.some((kind) => v.automatic.includes(kind)) || Object.keys(dismissals(v)).length > 0;
}

/**
 * The mirror writes triage's labels when the pr-triage role holds labels and its reply when it holds comment, and takes
 * back what earlier approve and request-changes Dos left standing; the portal offers the rest.
 */
function mirrorDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  let batch = false;

  function finish(results: BatchResults) {
    const outcomes = [...results.values()].map(function outcome(r) {
      const { changeRequestsKept: kept, unchanged, skipped } = data<{ changeRequestsKept?: unknown; unchanged?: unknown; skipped?: unknown }>(r) ?? {};
      return {
        call: r.callId,
        ok: !r.isError,
        ...(r.isError ? { error: asText(r.content) } : {}),
        ...(typeof kept === "string" ? { changeRequestsKept: kept } : {}),
        ...(typeof unchanged === "string" ? { unchanged } : {}),
        ...(typeof skipped === "string" ? { skipped } : {}),
      };
    });
    return caps.reply(JSON.stringify(batch ? { results: outcomes } : (outcomes[0] ?? { skipped: true })));
  }

  function mirrorCall(v: Verdict): ToolCall {
    const r = v.request;
    const labels = v.automatic.includes("labels") ? { labels: r.labels, owned: r.owned } : { labels: [], owned: [] };
    const comment = v.automatic.includes("comment") ? { comment: r.comment, ...(r.header && { header: r.header }) } : {};
    return call("github_mirror_auto", { repo: r.repo, number: r.number, ...labels, ...comment, ...dismissals(v) }, `mirror:${r.repo.replace("/", "--")}:${r.number}`);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return caps.reply(JSON.stringify({ skipped: true, reason: "mirror: input is not JSON" }));
          const parsed = verdictsOf(input);
          batch = parsed.batch;
          const mirrored = parsed.verdicts.filter(mirrors);
          if (!mirrored.length) return caps.reply(JSON.stringify({ skipped: true }));
          return b.run(mirrored.map(mirrorCall), finish);
        }
        case "tool.done":
          return b.settle(event.result);
        case "abort":
        case "inference.error":
          return caps.reply(JSON.stringify({ skipped: true, reason: `mirror interrupted: ${event.type}` }));
        default:
          return [];
      }
    },
  };
}

/** One Do's outcome; a failed or skipped unattended one is tried again by the next run. */
export type DoResult = { effectId: string; status: DoOutcome["status"] | "failed" | "skipped"; error?: string };

/** Dos one run writes at most; the rest wait for the next run. */
export const MAX_DOS_PER_RUN = 10;
const NOT_SETTLED = "verdict not settled";
const OVER_CAP = `more than ${MAX_DOS_PER_RUN} unattended Dos in one run`;

type AutomaticDo = { verdict: Verdict; step: SuggestedDo };

function isDo(action: SuggestedAction): action is SuggestedDo {
  return "effectId" in action;
}

/** Only Dos whose kind the pr-triage role holds run unattended, and only those evaluate did not hold. */
function automaticDos(v: Verdict): AutomaticDo[] {
  if (!v.request || !Array.isArray(v.actions) || !Array.isArray(v.automatic)) return [];
  return v.actions.filter(isDo).filter((step) => step.held !== true && v.automatic.includes(step.kind)).map((step) => ({ verdict: v, step }));
}

/** Why the Do is not run in this run, if it is not. */
function refusal({ verdict, step }: AutomaticDo): string | undefined {
  return verdict.headSha !== null && decidesDos(verdict) ? unrunnable(step) : NOT_SETTLED;
}

function doInput({ verdict, step }: AutomaticDo): DoInput {
  return { request: verdict.request, step: { effectId: step.effectId, headSha: verdict.headSha!, kind: step.kind, target: step.target } };
}

/** The call id is the effect id, so each result names its Do. */
function doCall({ request, step }: DoInput): ToolCall {
  return call("github_execute_do_auto", { request, step }, step.effectId);
}

function outcome(r: ToolResult): DoResult {
  if (r.isError) return { effectId: r.callId, status: "failed", error: asText(r.content) };
  const result = data<{ status?: DoResult["status"]; reason?: string }>(r);
  if (result?.status === "skipped" && typeof result.reason === "string") return { effectId: r.callId, status: "skipped", error: result.reason };
  if (result?.status === "done" || result?.status === "satisfied") return { effectId: r.callId, status: result.status };
  return { effectId: r.callId, status: "failed", error: "github_execute_do_auto result is unreadable" };
}

/** Writes one Do at a time, so a run never floods a pull request, and replies what it has so far when interrupted. An approval's input is the one held Do to write. */
function executeDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  const results: DoResult[] = [];
  let queue: DoInput[] = [];

  function reply(reason?: string) {
    return caps.reply(JSON.stringify({ dos: results, ...(reason === undefined ? {} : { reason }) }));
  }

  function next(): DirectorActions {
    const head = queue.shift();
    return head === undefined ? reply() : b.run([doCall(head)], onResult);
  }

  function onResult(r: BatchResults): DirectorActions {
    results.push(...[...r.values()].map(outcome));
    return next();
  }

  function approve(approved: ApprovalOutput & { approved: true }): void {
    if ("refused" in approved) results.push({ effectId: approved.effectId, status: "skipped", error: approved.refused });
    else queue.push(approved);
  }

  function plan(dos: AutomaticDo[]): void {
    for (const d of dos) {
      const refused = refusal(d);
      if (refused !== undefined) results.push({ effectId: d.step.effectId, status: "skipped", error: refused });
      else if (queue.length < MAX_DOS_PER_RUN) queue.push(doInput(d));
      else results.push({ effectId: d.step.effectId, status: "skipped", error: OVER_CAP });
    }
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return reply("execute: input is not JSON");
          queue = [];
          if (input.approved === true) approve(input as ApprovalOutput & { approved: true });
          else plan(verdictsOf(input).verdicts.flatMap(automaticDos));
          return next();
        }
        case "tool.done":
          return b.settle(event.result);
        case "abort":
        case "inference.error":
          return reply(`execute interrupted: ${event.type}`);
        default:
          return [];
      }
    },
  };
}

/** The reactor hands one stable capabilities object to `decide`; roles are built from it on first use. */
function lazy(build: (caps: ReactorCapabilities) => ReactorDirector): ReactorDirector {
  let inner: ReactorDirector | undefined;
  return {
    async decide(event, state, caps) {
      return (inner ??= build(caps)).decide(event, state, caps);
    },
  };
}

/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const TRIAGE_WORKFLOW_PACKAGE_NAME: string | undefined;
const workflowPackageName = typeof TRIAGE_WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/triage-workflows" : TRIAGE_WORKFLOW_PACKAGE_NAME;

export const triageDirector = defineDirector<TriageDirectorConfig>({
  id: `${workflowPackageName}/triage`,
  configSchema: type({ role: "'facts' | 'judge' | 'execute' | 'mirror'" }),
  factory: function buildTriageDirector({ role }, _env, agent) {
    return lazy(function buildRoleDirector(caps) {
      switch (role) {
        case "facts":
          return factsDirector(caps);
        case "judge":
          return judgeDirector(caps, agent.systemPrompt);
        case "execute":
          return executeDirector(caps);
        case "mirror":
          return mirrorDirector(caps);
      }
    });
  },
});

export const triageDirectorFactory = triageDirector.factory;
