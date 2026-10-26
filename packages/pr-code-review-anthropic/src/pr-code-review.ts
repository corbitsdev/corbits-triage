import { codeReviewWorkflow } from "@corbits/pr-code-review/pr-code-review";
import { agents } from "./agents.js";

/** The review for the given hosts on Anthropic's models, which the tests and evals run locally. */
export const prCodeReview = codeReviewWorkflow(agents);

/** The library definition the evals run. */
export const workflow = prCodeReview({ sources: ["github"] });
