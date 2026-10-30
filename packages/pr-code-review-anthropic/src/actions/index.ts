import { reviewInputFor } from "@corbits/pr-code-review/actions/review";
import { ANTHROPIC } from "../profile.js";

export { checkout } from "@corbits/pr-code-review/actions/checkout";
export { lint } from "@corbits/pr-code-review/actions/lint";
export { candidates, checks, findersInput, review } from "@corbits/pr-code-review/actions/review";
export { report, reviewRequest, stop } from "@corbits/triage-manager/actions/report";

export const reviewInput = reviewInputFor(ANTHROPIC);
