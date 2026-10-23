// What a changed path is, as triage reads it: tests, the repository's own docs, and generated files.

// Docs under such a folder at any depth are not the repository's own; code is skipped only from root folders and
// node_modules, since a nested `build/` or `vendor/` is usually the repository's own code and must be checked.
const NOT_OWN_DOCS = /(^|\/)(vendor|node_modules|dist|build|generated)\//;
const NOT_OWN_CODE = /^(vendor|dist|build|generated)\/|(^|\/)node_modules\//;
const LEGAL_DOC = /(^|\/)(LICENSE|COPYING|CLA|SECURITY|CODE_OF_CONDUCT)[^/]*$|exception[^/]*$/i;
const GENERATED_PATH = /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/;

const TEST_PATHS: readonly RegExp[] = [
  /(^|\/)(__tests__|tests?|Tests)\//,
  /(^|\/)[^/]+\.\w*Tests?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.(py|rb)$/,
  /_test\.(py|go|rb|exs|dart)$/,
  /(^|\/)spec\/.*\.rb$|_spec\.rb$/,
  /^(?!(.*\/)?src\/main\/).*Tests?\.(java|kt|cs)$/,
  /^(?!(.*\/)?src\/main\/).*(Test|Spec|Suite)\.scala$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATHS.some((pattern) => pattern.test(path));
}

export function isDocPath(path: string): boolean {
  return /\.mdx?$/i.test(path) && !NOT_OWN_DOCS.test(path) && !LEGAL_DOC.test(path);
}

// Contribution rules that apply to every pull request: the root's, then `.github/`'s, then `docs/`'s. An AGENTS.md or
// CLAUDE.md inside a package speaks for that package only, so it is read as an ordinary doc instead.
const CONTRIBUTION_RULES = [
  /^(AGENTS|CLAUDE|CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$/i,
  /^\.github\/(CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$|^\.github\/PULL_REQUEST_TEMPLATE\/[^/]+\.mdx?$/i,
  /^docs\/(CONTRIBUTING|PULL_REQUEST_TEMPLATE)\.mdx?$/i,
];

export function contributionRuleRank(path: string): number | undefined {
  const rank = CONTRIBUTION_RULES.findIndex((pattern) => pattern.test(path));
  return rank === -1 ? undefined : rank;
}

/** Code the repository carries but does not write: vendored, built or generated at its root, or installed anywhere. */
export function isForeignPath(path: string): boolean {
  return NOT_OWN_CODE.test(path);
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH.test(path);
}
