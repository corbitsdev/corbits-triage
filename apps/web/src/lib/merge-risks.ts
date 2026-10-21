import { alwaysHeld, AUTHOR_GROUPS, catalogCheckEnabled, EVERYONE, VERDICTS, type ActionKind, type AuthorGroup, type AuthorKind, type AuthorMatch, type CheckPack, type Step } from "@corbits/triage-contracts";
import { globMatch } from "@corbits/triage-contracts/glob";

const LANDING: readonly ActionKind[] = ["approve", "merge"];
const FIRST_TIMERS: readonly AuthorKind[] = AUTHOR_GROUPS["first-timers"];
// Stands for any workflow file a pull request could change.
const CI_CONFIG = ".github/workflows/ci.yml";

export type MergeRisk = "first-timers" | "ci-config";

function admitsFirstTimers(pack: CheckPack, match: AuthorMatch): boolean {
  if (typeof match === "string") return FIRST_TIMERS.includes(match);
  if (!("group" in match)) return false;
  if (match.group === EVERYONE) return true;
  const own = pack.groups?.[match.group];
  if (own) return own.association?.some((kind) => FIRST_TIMERS.includes(kind)) ?? false;
  return Object.hasOwn(AUTHOR_GROUPS, match.group) && AUTHOR_GROUPS[match.group as AuthorGroup].some((kind) => FIRST_TIMERS.includes(kind));
}

/** Only a rule that fails the pull request stops it; one that asks or labels lets an approval through. */
function stopsCiConfig(pack: CheckPack): boolean {
  const rule = pack.checks["no-forbidden-paths"];
  if (!rule || !catalogCheckEnabled(pack, "no-forbidden-paths") || rule.onFail) return false;
  return (rule.forbiddenGlobs ?? []).some((glob) => globMatch(CI_CONFIG, glob));
}

/**
 * Undefined unless Triage approves or merges on its own; then what the policy lets through unchecked. A `decide` rule's
 * authors are not read here, so only steps name first-time contributors.
 */
export function mergeRisks(pack: CheckPack, automatic: readonly ActionKind[], decide: readonly ActionKind[]): MergeRisk[] | undefined {
  function isAutomatic(kind: ActionKind): boolean {
    return LANDING.includes(kind) && automatic.includes(kind);
  }
  const steps = VERDICTS.flatMap((verdict) => pack.actions[verdict].filter((step): step is Step & { do: ActionKind } => step.do !== "nothing" && isAutomatic(step.do) && !alwaysHeld(verdict, step.do)));
  if (steps.length === 0 && !decide.some(isAutomatic)) return undefined;
  const risks: MergeRisk[] = [];
  if (steps.some((step) => !step.when?.author || step.when.author.some((match) => admitsFirstTimers(pack, match)))) risks.push("first-timers");
  if (!stopsCiConfig(pack)) risks.push("ci-config");
  return risks;
}
