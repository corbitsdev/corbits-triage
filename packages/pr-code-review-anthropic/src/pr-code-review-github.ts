import { PR_CODE_REVIEW_GITHUB_ADDRESS } from "@corbits/pr-code-review/pr-code-review";
import { prCodeReview } from "./pr-code-review.js";

export const workflow = prCodeReview({ id: PR_CODE_REVIEW_GITHUB_ADDRESS, sources: ["github"] });
