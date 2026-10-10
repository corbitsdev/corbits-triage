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
import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { repoPolicy, type CheckPack, type CleanupMode } from "@corbits/triage-contracts";
import { NEEDS_SETUP_REASON, packFromInput, type DeterministicResult, type PrFacts } from "./logic/checks.js";
import { asText, parseJsonText } from "./logic/extract.js";
import { qualityQuestions, qualityState } from "./logic/quality.js";
import { buildFacts, type CheckRun, type PrData, type Review } from "./logic/facts.js";
import { degradedItem, type Item } from "./logic/item.js";
import type { Verdict } from "./logic/render.js";
import { evaluate, rules } from "./actions/index.js";

export type Role = "facts" | "judge" | "render" | "mirror";

export interface TriageDirectorConfig {
  role: Role;
}

/** Directors call the action handlers in-process, where nothing performs effects or cancels them. */
const NO_EFFECTS: EffectContext = {
  perform() {
    throw new Error("triage directors perform no effects");
  },
};
const NEVER_ABORTED = new AbortController().signal;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The step input arrives as the inbound message text; a prior step's output is `{ reply, turn }` with the JSON in `reply`. */
function parseInput(content: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseJsonText(content ?? "");
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.reply === "string") {
    const inner = parseJsonText(parsed.reply);
    if (isRecord(inner)) return inner;
  }
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

function cleanupModeOf(v: Record<string, unknown>): CleanupMode | undefined {
  return v.cleanupMode === "automated" || v.cleanupMode === "human-approved" ? v.cleanupMode : undefined;
}

function itemsOf(input: Record<string, unknown>): { items: Item[]; batch: boolean } {
  return Array.isArray(input.items)
    ? { items: input.items as Item[], batch: true }
    : { items: [{ facts: input.facts as PrFacts, det: input.det as DeterministicResult, judge: input.judge as string | undefined, judgeError: input.judgeError as string | undefined, cleanupMode: cleanupModeOf(input), error: input.error as string | undefined }], batch: false };
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

type ChangedFile = { filename?: string; path?: string };

function pathOf(file: ChangedFile): string[] {
  const name = file.filename ?? file.path;
  return typeof name === "string" && name.length > 0 ? [name] : [];
}

function firstLine(commit: { message?: string }): string {
  return (commit.message ?? "").split("\n", 1)[0]!;
}

function factsDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  function fail(reason: string) {
    return caps.reply(JSON.stringify(degradedItem(reason)));
  }

  function fetchTargets(repo: string, numbers: number[], openPrs: PrFacts["openPrs"], batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack) {
    function prCalls(n: number): ToolCall[] {
      return [
        call("github_get_pr", { repo, number: n }, `pr:${n}`),
        call("github_get_reviews", { repo, number: n }, `reviews:${n}`),
        call("github_list_pr_commits", { repo, number: n }, `commits:${n}`),
        call("github_list_pr_files", { repo, number: n }, `files:${n}`),
      ];
    }

    function onPrs(r1: BatchResults) {
      const prs = new Map(numbers.map((n) => [n, data<PrData>(r1.get(`pr:${n}`))]));

      function checkCall(n: number): ToolCall[] {
        const sha = prs.get(n)?.sha;
        return sha ? [call("github_get_checks", { repo, sha }, `checks:${n}`)] : [];
      }

      async function onChecks(r2: BatchResults) {
        function itemFor(n: number) {
          const pr = prs.get(n);
          if (!pr) return { error: `github_get_pr failed for #${n}` };
          const checks = data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [];
          const reviews = data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [];
          const paths = data<{ files: ChangedFile[] }>(r1.get(`files:${n}`))?.files?.flatMap(pathOf) ?? [];
          const commits = data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits?.map(firstLine) ?? [];
          const facts = { ...buildFacts(repo, n, pr, checks, reviews, openPrs), paths, commits };
          return { facts, pack, cleanupMode: policy.cleanupMode };
        }
        const { items } = await rules({ items: numbers.map(itemFor) }, NO_EFFECTS, NEVER_ABORTED);
        return caps.reply(JSON.stringify(batch ? { items } : items[0]));
      }

      return b.run(numbers.flatMap(checkCall), onChecks);
    }

    return b.run(numbers.flatMap(prCalls), onPrs);
  }

  /** Lists the open pull requests, then gathers facts for `targets`, or for all of them when none are named. */
  function fetchListed(repo: string, targets: number[] | undefined, batch: boolean, policy: ReturnType<typeof repoPolicy>, pack: CheckPack) {
    return b.run([call("github_list_open_prs", { repo })], function onPrList(r) {
      const list = data<{ prs: Array<{ number: number; title: string; draft?: boolean }> }>(r.get("github_list_open_prs"));
      if (!list && targets === undefined) return fail("github_list_open_prs failed");
      const listed = list?.prs ?? [];
      const openPrs = listed.map(({ number, title }) => ({ number, title }));
      const triageable = listed.filter((p) => policy.triageDrafts || p.draft !== true).map((p) => p.number);
      return fetchTargets(repo, targets ?? triageable, openPrs, batch, policy, pack);
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
    if (input?.kind === "backlog") return fetchListed(repo, undefined, true, policy, pack);
    if (input?.kind !== "pr") return fail("facts: input is neither pr nor backlog");
    // A catch-up mail names several heads as `items`; each is triaged like a single mail and rendered in this order.
    if (Array.isArray(input.items)) {
      const numbers = input.items.flatMap((item) => (isRecord(item) && typeof item.prNumber === "number" ? [item.prNumber] : []));
      if (numbers.length === 0) return fail("facts: batch names no pull request");
      return fetchListed(repo, numbers, true, policy, pack);
    }
    const number = input.prNumber;
    if (typeof number !== "number") return fail("facts: pr input has no prNumber");
    return fetchListed(repo, [number], false, policy, pack);
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

/** The only inference path: asks Jev about the items that need judgment, one at a time, and passes everything else through. */
function judgeDirector(caps: ReactorCapabilities, systemPrompt: string): ReactorDirector {
  let input: Record<string, unknown> | undefined;
  let items: Item[] = [];
  let batch = false;
  let queue: number[] = [];
  let current = -1;

  function ask() {
    const next = queue.shift();
    if (next === undefined) return caps.reply(JSON.stringify(batch ? { items } : items[0]));
    current = next;
    const { facts, det } = items[current];
    const questions = qualityQuestions(det.sources!);
    return caps.infer({ systemPrompt, tools: [], providerOptions: { systemOne: { state: qualityState(facts), questions } } });
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          input = parseInput(event.message.content);
          if (!input) return caps.reply(JSON.stringify(degradedItem("judge: input is not JSON")));
          ({ items, batch } = itemsOf(input));
          queue = items.flatMap((it, i) => (it.det?.needsJudgment ? [i] : []));
          return ask();
        }
        case "inference.done":
          items[current] = { ...items[current], judge: turnText(event.turn) };
          return ask();
        case "inference.error":
          items[current] = { ...items[current], judgeError: event.error.message };
          return ask();
        case "abort":
          return caps.reply(JSON.stringify(batch ? { items } : (items[0] ?? degradedItem("judge aborted"))));
        default:
          return [];
      }
    },
  };
}

function renderDirector(caps: ReactorCapabilities): ReactorDirector {
  async function degraded(reason: string) {
    return caps.reply(JSON.stringify(await evaluate({ items: [degradedItem(reason)], batch: false }, NO_EFFECTS, NEVER_ABORTED)));
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return degraded("render: input is not JSON");
          return caps.reply(JSON.stringify(await evaluate(itemsOf(input), NO_EFFECTS, NEVER_ABORTED)));
        }
        case "abort":
        case "inference.error":
          return degraded(`render interrupted: ${event.type}`);
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
    return call("github_mirror_auto", { repo: r.repo, number: r.number, labels: r.labels, comment: r.comment, close: false }, `github_mirror_auto:${r.repo}#${r.number}`);
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
  configSchema: type({ role: "'facts' | 'judge' | 'render' | 'mirror'" }),
  factory: function buildTriageDirector({ role }, _env, agent) {
    return lazy(function buildRoleDirector(caps) {
      switch (role) {
        case "facts":
          return factsDirector(caps);
        case "judge":
          return judgeDirector(caps, agent.systemPrompt);
        case "render":
          return renderDirector(caps);
        case "mirror":
          return mirrorDirector(caps);
      }
    });
  },
});

export const triageDirectorFactory = triageDirector.factory;
