import { reviewInputFor } from "@corbits/pr-code-review/actions/review";
import { ANTHROPIC } from "../profile.js";

export { checkout } from "@corbits/pr-code-review/actions/checkout";
export { ciAnnotations } from "@corbits/pr-code-review/actions/ci-annotations";
export { lint } from "@corbits/pr-code-review/actions/lint";
export { candidates, checks, findersInput, review, writeInput } from "@corbits/pr-code-review/actions/review";

export const reviewInput = reviewInputFor(ANTHROPIC);
