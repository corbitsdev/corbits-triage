export const PATTERN_LANGUAGES = ["typescript", "javascript"] as const;
export type PatternLanguage = (typeof PATTERN_LANGUAGES)[number];

/** An ast-grep rule: `rule` is its rule object, as an ast-grep config's `rule:` key holds it. */
export interface PatternRule {
  id: string;
  language: PatternLanguage;
  message: string;
  rule: Record<string, unknown>;
}

function typescript(id: string, message: string, rule: Record<string, unknown>): PatternRule {
  return { id, language: "typescript", message, rule };
}

const CONVENTION: PatternRule[] = [
  typescript("zero-fallback", "Invented fallback `?? 0`; handle the missing value instead.", { pattern: "$X ?? 0" }),
  typescript("empty-list-fallback", "Invented fallback `?? []`; handle the missing value instead.", { pattern: "$X ?? []" }),
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
