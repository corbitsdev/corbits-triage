import picomatch from "picomatch";

export const PATTERN_LANGUAGES = ["typescript", "javascript"] as const;
export type PatternLanguage = (typeof PATTERN_LANGUAGES)[number];

/** An ast-grep rule: `rule`, `files` and `ignores` are as an ast-grep rule config holds them, globs as strings only. */
export interface PatternRule {
  id: string;
  language: PatternLanguage;
  message: string;
  rule: Record<string, unknown>;
  files?: string[];
  ignores?: string[];
}

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

// ast-grep's globs: `*` crosses `/`, dotfiles are not special and a leading `!` is literal.
const GLOB_OPTIONS = { bash: true, dot: true, strictBrackets: true, nonegate: true };

/** Throws when ast-grep would refuse the glob. */
export function compileGlob(glob: string): RegExp {
  // The matcher reads `[!a]` as `!` or `a`, the opposite of ast-grep.
  if (glob.includes("[!")) throw new Error("write a negated class as [^…], not [!…]");
  return picomatch.makeRe(glob, GLOB_OPTIONS);
}

function named(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => compileGlob(glob).test(path));
}

/** ast-grep's rule scoping: a path one of `files` names, when given, and none of `ignores` names. */
export function patternRuleApplies(rule: PatternRule, path: string): boolean {
  return (rule.files === undefined || named(path, rule.files)) && (rule.ignores === undefined || !named(path, rule.ignores));
}

function typescript(id: string, message: string, rule: Record<string, unknown>, scope: Pick<PatternRule, "files" | "ignores"> = {}): PatternRule {
  return { id, language: "typescript", message, rule, ...scope };
}

const CONVENTION: PatternRule[] = [
  // A counter's `?? 0` is a real default, so one inside arithmetic is left alone.
  typescript("zero-fallback", "Invented fallback `?? 0`; handle the missing value instead.", {
    pattern: "$X ?? 0",
    not: {
      any: [
        { inside: { kind: "binary_expression", has: { field: "operator", regex: "^[-+*/%]$" }, stopBy: "end" } },
        { inside: { kind: "augmented_assignment_expression", stopBy: "end" } },
      ],
    },
  }, { ignores: TEST_FILES }),
  typescript("empty-list-fallback", "Invented fallback `?? []`; handle the missing value instead.", { pattern: "$X ?? []" }, { ignores: TEST_FILES }),
  typescript("nested-ternary", "Nested ternary; use if statements or a lookup.", {
    kind: "ternary_expression",
    any: [
      { has: { field: "condition", kind: "ternary_expression" } },
      { has: { field: "consequence", kind: "ternary_expression" } },
      { has: { field: "alternative", kind: "ternary_expression" } },
      { has: { kind: "parenthesized_expression", has: { kind: "ternary_expression" } } },
    ],
  }),
  typescript("iife", "Immediately invoked function; name the function.", {
    kind: "call_expression",
    has: { field: "function", kind: "parenthesized_expression", has: { any: [{ kind: "arrow_function" }, { kind: "function_expression" }] } },
  }),
  typescript("promise-chain", "Promise chain; use async/await with try/catch.", {
    kind: "call_expression",
    has: { field: "function", kind: "member_expression", has: { field: "property", regex: "^(then|catch|finally)$" } },
  }),
  typescript("empty-catch", "Empty catch swallows the error.", { kind: "catch_clause", has: { field: "body", regex: "^\\{\\s*\\}$" } }),
  typescript("suppression-comment", "Lint or type suppression comment.", { kind: "comment", regex: "@ts-(ignore|expect-error|nocheck)|(eslint|oxlint)-disable" }),
];

/** Shipped rule sets a policy turns on by id. */
export const PATTERN_PRESETS: Readonly<Record<string, readonly PatternRule[]>> = { convention: CONVENTION };
