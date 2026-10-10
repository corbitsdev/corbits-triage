import { defineDirector } from "@intx/agent";
import type {
  AssistantTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";
import { type } from "arktype";
import { repoPolicy, type CheckPack, type TriageEvent } from "@corbits/triage-contracts";
import { NEEDS_SETUP_REASON, packFromInput, type PrFacts, type PrFileFacts } from "./logic/checks.js";
import { asText, isRecord, parseJsonText } from "./logic/extract.js";
import { prepareQualityEvaluation } from "./logic/quality.js";
import { triageEventOf } from "./logic/events.js";
import { assembleItem, fileFacts, MAX_PATCH_CHARS, optionalCount, type CheckRun, type PrData, type Review } from "./logic/facts.js";
import { asksJudge, type Item } from "./logic/item.js";
import type { Verdict } from "./logic/render.js";
import type { Judgment } from "./actions/evaluate.js";
import type { RulesItem } from "./actions/rules.js";

export type Role = "facts" | "judge" | "mirror";

export interface TriageDirectorConfig {
  role: Role;
}

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

type FilesPage = { files: PrFileFacts[]; next?: number };
type ListedFiles = { files: PrFileFacts[]; patchChars: number };

/** A cut-off or unreadable file list would read as a pull request that changes nothing, so it is an error instead. */
function filesPage(r: ToolResult | undefined): FilesPage | string {
  if (!r) return "github_list_pr_files did not answer";
  if (r.isError) return `github_list_pr_files failed: ${asText(r.content)}`;
  if (typeof r.content === "string" && r.content.includes(TRUNCATED_RESULT)) return "github_list_pr_files result was truncated";
  const content = data<{ files?: unknown; next?: unknown }>(r);
  if (!content || !Array.isArray(content.files)) return "github_list_pr_files result is unreadable";
  const next = optionalCount(content.next);
  return { files: content.files.flatMap(fileFacts), ...(next === undefined ? {} : { next }) };
}

function factsDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  function reply(items: RulesItem[], batch: boolean) {
    return caps.reply(JSON.stringify({ items, batch }));
  }
  function fail(reason: string) {
    return reply([{ error: reason }], false);
  }

  function fetchTargets(repo: string, numbers: number[], openPrs: PrFacts["openPrs"], batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack, event: TriageEvent | null) {
    function prCalls(n: number): ToolCall[] {
      return [
        call("github_get_pr", { repo, number: n }, `pr:${n}`),
        call("github_get_reviews", { repo, number: n }, `reviews:${n}`),
        call("github_list_pr_commits", { repo, number: n }, `commits:${n}`),
        filesCall(n, 0),
      ];
    }

    const listed = new Map<number, ListedFiles>();
    const filesErrors = new Map<number, string>();

    function filesCall(n: number, offset: number): ToolCall {
      const patches = (listed.get(n)?.patchChars ?? 0) < MAX_PATCH_CHARS;
      return call("github_list_pr_files", { repo, number: n, offset, ...(patches ? {} : { patches: false }) }, `files:${n}:${offset}`);
    }

    /** Adds one page of files and returns the offset of the next page, if any. */
    function addFiles(n: number, offset: number, result: ToolResult | undefined): number | undefined {
      const page = filesPage(result);
      if (typeof page === "string") {
        filesErrors.set(n, `${page} for #${n}`);
        return undefined;
      }
      const read = listed.get(n) ?? { files: [], patchChars: 0 };
      read.files.push(...page.files);
      read.patchChars += page.files.reduce((chars, file) => chars + (file.patch?.length ?? 0), 0);
      listed.set(n, read);
      if (page.next === undefined) return undefined;
      if (page.next > offset) return page.next;
      filesErrors.set(n, `github_list_pr_files did not advance past offset ${offset} for #${n}`);
      return undefined;
    }

    function onPrs(r1: BatchResults) {
      const prs = new Map(numbers.map((n) => [n, data<PrData>(r1.get(`pr:${n}`))]));

      function checkCall(n: number): ToolCall[] {
        const sha = prs.get(n)?.sha;
        return sha ? [call("github_get_checks", { repo, sha }, `checks:${n}`)] : [];
      }

      function readFiles(r: BatchResults, offsets: Array<[number, number]>): DirectorActions {
        const next = offsets.flatMap(function nextPage([n, offset]): Array<[number, number]> {
          const following = addFiles(n, offset, r.get(`files:${n}:${offset}`));
          return following === undefined ? [] : [[n, following]];
        });
        function onNextFiles(r3: BatchResults) {
          return readFiles(r3, next);
        }
        if (next.length) return b.run(next.map(([n, offset]) => filesCall(n, offset)), onNextFiles);
        return b.run(numbers.flatMap(checkCall), onChecks);
      }

      function onChecks(r2: BatchResults) {
        function itemFor(n: number): RulesItem {
          return assembleItem(n, {
            pr: prs.get(n) ?? null,
            checks: data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [],
            reviews: data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [],
            commits: data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits ?? [],
            files: filesErrors.get(n) ?? listed.get(n)?.files ?? [],
          }, { repo, openPrs, policy, pack, event });
        }
        return reply(numbers.map(itemFor), batch);
      }

      return readFiles(r1, numbers.map((n) => [n, 0]));
    }

    return b.run(numbers.flatMap(prCalls), onPrs);
  }

  /** Lists the open pull requests, then gathers facts for `targets`, or for all of them when none are named. */
  function fetchListed(repo: string, targets: number[] | undefined, batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack, event: TriageEvent | null) {
    return b.run([call("github_list_open_prs", { repo })], function onPrList(r) {
      const list = data<{ prs: Array<{ number: number; title: string; draft?: boolean }> }>(r.get("github_list_open_prs"));
      if (!list && targets === undefined) return fail("github_list_open_prs failed");
      const listed = list?.prs ?? [];
      const openPrs = listed.map(({ number, title }) => ({ number, title }));
      const triageable = listed.filter((p) => policy.triageDrafts || p.draft !== true).map((p) => p.number);
      return fetchTargets(repo, targets ?? triageable, openPrs, batch, policy, pack, event);
    });
  }

  function start(message: { content?: string }) {
    const input = parseInput(message.content);
    const repo = input?.repo;
    const policy = repoPolicy(input?.policy);
    if (typeof repo !== "string") return fail("facts: input has no repo");
    if (!policy.enabled) return fail("Triage is disabled for this repository.");
    const pack = packFromInput(input?.checkPack);
    if (!pack) return fail(NEEDS_SETUP_REASON);
    if (input?.kind === "backlog") return fetchListed(repo, undefined, true, policy, pack, "catch-up");
    if (input?.kind !== "pr") return fail("facts: input is neither pr nor backlog");
    // A catch-up mail names several heads as `items`; each is triaged like a single mail and evaluated in this order.
    if (Array.isArray(input.items)) {
      const numbers = input.items.flatMap((item) => (isRecord(item) && typeof item.prNumber === "number" ? [item.prNumber] : []));
      if (numbers.length === 0) return fail("facts: batch names no pull request");
      return fetchListed(repo, numbers, true, policy, pack, "catch-up");
    }
    const number = input.prNumber;
    if (typeof number !== "number") return fail("facts: pr input has no prNumber");
    return fetchListed(repo, [number], false, policy, pack, triageEventOf({ event: input.event, action: input.action, review: input.review }));
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

/** The only inference path: asks Jev about the rules output's items that need judgment, one at a time, and replies the answers in item order. */
function judgeDirector(caps: ReactorCapabilities, systemPrompt: string): ReactorDirector {
  let items: Item[] = [];
  let answers: Judgment[] = [];
  let queue: number[] = [];
  let current = -1;

  function finish() {
    return caps.reply(JSON.stringify({ answers }));
  }

  function ask() {
    while (true) {
      const next = queue.shift();
      if (next === undefined) return finish();
      current = next;
      const { facts, det } = items[current];
      const evaluation = prepareQualityEvaluation(facts, det.sources);
      if (evaluation.questions.length === 0) continue;
      return caps.infer({ systemPrompt, tools: [], providerOptions: { systemOne: { state: evaluation.state, questions: evaluation.questions } } });
    }
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          items = Array.isArray(input?.items) ? (input.items as Item[]) : [];
          answers = items.map(() => ({}));
          queue = items.flatMap((it, i) => (asksJudge(it) ? [i] : []));
          return ask();
        }
        case "inference.done":
          answers[current] = { judge: turnText(event.turn) };
          return ask();
        case "inference.error":
          answers[current] = { judgeError: event.error.message };
          return ask();
        case "abort":
          return finish();
        default:
          return [];
      }
    },
  };
}

/** Only automated repos mirror: a run parked on approval loses state across restarts, so other verdicts leave `request` for the portal to post. */
function mirrorDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  let batch = false;

  function finish(results: BatchResults) {
    const outcomes = [...results.values()].map((r) => ({ call: r.callId, ok: !r.isError, ...(r.isError ? { error: asText(r.content) } : {}) }));
    return caps.reply(JSON.stringify(batch ? { results: outcomes } : (outcomes[0] ?? { skipped: true })));
  }

  function mirrorCall(v: Verdict): ToolCall {
    const r = v.request;
    return call("github_mirror_auto", { repo: r.repo, number: r.number, labels: r.labels, owned: r.owned, comment: r.comment, close: false }, `mirror:${r.repo.replace("/", "--")}:${r.number}`);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return caps.reply(JSON.stringify({ skipped: true, reason: "mirror: input is not JSON" }));
          const parsed = verdictsOf(input);
          batch = parsed.batch;
          const mirrored = parsed.verdicts.filter((v) => v.mirror === true && v.request && v.cleanupMode === "automated");
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

/** The reactor hands one stable capabilities object to `decide`; roles are built from it on first use. */
function lazy(build: (caps: ReactorCapabilities) => ReactorDirector): ReactorDirector {
  let inner: ReactorDirector | undefined;
  return {
    async decide(event, state, caps) {
      return (inner ??= build(caps)).decide(event, state, caps);
    },
  };
}

const workflowPackageName = process.env.TRIAGE_WORKFLOW_PACKAGE_NAME ?? "@corbits/triage-workflows";

export const triageDirector = defineDirector<TriageDirectorConfig>({
  id: `${workflowPackageName}/triage`,
  configSchema: type({ role: "'facts' | 'judge' | 'mirror'" }),
  factory: function buildTriageDirector({ role }, _env, agent) {
    return lazy(function buildRoleDirector(caps) {
      switch (role) {
        case "facts":
          return factsDirector(caps);
        case "judge":
          return judgeDirector(caps, agent.systemPrompt);
        case "mirror":
          return mirrorDirector(caps);
      }
    });
  },
});

export const triageDirectorFactory = triageDirector.factory;
