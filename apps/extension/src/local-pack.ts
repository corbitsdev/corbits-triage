import { defaultActions, recommendedPack, type CheckPack } from "@corbits/triage-contracts";

export const SOURCE_GLOBS = ["**.ts", "**.tsx", "**.js", "**.jsx", "**.mjs", "**.py", "**.go", "**.rs", "**.java", "**.kt", "**.rb", "**.php", "**.cs", "**.swift", "**.c", "**.cc", "**.cpp"];
export const TEST_GLOBS = ["**.test.*", "**.spec.*", "**_test.*", "**/test/**", "**/tests/**", "**/__tests__/**", "test/**", "tests/**", "__tests__/**"];
export const DEBUG_LEFTOVERS = String.raw`\bdebugger\b|\b(?:it|describe|test)\.only\(|\bconsole\.log\(|\bbreakpoint\(\)`;

/** The rules local mode runs before anyone changes them: what GitHub data alone can prove, plus the model checks a key answers. */
export function defaultLocalPack(repo: string): CheckPack {
  const base = recommendedPack(repo);
  return {
    ...base,
    checks: {
      ...base.checks,
      docs: { enabled: false },
      "no-forbidden-paths": { ...base.checks["no-forbidden-paths"], enabled: false },
    },
    custom: [
      { id: "tests-changed-with-code", name: "Tests changed with code", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: SOURCE_GLOBS, requires: TEST_GLOBS },
      { id: "no-debug-leftovers", name: "No debug leftovers", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: DEBUG_LEFTOVERS },
    ],
    actions: { ...defaultActions(), fail: [{ kind: "labels", target: { from: "list", labels: ["triage:needs-author-update"] } }] },
  };
}
