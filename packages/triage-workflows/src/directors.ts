import { defineDirector } from "@intx/agent";
import type { ReactorCapabilities, ReactorDirector, ReactorInboundEvent } from "@intx/types/runtime";
import { type } from "arktype";
import { isRecord } from "@corbits/common";
import { lazy, turnText } from "@corbits/common/reactor";
import { parseJsonText } from "./logic/extract.js";
import type { Judgment } from "./actions/evaluate.js";

/** The only inference path: one System One call for one rules chunk, replied as that chunk's `Judgment`. */
function judgeDirector(caps: ReactorCapabilities, systemPrompt: string): ReactorDirector {
  function answer(judgment: Judgment) {
    return caps.reply(JSON.stringify(judgment));
  }

  return {
    async decide(event: ReactorInboundEvent) {
      switch (event.type) {
        case "message.received": {
          // The step input, one rules chunk, arrives as the message's JSON text.
          const chunk = parseJsonText(event.message.content ?? "");
          if (!isRecord(chunk) || !isRecord(chunk.state) || !Array.isArray(chunk.questions)) return answer({ judgeError: "judge input is not a chunk" });
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

/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;
const workflowPackageName = typeof WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/triage-workflows" : WORKFLOW_PACKAGE_NAME;

export const triageJudgeDirector = defineDirector<Record<string, never>>({
  id: `${workflowPackageName}/judge`,
  configSchema: type({}),
  factory: function buildJudgeDirector(_config, _env, agent) {
    return lazy(function buildForCaps(caps) {
      return judgeDirector(caps, agent.systemPrompt);
    });
  },
});

export const triageJudgeDirectorFactory = triageJudgeDirector.factory;
