import { defineDirector } from "@intx/agent";
import type { AssistantTurn, ReactorCapabilities, ReactorDirector, ReactorInboundEvent } from "@intx/types/runtime";
import { type } from "arktype";
import { PACKAGE_NAME } from "./package-name.js";

export interface StructuredDirectorConfig {
  name: string;
  schema: Record<string, unknown>;
}

function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/** One model call with the agent's system prompt and no tools whose answer is decoded against the schema; the reply is the model's JSON. */
function structuredDirector(caps: ReactorCapabilities, systemPrompt: string, { name, schema }: StructuredDirectorConfig): ReactorDirector {
  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received":
          return caps.infer({ systemPrompt, tools: [], responseFormat: { kind: "json-schema", name, schema } });
        case "inference.done":
          return caps.reply(turnText(event.turn));
        case "inference.error":
          return caps.reply(`${name}: inference failed: ${event.error.message}`);
        case "abort":
          return caps.reply(`${name}: aborted`);
        default:
          return [];
      }
    },
  };
}

export const structured = defineDirector<StructuredDirectorConfig>({
  id: `${PACKAGE_NAME}/structured`,
  configSchema: type({ name: "string", schema: "Record<string, unknown>" }),
  factory: function buildStructuredDirector(config, _env, agent) {
    return {
      async decide(event, state, caps) {
        return structuredDirector(caps, agent.systemPrompt, config).decide(event, state, caps);
      },
    };
  },
});
