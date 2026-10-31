import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ciRefusal, mergeableCi, missingFrom } from "@corbits/github-reads";
import { alwaysHeld, authorGroupsOf, CATALOG_IDS, catalogCheckEnabled, checkName, classificationSources, labelRules, LEVEL_LABELS, levelLabel, RISK_MARKS, ruleLabel, whenHolds, type ActionKind, type CheckPack, type RepoSource, type ResolvedTarget, type CiState, type Step, type StepSubject, teamSlug, type TriageEvent, type VerdictWord, VERDICTS } from "@corbits/triage-contracts";
import { issueReference, type CheckResult, type PrFacts } from "./checks.js";
import { authorFailures, isLabelledFinding } from "./render.js";
import { compare, errorText } from "@corbits/common";
import { unrunnable } from "./execute-do.js";

/**
 * Names one resolved Do on one head: `index` is its place in the verdict's list as the pack defines it, so skipped or satisfied steps before it do not shift it.
 * `kind` and `target` keep a Do inserted earlier by a pack edit from taking a later Do's id on the same head.
 * `source`, when it is not GitHub, keeps a Do on another host from sharing this id; absent and GitHub keep the id already written.
 */
export type DoRef = { repo: string; number: number; headSha: string; list: VerdictWord; index: number; kind: ActionKind; target: ResolvedTarget; source?: RepoSource };

/** JSON with object keys sorted, so equal targets hash equally whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** GitHub writes and their audit share it. A host other than GitHub is part of the hash; GitHub, named or not, is not, so ids already written stay. */
export function doEffectId(ref: DoRef): string {
  const host = ref.source !== undefined && ref.source !== "github" ? [ref.source] : [];
  const parts = [...host, ref.repo, ref.number, ref.headSha, ref.list, ref.index, ref.kind, canonical(ref.target)];
  return bytesToHex(sha256(utf8ToBytes(parts.join("\x1f"))));
}

/** `ci` is the head's CI state that alone holds or skips the Do; a Do held for a person, or one the run cannot write, carries none. */
type Place = { list: VerdictWord; index: number; kind: ActionKind; reason: string; ci?: Exclude<PrFacts["checks"], "success"> };

/** `held` marks a Do the run does not write unattended: it waits for the approval mail of a person holding its grant. */
export type SuggestedDo = Place & { effectId: string; target: ResolvedTarget; held?: true };

/** `waits` marks a step skipped until the pull request allows it, which the comment names. */
export type SuggestedAction = SuggestedDo | (Place & { skipped: true; waits?: true });

export interface ActionInput {
  facts: PrFacts;
  checks: CheckResult[];
  verdict: VerdictWord;
  reason: string;
  pack: CheckPack;
  /** Each labelling rule's result, and each rule that did not fail but still labels, where the host has labels. */
  labelled?: CheckResult[];
  /** Where the pull request lives. Absent on GitHub, so a GitHub Do keeps the effect id already written. */
  repoSource?: RepoSource;
}

/** Catch-up runs the policy's actions whatever woke it. */
export function wakes(pack: CheckPack, facts: PrFacts): boolean {
  return facts.events.includes("catch-up") || facts.events.some((event) => (pack.actions.when as readonly string[]).includes(event));
}

/** Events that clear a hold Triage adds itself, and the kind of step each releases whatever the policy's `on:` lists. */
const RELEASES: ReadonlyArray<[TriageEvent, ActionKind]> = [["threads", "merge"]];

function releasedKinds(facts: PrFacts): ActionKind[] {
  return RELEASES.filter(([event]) => facts.events.includes(event)).map(([, kind]) => kind);
}

/** GitHub takes team slugs, and only the repository owner's teams can review. */
function ownTeam(team: string, repo: string): string {
  const slug = teamSlug(team, repo);
  if (slug === null) throw new Error(`team ${team} is not in ${repo.split("/", 1)[0]}`);
  return slug;
}

type People = { users: string[]; teams: string[] } | { unresolved: "codeowners" };

function people(step: Extract<Step, { do: "assign" | "request-review" }>, { facts }: ActionInput): People {
  const t = step.target;
  switch (t.to) {
    case "users":
      return { users: t.users, teams: [] };
    case "teams":
      return { users: [], teams: t.teams.map((team) => ownTeam(team, facts.repo)) };
    case "author":
      return { users: [facts.author], teams: [] };
    case "codeowners":
      return { unresolved: "codeowners" };
  }
}

function changesFor({ checks, pack }: Pick<ActionInput, "checks" | "pack">): CheckResult[] {
  return authorFailures(checks, classificationSources(pack));
}

/** Only what the author must fix is requested; anything else waits on a maintainer, not on the author. */
function changesBody(input: ActionInput): string {
  const { pack } = input;
  const failed = changesFor(input);
  if (!failed.length) throw new Error("nothing that failed is the author's to fix");
  return ["Triage requests changes:", ...failed.map((c) => `- ${checkName(pack, c.check)}: ${c.reason}`)].join("\n");
}

/** The labels a derived step wants, and the ones it owns on the pull request that no longer apply. */
function derivedLabels(wanted: string[], owns: (label: string) => boolean, facts: PrFacts): ResolvedTarget {
  const keep = new Set(wanted.map((label) => label.toLowerCase()));
  return { labels: wanted, unlabel: facts.labels.filter((label) => owns(label) && !keep.has(label.toLowerCase())) };
}

/**
 * The rule labels a labels step writes, and the only `rule: …` labels it takes back: those of the built-in rules and
 * the policy's own. A repository's other `rule: …` labels are its own. Draft and Requested changes say where
 * the pull request stands, not what to fix, so they get none.
 */
function ruleLabels({ checks, pack, facts }: ActionInput): ResolvedTarget {
  const ids = new Set<string>([...CATALOG_IDS, ...pack.custom.map((row) => row.id)]);
  const owned = new Set([...ids].map((id) => ruleLabel(id).toLowerCase()));
  const wanted = checks.filter((c) => c.result === "fail" && ids.has(c.check)).map((c) => ruleLabel(c.check));
  return derivedLabels(wanted, (label) => owned.has(label.toLowerCase()), facts);
}

function resolve(step: Exclude<Step, { do: "nothing" }>, input: ActionInput): ResolvedTarget {
  switch (step.do) {
    case "labels": {
      const { target } = step;
      if (target.from === "list") return { labels: target.labels };
      return ruleLabels(input);
    }
    case "assign": {
      const resolved = people(step, input);
      if ("unresolved" in resolved) return resolved;
      if (!resolved.users.length) throw new Error("assignees must be users and this target names none");
      return { users: resolved.users };
    }
    case "request-review": {
      const resolved = people(step, input);
      if ("unresolved" in resolved) return resolved;
      const { author, reviewers, reviewedBy } = input.facts;
      const users = missingFrom([author], resolved.users);
      if (!users.length && !resolved.teams.length) throw new Error("no reviewer is left once the author is excluded");
      return { users: missingFrom([...reviewers, ...reviewedBy], users), teams: missingFrom(reviewers, resolved.teams) };
    }
    case "request-changes":
      return { body: changesBody(input) };
    case "comment":
      return step.target;
    case "merge":
      // Only a policy that switched CI green off may merge a head with no CI; one that never names CI still requires it.
      return input.pack.checks["ci-green"]?.enabled === false ? { ciOptional: true } : {};
    case "approve":
    case "close":
      return {};
  }
}

/** Suggesting it again would be noise. */
function satisfied(kind: ActionKind, target: ResolvedTarget, facts: PrFacts): boolean {
  if ("unresolved" in target) return false;
  switch (kind) {
    case "labels":
      return "labels" in target && missingFrom(facts.labels, target.labels).length === 0 && !target.unlabel?.length;
    case "assign":
      return "users" in target && missingFrom(facts.assignees, target.users).length === 0;
    // Resolution already dropped everyone requested or reviewed on this head.
    case "request-review":
      return "teams" in target && target.users.length === 0 && target.teams.length === 0;
    case "close":
    case "merge":
      return facts.state === "closed";
    // No effect id records a posted comment yet, so it always stands; facts do not say which head the App's review is on.
    case "comment":
    case "approve":
    case "request-changes":
      return false;
  }
}

function sentence(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

// Cancelled CI waits on a re-run, so a step reads it as not finished.
const CI: Record<PrFacts["checks"], CiState> = { success: "passing", failure: "failing", pending: "pending", cancelled: "pending", none: "none" };

/** A linked issue is one from either tracker, whatever the linked issue rule asks for. */
function stepSubject(facts: PrFacts, pack: CheckPack): StepSubject {
  const author = { login: facts.author, kind: facts.authorKind, teams: facts.authorTeams, teamsUnknown: facts.authorTeamsUnknown };
  return {
    author: { ...author, groups: authorGroupsOf(pack.groups ?? {}, author) },
    linkedIssue: issueReference(facts, "either") !== null,
    ci: CI[facts.checks],
    files: facts.changedFiles,
    lines: facts.additions + facts.deletions,
  };
}

/** The label a result adds: its own, or else its labelling rule's when that rule did not pass. */
function addedLabels(c: CheckResult, labels: ReadonlyMap<string, string>): string[] {
  if (c.label !== undefined) return [c.label];
  const label = labels.get(c.check);
  return label !== undefined && isLabelledFinding(c) ? [label] : [];
}

/** The level labels of the switched-on sensitive-paths and risk rules, which only Triage adds. */
function levelLabels(pack: CheckPack): Set<string> {
  const ids = (Object.keys(LEVEL_LABELS) as Array<keyof typeof LEVEL_LABELS>).filter((id) => catalogCheckEnabled(pack, id));
  return new Set(ids.flatMap((id) => RISK_MARKS.map((level) => levelLabel(id, level).toLowerCase())));
}

/** The labels the policy names for the labelling rules that passed on this head. */
function passedLabels(labelled: CheckResult[], labels: ReadonlyMap<string, string>): string[] {
  return labelled.filter((c) => c.result === "pass" && labels.has(c.check)).map((c) => labels.get(c.check)!.toLowerCase());
}

/** The labels the policy's labels steps name on any list, whether or not they run. */
function stepLabels(pack: CheckPack): Set<string> {
  const steps = VERDICTS.flatMap((list) => pack.actions[list]);
  return new Set(steps.flatMap((step) => (step.do === "labels" && step.target.from === "list" ? step.target.labels : [])).map((label) => label.toLowerCase()));
}

/**
 * After the verdict's own steps, one labels Do adds the label of each labelling rule that did not pass, and each label a
 * rule that did not fail still adds. Nothing says who put a label on, so only labels the policy names are taken back:
 * a labelling rule's once it passes, unless a labels step of the policy names it, and a level label of sensitive paths
 * or risk that no longer applies.
 */
function labelDo({ labelled, pack, facts, verdict: list, repoSource }: ActionInput, reason: string): SuggestedAction[] {
  if (labelled === undefined) return [];
  const labels = labelRules(pack);
  const named = stepLabels(pack);
  const owned = new Set([...levelLabels(pack), ...passedLabels(labelled, labels).filter((label) => !named.has(label))]);
  const target = derivedLabels([...new Set(labelled.flatMap((c) => addedLabels(c, labels)))], (label) => owned.has(label.toLowerCase()), facts);
  if (satisfied("labels", target, facts)) return [];
  const index = pack.actions[list].length;
  const effectId = doEffectId({ repo: facts.repo, number: facts.number, headSha: facts.headSha, list, index, kind: "labels", target, ...(repoSource !== undefined && { source: repoSource }) });
  return [{ list, index, kind: "labels", effectId, target, reason }];
}

/**
 * The Dos of `steps` on this head; none when the event does not wake the policy, and only the kinds it releases when
 * it only clears a hold Triage added. A step whose conditions do not hold, or cannot be told, is skipped, and one that
 * does nothing is not listed. Suggest only: nothing here writes to GitHub.
 */
export function stepActions(input: ActionInput, steps: readonly Step[]): SuggestedAction[] {
  const woken = wakes(input.pack, input.facts);
  const released = releasedKinds(input.facts);
  if (!woken && released.length === 0) return [];
  const { verdict: list, reason, facts, repoSource } = input;
  const subject = stepSubject(facts, input.pack);
  const out: SuggestedAction[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.do === "nothing" || (!woken && !released.includes(step.do))) continue;
    const base = { list, index, kind: step.do };
    const holds = whenHolds(step.when, subject);
    if (holds.matches !== true) {
      out.push({ ...base, skipped: true, reason: sentence(`not run: ${holds.reason}`) });
      continue;
    }
    try {
      const target = resolve(step, input);
      const effectId = doEffectId({ repo: facts.repo, number: facts.number, headSha: facts.headSha, list, index, kind: step.do, target, ...(repoSource !== undefined && { source: repoSource }) });
      if (!satisfied(step.do, target, facts)) out.push({ ...base, effectId, target, reason });
    } catch (e) {
      out.push({ ...base, skipped: true, reason: sentence(errorText(e)) });
    }
  }
  return woken ? [...out, ...labelDo(input, reason)] : out;
}

/** The Dos of the verdict's list on this head. */
export function evaluateActions(input: ActionInput): SuggestedAction[] {
  return stepActions(input, input.pack.actions[input.verdict]);
}

/** Why an approval cannot stand on this head. */
export type ApprovalHold = Pick<Place, "reason" | "ci">;

/**
 * Why an approval cannot stand on this head, if it cannot: it says the pull request may merge, so the verdict must pass
 * and CI must have finished green. A head without CI cannot be told apart from one whose CI has not started yet, so it is not approved either.
 */
export function approvalHeldBy(verdict: VerdictWord, ci: PrFacts["checks"]): ApprovalHold | undefined {
  if (verdict !== "pass") return { reason: "The pull request does not pass its policy." };
  if (ci !== "success") return { reason: "CI has not passed on this head.", ci };
  return undefined;
}

function lists(pack: CheckPack, kind: ActionKind): boolean {
  return VERDICTS.some((list) => pack.actions[list].some((step) => step.do === kind));
}

/** The approvals its approve Dos made are its own to take back. */
export function packApproves(pack: CheckPack): boolean {
  return lists(pack, "approve");
}

/** Only a policy that merges reads the review threads that hold a merge. */
export function packMerges(pack: CheckPack): boolean {
  return lists(pack, "merge");
}

/**
 * Whether anything failed is still the author's to fix in a pack that requests changes; once nothing is, or the pack no
 * longer requests changes, the App's standing requests are taken back. Undefined when there is nothing to take back or decide.
 */
export function changesWanted(input: Pick<ActionInput, "checks" | "pack" | "facts">): boolean | undefined {
  if (!lists(input.pack, "request-changes")) return input.facts.triageRequested ? false : undefined;
  return changesFor(input).length > 0;
}

/**
 * An approve that may not stand is skipped before the CI hold, so running checks never turn it into a held approval. A
 * merge the review threads hold is skipped before it too, rather than held, so no person can approve it past them and
 * a later pass writes it under the same effect id once they allow it.
 */
export function heldApprovals(actions: SuggestedAction[], approval: ApprovalHold | undefined, { checks: ci, mergeHold }: Pick<PrFacts, "checks" | "mergeHold">): SuggestedAction[] {
  return actions.map(function held(action): SuggestedAction {
    if (!("effectId" in action)) return action;
    if (action.kind === "approve" && approval !== undefined) return { list: action.list, index: action.index, kind: action.kind, skipped: true, ...approval };
    if (action.kind === "merge" && mergeHold !== undefined) return { list: action.list, index: action.index, kind: action.kind, skipped: true, waits: true, reason: mergeHold };
    if (ci === "pending") return { ...action, held: true, reason: `${ciRefusal(ci)}.`, ci };
    if (ci !== "success" && action.kind === "merge" && !mergeableCi(ci, "ciOptional" in action.target)) return { ...action, held: true, reason: `${ciRefusal(ci)}.`, ci };
    return action;
  });
}

/**
 * `automatic` is the kinds the pr-triage role is granted on the repository; the run may not write the rest unattended.
 * `ci` stays only on a Do the run would write on its own once CI allows it; one it cannot run, or held for a person, loses it.
 */
export function holdDos(actions: SuggestedAction[], automatic: readonly ActionKind[]): SuggestedAction[] {
  return actions.map(function hold(action): SuggestedAction {
    if (!("effectId" in action)) return action;
    const { ci: _ci, ...waiting } = action;
    if (unrunnable(action) !== undefined) return waiting;
    if (automatic.includes(action.kind) && !alwaysHeld(action.list, action.kind)) return action;
    return { ...waiting, held: true };
  });
}
