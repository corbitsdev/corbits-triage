import { action, defineWorkflow, gate, onTrigger, step } from "@intx/workflow";
import { finderAgent, recoverAgent, repoFinderAgent, type Sources } from "../src/agents.js";

const ADDRESS = "pr-code-finder";

const GITHUB: Sources = ["github"];

const FIND = { inference: { from: "steps.input.output.inference" }, after: ["route"], timeout: 10 * 60_000 } as const;

const RECOVER = { inference: { from: "steps.input.output.recoverInference" }, timeout: 10 * 60_000 } as const;

/** The finders alone, for prompt bake-offs: input (action) → find → recover, or findRepo → recoverRepo when the request names a checkout. */
export function prCodeFinder({ systemPrompt }: { systemPrompt?: string } = {}) {
  const body = defineWorkflow({
    id: `${ADDRESS}-run`,
    trigger: { type: "manual" },
    steps: {
      input: action({ handler: "finderInput", input: { from: "trigger.payload" } }),
      route: gate({ when: { from: "steps.input.output.withRepo" }, then: "findRepo", else: "find", after: ["input"] }),
      find: step({ agent: finderAgent(systemPrompt), input: { from: "steps.input.output.text" }, ...FIND }),
      findRepo: step({ agent: repoFinderAgent(GITHUB, systemPrompt), input: { from: "steps.input.output.text" }, ...FIND }),
      recover: step({ agent: recoverAgent, input: { from: "steps.find.output.reply" }, after: ["find"], ...RECOVER }),
      recoverRepo: step({ agent: recoverAgent, input: { from: "steps.findRepo.output.reply" }, after: ["findRepo"], ...RECOVER }),
    },
  });
  return defineWorkflow({
    id: ADDRESS,
    steps: { events: onTrigger({ on: { type: "mail", to: ADDRESS }, body, onBodyFailure: "tolerate" }) },
  });
}
