import type { CodeReviewProfile } from "@corbits/pr-code-review/profile";
import { CODE_REVIEW_PROVIDERS } from "@corbits/triage-contracts";

const { smart } = CODE_REVIEW_PROVIDERS.anthropic.models;

export const ANTHROPIC: CodeReviewProfile = {
  packageName: "@corbits/pr-code-review-anthropic",
  provider: "anthropic",
  models: { diffFinder: smart, check: smart },
  efforts: { diffFinder: "medium", check: "medium" },
  // Cache reads re-count the whole prompt on every turn, so only new tokens are billed against the budget.
  billableTokens(usage) {
    return usage.input + usage.output + usage.cacheWrite;
  },
};
