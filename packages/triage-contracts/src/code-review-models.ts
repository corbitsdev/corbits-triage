/**
 * The code review providers, each a package of its own (`@corbits/pr-code-review-<provider>`): the vault credential
 * that holds its key and the catalog models its steps name. A workspace runs the one whose key it stores.
 * Anthropic runs Opus for the diff finder, which found most of the bugs in the eval, and Haiku for every other step.
 */
export const CODE_REVIEW_PROVIDERS = {
  anthropic: { credential: "anthropic", models: { diffFinder: "claude-opus-5-5", other: "claude-haiku-5-5" } },
} as const;

export type CodeReviewProvider = keyof typeof CODE_REVIEW_PROVIDERS;

/** The workspace's code review provider, from the names of its active credentials; undefined while it stores no provider's key. */
export function codeReviewProviderOf(credentials: readonly string[]): CodeReviewProvider | undefined {
  return (Object.keys(CODE_REVIEW_PROVIDERS) as CodeReviewProvider[]).find((provider) => credentials.includes(CODE_REVIEW_PROVIDERS[provider].credential));
}
