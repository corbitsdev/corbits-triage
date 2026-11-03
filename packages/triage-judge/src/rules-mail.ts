import { defineAgent, defineDirector } from "@intx/agent";
import type { ReactorDirector } from "@intx/types/runtime";
import { type } from "arktype";
import { JUDGE_RULES_ATTACHMENT } from "@corbits/triage-contracts";
import { judgeAgent } from "@corbits/triage-workflows/agents";

/** Stock resolves a mail's attachments only for an agent step, so this director, which makes no model call, replies with the rules attachment's text for the action steps to read. */
function rulesDirector(): ReactorDirector {
  return {
    async decide(event, _state, caps) {
      if (event.type !== "message.received") return [];
      const rules = event.message.attachments?.find((attachment) => attachment.name === JUDGE_RULES_ATTACHMENT);
      if (!rules) throw new Error(`the judge mail carries no ${JUDGE_RULES_ATTACHMENT}`);
      return caps.reply(new TextDecoder().decode(rules.data));
    },
  };
}

/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;

export const rulesMailDirector = defineDirector<Record<string, never>>({
  id: `${typeof WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/triage-judge" : WORKFLOW_PACKAGE_NAME}/rules`,
  configSchema: type({}),
  factory: rulesDirector,
});

/** The agent that reads the rules the manager attached; `inference` is declared because every agent names one, and is never called. */
export const rulesMailAgent = defineAgent({ id: "triage-judge-rules", systemPrompt: "Reply with the attached rules.", tools: [], capabilities: [], inference: judgeAgent.inference, director: rulesMailDirector.build({}) });
