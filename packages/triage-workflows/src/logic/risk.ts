import { PATTERN_EXTENSIONS, RISK_LEVELS, type RiskLevel, type RiskLevels, type RiskMark, type RiskSignal, type RiskThreshold, type SensitiveGroup } from "@corbits/triage-contracts";
import { isDocPath, isForeignPath, isGeneratedPath, isTestPath } from "@corbits/triage-contracts/paths";
import { globMatch } from "./glob.js";

// Only the subject's type counts: branch commits like "fix lint" or a body mentioning a fix would make every busy file hot.
const FIX_SUBJECT = /^(?:(?:fix|bugfix|hotfix|revert)(?:\([^()]*\))?!?:|revert\b|hotfix\b)/i;

/** A commit whose subject is a conventional fix, bugfix, hotfix or revert; merges are not. */
export function isFix(message: string): boolean {
  return FIX_SUBJECT.test(message.split("\n", 1)[0]!.trim());
}

/** The changed paths whose history is read: tests, docs and lockfiles churn without regressing anything. */
export function historyPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !isTestPath(path) && !isDocPath(path) && !isGeneratedPath(path));
}

export function fixCount(messages: readonly string[]): number {
  return messages.filter(isFix).length;
}

const HOT_SHOWN = 3;

/** The hottest paths with at least `threshold` fixes, as `path: n recent fixes`, then how many more there are. */
export function hotFiles(fixes: ReadonlyMap<string, number>, threshold: number): string[] {
  const hot = [...fixes].filter(([, n]) => n >= threshold).sort((a, b) => b[1] - a[1]);
  const shown = hot.slice(0, HOT_SHOWN).map(([path, n]) => `${path}: ${n} recent fixes`);
  return hot.length > HOT_SHOWN ? [...shown, `and ${hot.length - HOT_SHOWN} more`] : shown;
}

/** The paths matching any of the globs. */
export function matchingPaths(paths: readonly string[], globs: readonly string[]): string[] {
  return paths.filter((path) => globs.some((glob) => globMatch(path, glob)));
}

export type SensitiveHit = { name: string; level: RiskMark; paths: string[] };

/** Each group with a changed path matching any of its globs, and those paths. */
export function sensitiveHits(paths: readonly string[], groups: Readonly<Record<string, SensitiveGroup>>): SensitiveHit[] {
  return Object.entries(groups).flatMap(function hits([name, group]): SensitiveHit[] {
    const matched = matchingPaths(paths, group.paths);
    return matched.length ? [{ name, level: group.level, paths: matched }] : [];
  });
}

/** The highest level among the groups changed, or low with none. */
export function sensitiveLevel(hits: readonly SensitiveHit[]): RiskLevel {
  if (hits.some((hit) => hit.level === "high")) return "high";
  return hits.length ? "medium" : "low";
}

const SOURCE_EXTENSIONS = new Set<string>([...PATTERN_EXTENSIONS, "go", "py", "rs", "java", "kt", "rb", "php", "cs", "swift"]);
// Browser and snapshot tests sit outside the unit-test layouts every other rule reads.
const MORE_TESTS = /(^|\/)(e2e|cypress|__snapshots__)\/|\.cy\.[^/]+$/;

function isRiskTest(path: string): boolean {
  return isTestPath(path) || MORE_TESTS.test(path);
}

// Type declarations, docs and examples are written in a code language without being the code a change ships.
const NOT_SOURCE = /\.d\.[cm]?ts$|(^|\/)(docs|examples)\//;

/** Code the repository writes in a common language; config, data, docs and assets are not source. */
function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1)) && !NOT_SOURCE.test(path) && !isRiskTest(path) && !isForeignPath(path);
}

/** Source files changed without a test file changing. */
export function untested(paths: readonly string[]): boolean {
  return paths.some(isSource) && !paths.some(isRiskTest);
}

function reaches(threshold: RiskThreshold, signals: ReadonlySet<RiskSignal>): boolean {
  if (typeof threshold === "number") return signals.size >= threshold;
  return threshold.some((entry) => (typeof entry === "string" ? signals.has(entry) : entry.every((signal) => signals.has(signal))));
}

/** A change to a high sensitive group is high whatever the other signals. */
export function riskLevel(signals: ReadonlySet<RiskSignal>, levels: RiskLevels, sensitive: RiskLevel): RiskLevel {
  if (sensitive === "high" || reaches(levels.high, signals)) return "high";
  return reaches(levels.medium, signals) ? "medium" : "low";
}

/** Whether a level fails the rule, or else labels the pull request; a `labelAt` at or above `failAt` never labels. */
export function riskOutcome(level: RiskLevel, { failAt, labelAt }: Pick<RiskLevels, "failAt" | "labelAt">): "fail" | "label" | "pass" {
  const rank = RISK_LEVELS.indexOf(level);
  if (rank >= RISK_LEVELS.indexOf(failAt)) return "fail";
  return rank >= RISK_LEVELS.indexOf(labelAt) ? "label" : "pass";
}
