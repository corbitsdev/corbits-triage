import { codeReviewReviewer } from "@corbits/pr-code-review/pr-code-review";
import { agents } from "./agents.js";

export const PR_CODE_REVIEW_REVIEWER_GITHUB_ADDRESS = "pr-code-review-reviewer-github";

export const workflow = codeReviewReviewer(agents)({ id: PR_CODE_REVIEW_REVIEWER_GITHUB_ADDRESS, sources: ["github"] });
