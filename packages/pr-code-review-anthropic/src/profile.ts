import type { CodeReviewProfile } from "@corbits/pr-code-review/profile";
import { CODE_REVIEW_PROVIDERS } from "@corbits/triage-contracts";

const { smart, fast } = CODE_REVIEW_PROVIDERS.anthropic.models;

export const ANTHROPIC: CodeReviewProfile = {
  packageName: "@corbits/pr-code-review-anthropic",
  provider: "anthropic",
  models: { plan: fast, diffFinder: smart, repoFinder: fast, consolidate: fast, check: fast, write: fast },
  efforts: { plan: "medium", diffFinder: "medium", repoFinder: "medium", consolidate: "medium", check: "medium", write: "low" },
  // Cache reads re-count the whole prompt on every turn, so only new tokens are billed against the budget.
  billableTokens(usage) {
    return usage.input + usage.output + usage.cacheWrite;
  },
};
