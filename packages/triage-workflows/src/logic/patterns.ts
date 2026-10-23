import { parse } from "@ast-grep/napi";
import { PATTERN_PRESETS, type PatternLanguage, type PatternRule, type PatternsCheck } from "@corbits/triage-contracts";
import type { PrFileFacts } from "./checks.js";
import { addedLines, MAX_PATCH_INPUT_CHARS } from "./hunks.js";

type Grammar = { language: PatternLanguage; lang: "TypeScript" | "Tsx" | "JavaScript" };

const TYPESCRIPT: Grammar = { language: "typescript", lang: "TypeScript" };
const JAVASCRIPT: Grammar = { language: "javascript", lang: "JavaScript" };
const GRAMMARS: Record<string, Grammar> = {
  ts: TYPESCRIPT,
  mts: TYPESCRIPT,
  cts: TYPESCRIPT,
  tsx: { language: "typescript", lang: "Tsx" },
  js: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  jsx: JAVASCRIPT,
};

export type PatternsResult = { matches: string[] } | { unread: string };

function presetRules(id: string): readonly PatternRule[] {
  const rules = PATTERN_PRESETS[id];
  if (!rules) throw new Error(`no preset ${id}`);
  return rules;
}

/** The presets' rules, then the rule's own, which win on a shared id. */
export function patternRules(check: PatternsCheck): PatternRule[] {
  const all = [...check.presets.flatMap(presetRules), ...check.patterns];
  return [...new Map(all.map((rule) => [rule.id, rule])).values()];
}

function grammarOf(path: string): Grammar | undefined {
  return GRAMMARS[path.slice(path.lastIndexOf(".") + 1)];
}

function fileMatches(file: PrFileFacts, patch: string, content: string, grammar: Grammar, rules: PatternRule[]): string[] {
  const added = addedLines(patch);
  const root = parse(grammar.lang, content).root();
  const out = new Set<string>();
  for (const rule of rules.filter((candidate) => candidate.language === grammar.language)) {
    for (const match of root.findAll({ rule: rule.rule })) {
      const { start, end } = match.range();
      for (let line = start.line + 1; line <= end.line + 1; line++) {
        if (!added.has(line)) continue;
        out.add(`${file.path}:${line} ${rule.message}`);
        break;
      }
    }
  }
  return [...out];
}

/** Matches on the lines a pull request adds; a file in scope whose patch or content was not read leaves the rule unchecked. */
export function patternsResult(check: PatternsCheck, files: readonly PrFileFacts[], contents: Readonly<Record<string, string>> | undefined): PatternsResult {
  const matches: string[] = [];
  try {
    const rules = patternRules(check);
    for (const file of files) {
      const grammar = grammarOf(file.path);
      if (!grammar || file.status === "removed" || file.additions === 0) continue;
      const content = contents?.[file.path];
      if (file.patch === undefined || file.patchTruncated || file.patch.length > MAX_PATCH_INPUT_CHARS) return { unread: `${file.path}: its patch was not read in full` };
      if (content === undefined) return { unread: `${file.path}: its content was not read` };
      matches.push(...fileMatches(file, file.patch, content, grammar, rules));
    }
  } catch (error) {
    return { unread: error instanceof Error ? error.message : String(error) };
  }
  return { matches };
}
