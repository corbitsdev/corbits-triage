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

/** Lockfiles, which say nothing a reviewer judges. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH.test(path);
}
