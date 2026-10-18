import { readFileSync } from "node:fs";
import { type } from "arktype";
import { triggerRequestOf } from "@corbits/triage-contracts";
import { budgetTag, Checkout, DEFAULT_BUDGET, repositoryTag } from "@corbits/pr-code-review/actions/checkout";

const USER_TEMPLATE = readFileSync(new URL("../prompts/finder-diff.user.txt", import.meta.url), "utf8");

const MAX_OUTPUT_TOKENS = 16_000;

const FinderRequest = type({
  kind: "'code-review'",
  title: "string",
  description: "string",
  diff: "string",
  effort: "'low' | 'medium' | 'high'",
  "checkout?": Checkout,
  "budget?": "number.integer > 0",
});
type FinderRequest = typeof FinderRequest.infer;

function render(request: FinderRequest): string {
  const text = USER_TEMPLATE.replace(/\{\{(title|description|diff)\}\}/g, (_, key: "title" | "description" | "diff") => request[key]);
  return request.checkout ? `${repositoryTag(request.checkout)}${budgetTag(request.budget ?? DEFAULT_BUDGET)}${text}` : text;
}

/** The finder's user message from the trigger mail's request, the per-call options its step infers with, and whether it reads the repository. */
export async function finderInput(input: unknown) {
  const request = FinderRequest(triggerRequestOf(input));
  if (request instanceof type.errors) throw new Error(`finderInput: invalid request: ${request.summary}`);
  return { text: render(request), inference: { effort: request.effort, maxTokens: MAX_OUTPUT_TOKENS }, withRepo: request.checkout !== undefined };
}
