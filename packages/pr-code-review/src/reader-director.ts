import { defineDirector } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent, TokenUsage, ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { refused, REPO_READ_DEFINITIONS, rootedAt } from "@corbits/repo-read-tool";
import { BUDGET_EXHAUSTED, budgetOf, checkoutOf, checkoutPath, diffDirOf, isCheckedOut } from "./actions/checkout.js";
import { MODEL_FAILED, NO_CHECKOUT, NO_VERDICT, UNREADABLE } from "./failures.js";
import { Verdict } from "./actions/review.js";
import { firstObject, parseFindings } from "./findings.js";
import { addRead, addWindow, citesLineRead, linesShown, type LinesRead } from "./lines-read.js";
import { shownTag } from "./diff-parts.js";
import { TOOL_PROMPTS } from "./prompts.js";
import { packageName } from "./package-name.js";
import type { CodeReviewProfile } from "./profile.js";

const log = getLogger(["corbits", "pr-code-review", "reader"]);

const READ_TOOLS = new Set(REPO_READ_DEFINITIONS.map((d) => d.name));

const BUDGET_SPENT = "Budget spent. Answer now in the required JSON.";

// A check whose budget ran out before it gave a verdict it could stand behind.
export const CHECK_UNFINISHED = "The check spent its budget before it could decide.";
// Leads the reason of a real or not_real verdict that cites no line the check read.
export const UNCITED = "no cited line";

// Rounds of refused calls before the model's text is taken as its answer.
const REFUSED_ROUNDS = 2;

function toolCalls(turn: AssistantTurn): ToolCall[] {
  return turn.content.flatMap((b) => (b.type === "tool_call" ? [{ id: b.id, name: b.name, arguments: b.arguments }] : []));
}

function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

const ANSWERS = ["findings", "verdict", "plan"] as const;

export interface ReaderDirectorConfig {
  /** The tools section appended to the system prompt while the model reads; absent for a finder that reads no checkout. */
  tools?: keyof typeof TOOL_PROMPTS;
  /** What the reply must hold: a findings list, the check's verdict and reason, or the review's plan. */
  answer: (typeof ANSWERS)[number];
}

type Verdict = typeof Verdict.infer;

const Plan = type({
  areas: type({ path: "string", why: "string", what_to_check: "string" }).array(),
  outside_diff: type({ symbol_or_path: "string", why: "string" }).array(),
});
type Plan = typeof Plan.infer;

function planOf(json: unknown): Plan | undefined {
  const plan = Plan(json);
  return plan instanceof type.errors ? undefined : plan;
}

function verdictOf(json: unknown): Verdict | undefined {
  const verdict = Verdict(json);
  return verdict instanceof type.errors ? undefined : verdict;
}

/**
 * Lets the model read the checkout of the head the input names under `dataDir` with the read tools alone, each call
 * confined to its folder, until it answers; the reply is the model's final text. An input that names no head gets one
 * call with no tools; a head not checked out on this sidecar fails the step. Every call keeps the system prompt and
 * tools, which earlier thinking blocks are bound to, so once the input's budget of billable tokens is spent each
 * further tool call is answered with BUDGET_SPENT; after REFUSED_ROUNDS such rounds the model's latest text is the
 * reply. A findings reply whose calls were refused, or with no findings list once the budget is spent, starts with
 * BUDGET_EXHAUSTED; one that read a checkout ends with the lines of each diff patch file read_file showed it. A plan reply is the first plan in the model's text, or its text once a call was refused or the budget
 * is spent. A verdict reply is the first verdict and reason in the model's text; a real or not_real one that
 * cites, as path:line, no line the input's diff hunks or the model's reads showed is unsure, its reason led by UNCITED.
 * Once a call was refused, only a not_real that cites one stands, and any other verdict, or none, is unsure; so is no
 * verdict once the budget is spent. Any other answer with no findings list or no verdict, or a failed model call, fails
 * the step, so its retry asks again; stock retries every failure alike, so a missing checkout or a refused tool is
 * tried again too.
 */
function readerDirector(caps: ReactorCapabilities, basePrompt: string, { tools, answer }: ReaderDirectorConfig, billableTokens: (usage: TokenUsage) => number, dataDir: () => string): ReactorDirector {
  const systemPrompt = tools ? `${basePrompt.trimEnd()}\n\n${TOOL_PROMPTS[tools]}` : basePrompt;
  let budget = 0;
  let spent = 0;
  let root = "";
  let refusedRounds = 0;
  let pending = 0;
  let linesRead: LinesRead = new Map();
  // Only read_file windows show a patch file's lines in full; grep's matches never count toward reading the diff whole.
  const windowsRead: LinesRead = new Map();

  function read() {
    return caps.infer({ systemPrompt, tools: REPO_READ_DEFINITIONS });
  }

  function reply(text: string) {
    if (answer === "verdict") return verdictReply(text);
    if (answer === "plan") return planReply(text);
    return caps.reply(`${findingsText(text)}${root === "" ? "" : shownTag(windowsRead)}`);
  }

  function findingsText(text: string): string {
    if (refusedRounds > 0) return `${BUDGET_EXHAUSTED}${text}`;
    if (!("unparsable" in parseFindings(text))) return text;
    if (root !== "" && spent >= budget) return `${BUDGET_EXHAUSTED}${text}`;
    throw new Error(UNREADABLE);
  }

  function planReply(text: string) {
    const plan = firstObject(text, planOf);
    if (plan) return caps.reply(JSON.stringify(plan));
    if (refusedRounds > 0 || (root !== "" && spent >= budget)) return caps.reply(text);
    throw new Error(UNREADABLE);
  }

  function cited(verdict: Verdict): boolean {
    return verdict.verdict === "unsure" || citesLineRead(verdict.reason, linesRead);
  }

  function unsure(reason: string) {
    return caps.reply(JSON.stringify({ verdict: "unsure", reason }));
  }

  function verdictReply(text: string) {
    const verdict = firstObject(text, verdictOf);
    if (refusedRounds > 0) return verdict?.verdict === "not_real" && cited(verdict) ? caps.reply(JSON.stringify(verdict)) : unsure(verdict?.reason ?? CHECK_UNFINISHED);
    if (!verdict && root !== "" && spent >= budget) return unsure(CHECK_UNFINISHED);
    if (!verdict) throw new Error(NO_VERDICT);
    if (!cited(verdict)) return unsure(`${UNCITED}: ${verdict.reason}`);
    return caps.reply(JSON.stringify(verdict));
  }

  async function start(content: string) {
    const checkout = checkoutOf(content);
    if (!checkout) return caps.infer({ systemPrompt: basePrompt, tools: [] });
    if (!tools) throw new Error("reader: the input names a checkout this agent does not read");
    const tokens = budgetOf(content);
    if (tokens === undefined) throw new Error("reader: the input names no token budget");
    const path = checkoutPath(dataDir(), checkout);
    // The checkout action left it on the sidecar that ran it; a run resumed on another sidecar fails here.
    if (!(await isCheckedOut(path))) throw new Error(`${NO_CHECKOUT} at ${path} on this sidecar`);
    budget = tokens;
    root = path;
    linesRead = linesShown(content);
    return read();
  }

  function onTurn(turn: AssistantTurn, usage: TokenUsage) {
    spent += billableTokens(usage);
    const calls = toolCalls(turn);
    if (calls.length === 0) return reply(turnText(turn));
    const unknown = calls.find((c) => !READ_TOOLS.has(c.name));
    if (unknown) throw new Error(`reader: refused tool ${unknown.name}`);
    pending = calls.length;
    if (spent < budget) {
      for (const c of calls) log.info("reader tool {name} {arguments}", { name: c.name, arguments: c.arguments });
      return caps.executeTools(calls.map((c) => rootedAt(c, root, diffDirOf(root))), true);
    }
    if (++refusedRounds > REFUSED_ROUNDS) {
      log.warn("reader kept calling tools past its budget of {budget} tokens; answering with its text", { budget });
      return reply(turnText(turn));
    }
    return caps.executeTools(calls.map((c) => refused(c, BUDGET_SPENT)), true);
  }

  function onToolDone(result: ToolResult) {
    addRead(linesRead, result);
    addWindow(windowsRead, result);
    if (--pending > 0) return [];
    return read();
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return start(event.message.content ?? "");
        case "tool.done":
          return onToolDone(event.result);
        case "inference.done":
          return onTurn(event.turn, event.usage);
        case "inference.error":
          throw new Error(`reader: ${MODEL_FAILED}: ${event.error.message}`);
        default:
          return [];
      }
    },
  };
}

function lazy(build: (caps: ReactorCapabilities) => ReactorDirector): ReactorDirector {
  let inner: ReactorDirector | undefined;
  return {
    async decide(event, state, caps) {
      return (inner ??= build(caps)).decide(event, state, caps);
    },
  };
}

/** The reader over the checkouts under the sidecar data dir `dataDir` names. */
export function readerDirectorOf(profile: CodeReviewProfile, dataDir: () => string) {
  return defineDirector<ReaderDirectorConfig>({
    id: `${packageName(profile.packageName)}/reader`,
    configSchema: type({ "tools?": type.enumerated(...Object.keys(TOOL_PROMPTS)), answer: type.enumerated(...ANSWERS) }),
    factory: function buildReaderDirector(config, _env, agent) {
      return lazy(function buildDirector(caps) {
        return readerDirector(caps, agent.systemPrompt, config, profile.billableTokens, dataDir);
      });
    },
  });
}
