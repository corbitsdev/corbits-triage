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
import { repoPolicy, type CheckPack, type CleanupMode } from "@corbits/triage-contracts";
import { deriveState, NEEDS_SETUP_REASON, packFromInput, type DeterministicResult, type PrFacts } from "./logic/checks.js";
import { asText, parseJsonText } from "./logic/extract.js";
import { qualityQuestions, qualityState } from "./logic/quality.js";
import { buildFacts, type CheckRun, type PrData, type Review } from "./logic/facts.js";
import { degradedVerdict, parseAnswers, renderVerdict, summarize, toMirrorRequest, type MirrorRequest, type RenderOutput } from "./logic/render.js";

export type Role = "facts" | "judge" | "render" | "mirror";

export interface TriageDirectorConfig {
  role: Role;
}

interface Item {
  facts: PrFacts;
  det: DeterministicResult;
  judge?: string;
  judgeError?: string;
  cleanupMode?: CleanupMode;
  pack?: CheckPack;
}

type Verdict = RenderOutput & { repo: string; number: number; request: MirrorRequest; cleanupMode?: CleanupMode };

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const NO_FACTS: PrFacts = {
  repo: "", number: 0, title: "", author: "", headSha: "", state: "open", draft: false, mergeable: null,
  baseBehindBy: 0, checks: "none", requestedReviewers: 0, approvals: 0, openPrs: [],
};

function degradedItem(reason: string): Item {
  return {
    facts: NO_FACTS,
    det: { state: "stale-unknown", reason, findings: [], duplicateOf: null, needsJudgment: false },
  };
}

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
    : { items: [{ facts: input.facts as PrFacts, det: input.det as DeterministicResult, judge: input.judge as string | undefined, judgeError: input.judgeError as string | undefined, cleanupMode: cleanupModeOf(input) }], batch: false };
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
type DirectorActions = ReactorAction | ReactorAction[];

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
  function expect(n: number) {
    outstanding = n;
    results = new Map();
  }
  return { run, settle, expect };
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

      function onChecks(r2: BatchResults) {
        function itemFor(n: number): Item {
          const pr = prs.get(n);
          if (!pr) return degradedItem(`github_get_pr failed for #${n}`);
          const checks = data<{ checks: CheckRun[] }>(r2.get(`checks:${n}`))?.checks ?? [];
          const reviews = data<{ reviews: Review[] }>(r1.get(`reviews:${n}`))?.reviews ?? [];
          const paths = data<{ files: ChangedFile[] }>(r1.get(`files:${n}`))?.files?.flatMap(pathOf) ?? [];
          const commits = data<{ commits: Array<{ message?: string }> }>(r1.get(`commits:${n}`))?.commits?.map(firstLine) ?? [];
          const facts = { ...buildFacts(repo, n, pr, checks, reviews, openPrs), paths, commits };
          return { facts, det: deriveState(facts, policy, pack), cleanupMode: policy.cleanupMode, pack };
        }
        const items = numbers.map(itemFor);
        return caps.reply(JSON.stringify(batch ? { items } : items[0]));
      }

      return b.run(numbers.flatMap(checkCall), onChecks);
    }

    return b.run(numbers.flatMap(prCalls), onPrs);
  }

  function start(message: { content?: string }) {
    const input = parseInput(message.content);
    const repo = input?.repo;
    const policy = repoPolicy(input?.policy);
    if (typeof repo !== "string") return fail("facts: input has no repo");
    if (!policy.classificationAuthorized) return fail("Classification is paused for this repository.");
    const pack = packFromInput(input?.checkPack);
    if (!pack) return fail(NEEDS_SETUP_REASON);
    if (input?.kind === "backlog") {
      return b.run([call("github_list_open_prs", { repo })], function onBacklogList(r) {
        const list = data<{ prs: Array<{ number: number; title: string }> }>(r.get("github_list_open_prs"));
        if (!list) return fail("github_list_open_prs failed");
        const openPrs = list.prs.map(({ number, title }) => ({ number, title }));
        return fetchTargets(repo, openPrs.map((p) => p.number), openPrs, true, policy, pack);
      });
    }
    const number = input?.prNumber;
    if (input?.kind !== "pr" || typeof number !== "number") return fail("facts: input is neither pr nor backlog");
    return b.run([call("github_list_open_prs", { repo })], function onPrList(r) {
      const prs = data<{ prs: Array<{ number: number; title: string }> }>(r.get("github_list_open_prs"))?.prs ?? [];
      return fetchTargets(repo, [number], prs.map(({ number, title }) => ({ number, title })), false, policy, pack);
    });
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
  function verdictOf(it: Item): Verdict {
    try {
      const answers = it.judge !== undefined ? parseAnswers(it.judge) : null;
      const verdict = { repo: it.facts.repo, number: it.facts.number, ...renderVerdict({ author: it.facts.author, det: it.det, answers, judgeError: it.judgeError }), cleanupMode: it.cleanupMode };
      return { ...verdict, request: toMirrorRequest(verdict) };
    } catch (e) {
      const verdict = { repo: it.facts?.repo ?? "", number: it.facts?.number ?? 0, ...degradedVerdict(`render failed: ${errorText(e)}`), cleanupMode: it.cleanupMode };
      return { ...verdict, request: toMirrorRequest(verdict) };
    }
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return caps.reply(JSON.stringify(verdictOf(degradedItem("render: input is not JSON"))));
          const { items, batch } = itemsOf(input);
          const verdicts = items.map(verdictOf);
          return caps.reply(JSON.stringify(batch ? { items: verdicts, summary: summarize(verdicts) } : verdicts[0]));
        }
        case "abort":
        case "inference.error":
          return caps.reply(JSON.stringify(verdictOf(degradedItem(`render interrupted: ${event.type}`))));
        default:
          return [];
      }
    },
  };
}

/** github_mirror is approval-gated, so the parked call's outcome can arrive after a director rebuild; results are keyed by call id alone. */
function mirrorDirector(caps: ReactorCapabilities): ReactorDirector {
  const b = batcher(caps);
  let batch = false;

  function finish(results: BatchResults) {
    const outcomes = [...results.values()].map((r) => ({ call: r.callId, ok: !r.isError, ...(r.isError ? { error: asText(r.content) } : {}) }));
    return caps.reply(JSON.stringify(batch ? { results: outcomes } : (outcomes[0] ?? { skipped: true })));
  }

  function mirrorCall(v: Verdict): ToolCall {
    const tool = v.cleanupMode === "automated" ? "github_mirror_auto" : "github_mirror";
    const r = v.request;
    return call(tool, { repo: r.repo, number: r.number, labels: r.labels, comment: r.comment, close: false }, `${tool}:${r.repo}#${r.number}`);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          const input = parseInput(event.message.content);
          if (!input) return caps.reply(JSON.stringify({ skipped: true, reason: "mirror: input is not JSON" }));
          const parsed = verdictsOf(input);
          batch = parsed.batch;
          const mirrored = parsed.verdicts.filter((v) => v.mirror === true && v.request);
          if (!mirrored.length) return caps.reply(JSON.stringify({ skipped: true }));
          return b.run(mirrored.map(mirrorCall), finish);
        }
        case "tool.done":
          return b.settle(event.result);
        case "resume.execute_tools":
          b.expect(event.calls.length);
          return caps.executeTools(event.calls, false, true);
        case "resume.tool_result":
          b.expect(1);
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
