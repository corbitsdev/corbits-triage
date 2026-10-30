import { action, defineWorkflow, gate, onTrigger, step } from "@intx/workflow";
import { checkoutAction } from "@corbits/pr-code-review/pr-code-review";
import { finderAgent, type Sources } from "../src/agents.js";

const ADDRESS = "pr-code-finder";

const GITHUB: Sources = ["github"];

const FIND = { inference: { from: "steps.input.output.inference" }, timeout: 10 * 60_000 } as const;

/** The finders alone, for prompt bake-offs: input (action) → find, or checkout → findRepo when the request names a checkout. */
export function prCodeFinder({ systemPrompt }: { systemPrompt?: string } = {}) {
  const body = defineWorkflow({
    id: `${ADDRESS}-run`,
    trigger: { type: "manual" },
    steps: {
      input: action({ handler: "finderInput", input: { from: "trigger.payload" } }),
      route: gate({ when: { from: "steps.input.output.withRepo" }, then: "checkout", else: "find", after: ["input"] }),
      find: step({ agent: finderAgent(systemPrompt), input: { from: "steps.input.output.text" }, ...FIND, after: ["route"] }),
      checkout: checkoutAction(GITHUB, { from: "steps.input.output.checkout" }, ["route"]),
      findRepo: step({ agent: finderAgent(systemPrompt), input: { from: "steps.input.output.text" }, ...FIND, after: ["checkout"] }),
    },
  });
  return defineWorkflow({
    id: ADDRESS,
    steps: { events: onTrigger({ on: { type: "mail", to: ADDRESS }, body, onBodyFailure: "tolerate" }) },
  });
}
