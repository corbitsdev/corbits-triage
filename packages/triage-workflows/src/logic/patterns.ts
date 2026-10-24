import { parse } from "@ast-grep/napi";
import { isForeignPath, PATTERN_PRESETS, patternRuleApplies, type PatternLanguage, type PatternRule, type PatternsCheck } from "@corbits/triage-contracts";
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

export type PatternsResult = { matches: string[]; skipped: string[]; checked: number } | { unread: string };

function presetRules(id: string): readonly PatternRule[] {
  const rules = PATTERN_PRESETS[id];
  if (!rules) throw new Error(`no preset ${id}`);
  return rules;
}

/** The presets' rules, then the rule's own, which replace a preset rule of the same id in every language. */
export function patternRules(check: PatternsCheck): PatternRule[] {
  const own = new Set(check.patterns.map((rule) => rule.id));
  return [...check.presets.flatMap(presetRules).filter((rule) => !own.has(rule.id)), ...check.patterns];
}

function grammarOf(path: string): Grammar | undefined {
  return GRAMMARS[path.slice(path.lastIndexOf(".") + 1)];
}

function checkable(file: PrFileFacts): boolean {
  return grammarOf(file.path) !== undefined && file.status !== "removed";
}

/** A changed TypeScript or JavaScript file the repository writes itself. */
function inScope(file: PrFileFacts): boolean {
  return checkable(file) && !isForeignPath(file.path);
}

function wholePatch(file: PrFileFacts): string | undefined {
  return file.patch === undefined || file.patchTruncated || file.patch.length > MAX_PATCH_INPUT_CHARS ? undefined : file.patch;
}

/** The files one pull request reads the content of, GitHub's own diff limit, so one pull request's reads stay bounded. */
export const MAX_CONTENT_READS = 300;

/** The files whose content the rules need, or why they cannot be checked: a file in scope without its whole patch, or more files than are read. */
export function filesToRead(files: readonly PrFileFacts[]): string[] | { unread: string } {
  const scoped = files.filter(inScope);
  const unpatched = scoped.find((file) => wholePatch(file) === undefined);
  if (unpatched) return { unread: `${unpatched.path}: its patch was not read in full` };
  const toRead = scoped.filter((file) => addedLines(wholePatch(file)!).size > 0).map((file) => file.path);
  if (toRead.length > MAX_CONTENT_READS) return { unread: `${toRead.length} files with added code, more than the ${MAX_CONTENT_READS} read per pull request` };
  return toRead;
}

function fileMatches(file: PrFileFacts, patch: string, content: string, grammar: Grammar, rules: PatternRule[]): string[] {
  const added = addedLines(patch);
  const root = parse(grammar.lang, content).root();
  const out = new Set<string>();
  for (const rule of rules.filter((candidate) => candidate.language === grammar.language && patternRuleApplies(candidate, file.path))) {
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
export function patternsResult(check: PatternsCheck, files: readonly PrFileFacts[], contents: Readonly<Record<string, string>>): PatternsResult {
  const toRead = filesToRead(files);
  if (!Array.isArray(toRead)) return toRead;
  const matches: string[] = [];
  try {
    const rules = patternRules(check);
    for (const file of files.filter((candidate) => toRead.includes(candidate.path))) {
      const content = contents[file.path];
      if (content === undefined) return { unread: `${file.path}: its content was not read` };
      matches.push(...fileMatches(file, file.patch!, content, grammarOf(file.path)!, rules));
    }
  } catch (error) {
    return { unread: error instanceof Error ? error.message : String(error) };
  }
  const skipped = files
    .filter((file) => checkable(file) && isForeignPath(file.path))
    .map((file) => `${file.path}: skipped as vendored, built or installed code`);
  return { matches, skipped, checked: files.filter(inScope).length };
}
