// A repository's policy as triage reads it, so the portal shows and edits the same artifact the hub mails.
import { type } from "arktype";
import { ACTION_KINDS, alwaysHeld, AUTHOR_GROUPS, authorGroupsOf, catalogCheckEnabled, kindsOf, VERDICTS, whenHolds, type ActionKind, type AuthorKind, type CheckPack, type DecideRule, type MergeRisk, type RepoSource, type StepWhen, type VerdictWord } from "@corbits/triage-contracts";
import { globMatch } from "@corbits/triage-workflows/logic/glob";
import type { PolicyReader } from "./check-pack-store.js";
import type { Member } from "../integrations/app.js";

export const PolicyQuery = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

const LANDING: readonly ActionKind[] = ["approve", "merge"];
const FIRST_TIMERS: readonly AuthorKind[] = AUTHOR_GROUPS["first-timers"];
/** A rule that stops either spelling of a workflow file is taken to guard CI workflows. */
const WORKFLOW_FILES = [".github/workflows/x.yml", ".github/workflows/x.yaml"];

/** An approve or merge Triage runs on its own: the verdicts it fires on, and the conditions that must all hold. */
type Landing = { verdicts: VerdictWord[]; whens: StepWhen[] };

function isActionKind(kind: string): kind is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(kind);
}

function landing(kind: string, verdicts: readonly VerdictWord[], whens: StepWhen[], automatic: readonly ActionKind[]): Landing[] {
  if (!isActionKind(kind) || !LANDING.includes(kind) || !automatic.includes(kind)) return [];
  const fires = verdicts.filter((verdict) => !alwaysHeld(verdict, kind));
  return fires.length ? [{ verdicts: fires, whens }] : [];
}

function decideLandings(rule: DecideRule, automatic: readonly ActionKind[]): Landing[] {
  const triage = rule.if.triage;
  const verdicts = triage === undefined ? VERDICTS : [triage].flat();
  const whens: StepWhen[] = rule.if.author ? [{ author: rule.if.author.map((group) => ({ group })) }] : [];
  const steps = Array.isArray(rule.do) ? rule.do : [rule.do];
  return steps.flatMap(function stepLandings(step) {
    if (typeof step === "string") return landing(step, verdicts, whens, automatic);
    // Reading the policy has already turned each step's authors into kinds and groups.
    const when = "when" in step ? (step.when as StepWhen | undefined) : undefined;
    return landing(step.do, verdicts, when ? [...whens, when] : whens, automatic);
  });
}

function admitsFirstTimers(pack: CheckPack, whens: readonly StepWhen[]): boolean {
  return FIRST_TIMERS.some(function admits(kind) {
    const author = { login: "", kind, teams: [] };
    const subject = { author: { ...author, groups: authorGroupsOf(pack.groups ?? {}, author) }, linkedIssue: false, ci: "none" as const, files: 0, lines: 0 };
    return whens.every((when) => whenHolds(when.author && { author: when.author }, subject).matches !== false);
  });
}

/** Only the forbidden paths rule reads a workflow file's path; a rule that labels leaves the verdict as it was. */
function verdictOn(pack: CheckPack, path: string): VerdictWord {
  const rule = pack.checks["no-forbidden-paths"];
  if (!rule || !catalogCheckEnabled(pack, "no-forbidden-paths") || !(rule.forbiddenGlobs ?? []).some((glob) => globMatch(path, glob))) return "pass";
  if (rule.onFail === "ask") return "unsure";
  return rule.onFail === "label" ? "pass" : "fail";
}

/** What Triage's automatic approve or merge can let in, reckoned for GitHub repositories only. */
function mergeRisks(pack: CheckPack, decide: readonly DecideRule[], automatic: readonly ActionKind[], source: RepoSource): MergeRisk[] {
  if (source !== "github") return [];
  const steps = VERDICTS.flatMap((verdict) => pack.actions[verdict].flatMap((step) => landing(step.do, [verdict], step.when ? [step.when] : [], automatic)));
  const landings = [...steps, ...decide.flatMap((rule) => decideLandings(rule, automatic))];
  const risks: MergeRisk[] = [];
  if (landings.some((each) => admitsFirstTimers(pack, each.whens))) risks.push("first-timers");
  if (WORKFLOW_FILES.every((path) => landings.some((each) => each.verdicts.includes(verdictOn(pack, path))))) risks.push("ci-config");
  return risks;
}

export function createGithubPolicyRead(deps: { readCheckPack: PolicyReader; repoSource: (tenantId: string, repo: string) => Promise<RepoSource> }) {
  return async function handle({ repo }: typeof PolicyQuery.infer, { tenantId }: Member): Promise<Response> {
    const read = await deps.readCheckPack(tenantId, repo, "github");
    if (read.status !== "ok") return Response.json(read);
    const rules = read.policyWorkflow?.decide ?? [];
    const decide = rules.flatMap((rule) => kindsOf(rule.do)).filter(isActionKind);
    const risks = mergeRisks(read.pack, rules, read.automatic, await deps.repoSource(tenantId, repo));
    return Response.json({ status: "ok", pack: read.pack, source: read.source, automatic: read.automatic, decide: [...new Set(decide)], mergeRisks: risks });
  };
}
