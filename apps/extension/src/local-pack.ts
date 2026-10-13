import { recommendedPack, type CheckPack } from "@corbits/triage-contracts";

export const SOURCE_GLOBS = ["**.ts", "**.tsx", "**.js", "**.jsx", "**.mjs", "**.py", "**.go", "**.rs", "**.java", "**.kt", "**.rb", "**.php", "**.cs", "**.swift", "**.c", "**.cc", "**.cpp"];
export const TEST_GLOBS = ["**.test.*", "**.spec.*", "**_test.*", "**/test/**", "**/tests/**", "**/__tests__/**", "test/**", "tests/**", "__tests__/**"];
export const DEBUG_LEFTOVERS = String.raw`\bdebugger\b|\b(?:it|describe|test)\.only\(|\bconsole\.log\(|\bbreakpoint\(\)`;

/** The checks local mode runs before anyone changes them: what GitHub data alone can prove, plus the model checks a key answers. */
export function defaultLocalPack(repo: string): CheckPack {
  const base = recommendedPack(repo);
  return {
    ...base,
    checks: {
      ...base.checks,
      docs: { enabled: false },
      paths: { ...base.checks.paths, enabled: false },
    },
    custom: [
      { id: "custom-1", name: "Tests changed with code", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: SOURCE_GLOBS, requires: TEST_GLOBS },
      { id: "custom-2", name: "No debug leftovers", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: DEBUG_LEFTOVERS },
    ],
    actions: [
      {
        id: "ask-for-tests",
        when: "every",
        checks: ["custom-1"],
        branches: { no: [{ kind: "comment", target: { body: "Thanks for the change. Could you add or update tests that cover it?" } }] },
      },
      {
        id: "suggest-split",
        when: "every",
        checks: ["size"],
        branches: { no: [{ kind: "comment", target: { body: "This is a lot to review in one pass. Could you split it into smaller pull requests?" } }] },
      },
      {
        id: "needs-author-update",
        when: "every",
        checks: ["ci", "custom-1", "custom-2"],
        branches: { no: [{ kind: "labels", target: { from: "list", labels: ["triage:needs-author-update"] } }] },
      },
    ],
  };
}
