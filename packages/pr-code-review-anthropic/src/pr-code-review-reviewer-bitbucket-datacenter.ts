import { codeReviewReviewer } from "@corbits/pr-code-review/pr-code-review";
import { agents } from "./agents.js";

export const PR_CODE_REVIEW_REVIEWER_BITBUCKET_DATACENTER_ADDRESS = "pr-code-review-reviewer-bitbucket-datacenter";

export const workflow = codeReviewReviewer(agents)({ id: PR_CODE_REVIEW_REVIEWER_BITBUCKET_DATACENTER_ADDRESS, sources: ["bitbucket-datacenter"] });
