import { defineDirector } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent, TokenUsage, ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { refused, REPO_READ_DEFINITIONS } from "@corbits/repo-read-tool";
import { BUDGET_EXHAUSTED, budgetOf, CHECKOUT_TOOL, checkoutOf } from "./actions/checkout.js";
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

function resultText(result: ToolResult): string {
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

export interface ReaderDirectorConfig {
  /** The tools section appended to the system prompt while the model reads. */
  tools: keyof typeof TOOL_PROMPTS;
}

/**
 * Checks the repository out at the head the input names, out of the model's history, then lets the model read it with
 * the read tools alone until it answers; the reply is the model's final text. An input that names no head gets one
 * call with no tools. Every call keeps the system prompt and tools, which earlier thinking blocks are bound to, so once
 * the input's budget of billable tokens is spent each further tool call is answered with BUDGET_SPENT; after
 * REFUSED_ROUNDS such rounds the model's latest text is the reply. A reply whose calls were refused starts with
 * BUDGET_EXHAUSTED.
 */
function readerDirector(caps: ReactorCapabilities, basePrompt: string, { tools }: ReaderDirectorConfig, billableTokens: (usage: TokenUsage) => number): ReactorDirector {
  const systemPrompt = `${basePrompt.trimEnd()}\n\n${TOOL_PROMPTS[tools]}`;
  let budget = 0;
  let spent = 0;
  let checkedOut = false;
  let refusedRounds = 0;
  let pending = 0;

  function read() {
    return caps.infer({ systemPrompt, tools: REPO_READ_DEFINITIONS });
  }

  function reply(text: string) {
    return caps.reply(refusedRounds > 0 ? `${BUDGET_EXHAUSTED}${text}` : text);
  }

  function start(content: string) {
    const checkout = checkoutOf(content);
    if (!checkout) return caps.infer({ systemPrompt: basePrompt, tools: [] });
    const tokens = budgetOf(content);
    if (tokens === undefined) return caps.reply("reader: the input names no token budget");
    budget = tokens;
    const call = { id: "checkout", name: CHECKOUT_TOOL[checkout.source], arguments: { repo: checkout.repo, sha: checkout.sha } };
    return caps.executeTools([call], false, false);
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
      return caps.executeTools(calls, true);
    }
    if (++refusedRounds > REFUSED_ROUNDS) {
      log.warn("reader kept calling tools past its budget of {budget} tokens; answering with its text", { budget });
      return reply(turnText(turn));
    }
    return caps.executeTools(calls.map((c) => refused(c, BUDGET_SPENT)), true);
  }

  function onToolDone(result: ToolResult) {
    if (!checkedOut) {
      if (result.isError) return caps.reply(`reader: checkout failed: ${resultText(result)}`);
      checkedOut = true;
      return read();
    }
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

export function readerDirectorOf(profile: CodeReviewProfile) {
  return defineDirector<ReaderDirectorConfig>({
    id: `${packageName(profile.packageName)}/reader`,
    configSchema: type({ tools: type.enumerated(...Object.keys(TOOL_PROMPTS)) }),
    factory: function buildReaderDirector(config, _env, agent) {
      return lazy(function buildDirector(caps) {
        return readerDirector(caps, agent.systemPrompt, config, profile.billableTokens);
      });
    },
  });
}
