// What a changed path is, as triage reads it: tests, the repository's own docs, and generated files.

const FOREIGN_PATH = /(^|\/)(vendor|node_modules|dist|build)\//;
const LEGAL_DOC = /(^|\/)(LICENSE|COPYING|CLA|SECURITY|CODE_OF_CONDUCT)[^/]*$|exception[^/]*$/i;
const GENERATED_PATH = /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/;

export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** The repository's own prose: markdown outside vendored or built trees, except legal notices. */
export function isDocPath(path: string): boolean {
  return /\.mdx?$/i.test(path) && !FOREIGN_PATH.test(path) && !LEGAL_DOC.test(path);
}

// Contribution rules that apply to every pull request: the root's, then `.github/`'s, then `docs/`'s. An AGENTS.md or
// CLAUDE.md inside a package speaks for that package only, so it is read as an ordinary doc instead.
const CONTRIBUTION_RULES = [
  /^(AGENTS|CLAUDE|CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$/i,
  /^\.github\/(CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$|^\.github\/PULL_REQUEST_TEMPLATE\/[^/]+\.mdx?$/i,
  /^docs\/(CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$/i,
];

/** Where a contribution rule file comes in reading order (lower first), or undefined for any other path. */
export function contributionRuleRank(path: string): number | undefined {
  const rank = CONTRIBUTION_RULES.findIndex((pattern) => pattern.test(path));
  return rank === -1 ? undefined : rank;
}

export function isContributionRulePath(path: string): boolean {
  return contributionRuleRank(path) !== undefined;
}

/** Lockfiles, which say nothing a reviewer judges. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH.test(path);
}
