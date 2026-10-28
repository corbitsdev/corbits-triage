import { defineDirector } from "@intx/agent";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent } from "@intx/types/runtime";
import { type, type Type } from "arktype";
import { Verdict } from "./actions/review.js";
import { MODEL_FAILED } from "./failures.js";
import { packageName } from "./package-name.js";
import type { CodeReviewProfile } from "./profile.js";

export interface StructuredDirectorConfig {
  name: string;
  schema: Record<string, unknown>;
}

/** The steps whose answer must hold more than the response format guarantees. */
const ANSWERS: Record<string, Type> = { check: Verdict };

function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/**
 * One model call with the agent's system prompt and no tools whose answer is decoded against the schema; the reply is
 * the model's JSON. A failed model call, an answer that isn't JSON or, for the check, one that is not a verdict and
 * reason fails the step, so its retry asks again.
 */
function structuredDirector(caps: ReactorCapabilities, systemPrompt: string, { name, schema }: StructuredDirectorConfig): ReactorDirector {
  function reply(turn: AssistantTurn) {
    const text = turnText(turn);
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new Error(`${name}: replied without JSON: ${text.slice(0, 200)}`);
    }
    const checked = ANSWERS[name]?.(answer);
    if (checked instanceof type.errors) throw new Error(`${name}: ${checked.summary}`);
    return caps.reply(text);
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return caps.infer({ systemPrompt, tools: [], responseFormat: { kind: "json-schema", name, schema } });
        case "inference.done":
          return reply(event.turn);
        case "inference.error":
          throw new Error(`${name}: ${MODEL_FAILED}: ${event.error.message}`);
        default:
          return [];
      }
    },
  };
}

export function structuredDirectorOf(profile: CodeReviewProfile) {
  return defineDirector<StructuredDirectorConfig>({
    id: `${packageName(profile.packageName)}/structured`,
    configSchema: type({ name: "string", schema: "Record<string, unknown>" }),
    factory: function buildStructuredDirector(config, _env, agent) {
      return {
        async decide(event, state, caps) {
          return structuredDirector(caps, agent.systemPrompt, config).decide(event, state, caps);
        },
      };
    },
  });
}
