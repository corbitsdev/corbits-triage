import { prCodeReview } from "./pr-code-review.js";

export const PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS = "pr-code-review-bitbucket-datacenter";

export const workflow = prCodeReview({ id: PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS, sources: ["bitbucket-datacenter"] });
