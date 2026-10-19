import { defineDirector } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent, TokenUsage, ToolCall } from "@intx/types/runtime";
import { type } from "arktype";
import { refused, REPO_READ_DEFINITIONS, rootedAt } from "@corbits/repo-read-tool";
import { BUDGET_EXHAUSTED, budgetOf, checkoutOf, checkoutPath, isCheckedOut } from "./actions/checkout.js";
import { TOOL_PROMPTS } from "./prompts.js";
import { packageName } from "./package-name.js";
import type { CodeReviewProfile } from "./profile.js";

const log = getLogger(["corbits", "pr-code-review", "reader"]);

const READ_TOOLS = new Set(REPO_READ_DEFINITIONS.map((d) => d.name));

const BUDGET_SPENT = "Budget spent. Answer now with your findings in the required JSON.";

// Rounds of refused calls before the model's text is taken as its answer.
const REFUSED_ROUNDS = 2;

function toolCalls(turn: AssistantTurn): ToolCall[] {
  return turn.content.flatMap((b) => (b.type === "tool_call" ? [{ id: b.id, name: b.name, arguments: b.arguments }] : []));
}

function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

export interface ReaderDirectorConfig {
  /** The tools section appended to the system prompt while the model reads. */
  tools: keyof typeof TOOL_PROMPTS;
}

/**
 * Lets the model read the checkout of the head the input names under `dataDir` with the read tools alone, each call
 * confined to its folder, until it answers; the reply is the model's final text. An input that names no head gets one
 * call with no tools; a head not checked out on this sidecar fails the step. Every call keeps the system prompt and
 * tools, which earlier thinking blocks are bound to, so once the input's budget of billable tokens is spent each
 * further tool call is answered with BUDGET_SPENT; after REFUSED_ROUNDS such rounds the model's latest text is the
 * reply. A reply whose calls were refused starts with BUDGET_EXHAUSTED.
 */
function readerDirector(caps: ReactorCapabilities, basePrompt: string, { tools }: ReaderDirectorConfig, billableTokens: (usage: TokenUsage) => number, dataDir: () => string): ReactorDirector {
  const systemPrompt = `${basePrompt.trimEnd()}\n\n${TOOL_PROMPTS[tools]}`;
  let budget = 0;
  let spent = 0;
  let root = "";
  let refusedRounds = 0;
  let pending = 0;

  function read() {
    return caps.infer({ systemPrompt, tools: REPO_READ_DEFINITIONS });
  }

  function reply(text: string) {
    return caps.reply(refusedRounds > 0 ? `${BUDGET_EXHAUSTED}${text}` : text);
  }

  async function start(content: string) {
    const checkout = checkoutOf(content);
    if (!checkout) return caps.infer({ systemPrompt: basePrompt, tools: [] });
    const tokens = budgetOf(content);
    if (tokens === undefined) return caps.reply("reader: the input names no token budget");
    const path = checkoutPath(dataDir(), checkout);
    // The checkout action left it on the sidecar that ran it; a run resumed on another sidecar fails here.
    if (!(await isCheckedOut(path))) throw new Error(`reader: no checkout at ${path} on this sidecar`);
    budget = tokens;
    root = path;
    return read();
  }

  function onTurn(turn: AssistantTurn, usage: TokenUsage) {
    spent += billableTokens(usage);
    const calls = toolCalls(turn);
    if (calls.length === 0) return reply(turnText(turn));
    const unknown = calls.find((c) => !READ_TOOLS.has(c.name));
    if (unknown) return caps.reply(`reader: refused tool ${unknown.name}`);
    pending = calls.length;
    if (spent < budget) {
      for (const c of calls) log.info("reader tool {name} {arguments}", { name: c.name, arguments: c.arguments });
      return caps.executeTools(calls.map((c) => rootedAt(c, root)), true);
    }
    if (++refusedRounds > REFUSED_ROUNDS) {
      log.warn("reader kept calling tools past its budget of {budget} tokens; answering with its text", { budget });
      return reply(turnText(turn));
    }
    return caps.executeTools(calls.map((c) => refused(c, BUDGET_SPENT)), true);
  }

  function onToolDone() {
    if (--pending > 0) return [];
    return read();
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return start(event.message.content ?? "");
        case "tool.done":
          return onToolDone();
        case "inference.done":
          return onTurn(event.turn, event.usage);
        case "inference.error":
          return caps.reply(`reader: inference failed: ${event.error.message}`);
        case "abort":
          return caps.reply("reader: aborted");
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
    configSchema: type({ tools: type.enumerated(...Object.keys(TOOL_PROMPTS)) }),
    factory: function buildReaderDirector(config, _env, agent) {
      return lazy(function buildDirector(caps) {
        return readerDirector(caps, agent.systemPrompt, config, profile.billableTokens, dataDir);
      });
    },
  });
}
