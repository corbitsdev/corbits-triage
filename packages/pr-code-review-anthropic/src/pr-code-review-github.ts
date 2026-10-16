import { prCodeReview } from "./pr-code-review.js";

export const PR_CODE_REVIEW_GITHUB_ADDRESS = "pr-code-review-github";

export const workflow = prCodeReview({ id: PR_CODE_REVIEW_GITHUB_ADDRESS, sources: ["github"] });
