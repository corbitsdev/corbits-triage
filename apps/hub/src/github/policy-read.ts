// A repository's policy as triage reads it, so the portal shows and edits the same artifact the hub mails.
import { type } from "arktype";
import { ACTION_KINDS, alwaysHeld, AUTHOR_GROUPS, authorGroupsOf, catalogCheckEnabled, kindsOf, REPO_SOURCES, ruleVerdicts, VERDICTS, whenHolds, type ActionKind, type AuthorKind, type CheckPack, type DecideRule, type MergeRisk, type StepWhen, type VerdictWord } from "@corbits/triage-contracts";
import { globMatch } from "@corbits/triage-workflows/logic/glob";
import type { PolicyReader } from "./check-pack-store.js";
import type { Member } from "../integrations/app.js";

export const PolicyQuery = type({ repo: /^[\w.-]+\/[\w.-]+$/, "source?": type.enumerated(...REPO_SOURCES) });

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
  const verdicts = ruleVerdicts(rule);
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

/** The verdicts a change to the file can reach: other rules can still fail it or leave it unsure, and a rule that labels leaves the verdict as it was. */
function verdictsOn(pack: CheckPack, path: string): readonly VerdictWord[] {
  const rule = pack.checks["no-forbidden-paths"];
  if (!rule || !catalogCheckEnabled(pack, "no-forbidden-paths") || rule.onFail === "label" || !(rule.forbiddenGlobs ?? []).some((glob) => globMatch(path, glob))) return VERDICTS;
  return rule.onFail === "ask" ? ["unsure", "fail"] : ["fail"];
}

/** What Triage's automatic approve or merge can let in. */
function mergeRisks(pack: CheckPack, decide: readonly DecideRule[], automatic: readonly ActionKind[]): MergeRisk[] {
  const steps = VERDICTS.flatMap((verdict) => pack.actions[verdict].flatMap((step) => landing(step.do, [verdict], step.when ? [step.when] : [], automatic)));
  const landings = [...steps, ...decide.flatMap((rule) => decideLandings(rule, automatic))];
  const risks: MergeRisk[] = [];
  if (landings.some((each) => admitsFirstTimers(pack, each.whens))) risks.push("first-timers");
  if (WORKFLOW_FILES.some((path) => landings.some((each) => verdictsOn(pack, path).some((verdict) => each.verdicts.includes(verdict))))) risks.push("ci-config");
  return risks;
}

export function createGithubPolicyRead(deps: { readCheckPack: PolicyReader }) {
  return async function handle({ repo, source }: typeof PolicyQuery.infer, { tenantId }: Member): Promise<Response> {
    const read = await deps.readCheckPack(tenantId, repo, source ?? "github");
    if (read.status === "missing") return Response.json(read);
    if (read.status !== "ok") {
      const { automatic: _automatic, ...unreadable } = read;
      return Response.json(unreadable);
    }
    const rules = read.policyWorkflow?.decide ?? [];
    const decide = rules.flatMap((rule) => kindsOf(rule.do)).filter(isActionKind);
    const risks = mergeRisks(read.pack, rules, read.automatic);
    return Response.json({ status: "ok", pack: read.pack, source: read.source, automatic: read.automatic, decide: [...new Set(decide)], mergeRisks: risks });
  };
}
