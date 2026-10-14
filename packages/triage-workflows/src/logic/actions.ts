import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ciRefusal, mergeableCi, missingFrom } from "@corbits/github-reads";
import { alwaysHeld, CATALOG_IDS, checkName, classificationSources, ruleLabel, stepForAuthor, type ActionKind, type CheckPack, type ResolvedTarget, type Step, teamSlug, type VerdictWord, VERDICTS } from "@corbits/triage-contracts";
import type { CheckResult, PrFacts } from "./checks.js";
import { authorFailures } from "./render.js";
import { errorText } from "@corbits/common";
import { unrunnable } from "./execute-do.js";

/**
 * Names one resolved Do on one head: `index` is its place in the verdict's list as the pack defines it, so skipped or satisfied steps before it do not shift it.
 * `kind` and `target` keep a Do inserted earlier by a pack edit from taking a later Do's id on the same head.
 */
export type DoRef = { repo: string; number: number; headSha: string; list: VerdictWord; index: number; kind: ActionKind; target: ResolvedTarget };

/** JSON with object keys sorted, so equal targets hash equally whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** GitHub writes and their audit share it. */
export function doEffectId(ref: DoRef): string {
  const parts = [ref.repo, ref.number, ref.headSha, ref.list, ref.index, ref.kind, canonical(ref.target)];
  return bytesToHex(sha256(utf8ToBytes(parts.join("\x1f"))));
}

type Place = { list: VerdictWord; index: number; kind: ActionKind; reason: string };

/** `held` marks a Do the run does not write unattended: it waits for the approval mail of a person holding its grant. */
export type SuggestedDo = Place & { effectId: string; target: ResolvedTarget; held?: true };

export type SuggestedAction = SuggestedDo | (Place & { skipped: true });

export interface ActionInput {
  facts: PrFacts;
  checks: CheckResult[];
  verdict: VerdictWord;
  reason: string;
  pack: CheckPack;
}

/** Catch-up runs the policy's actions whatever woke it. */
export function wakes(pack: CheckPack, facts: PrFacts): boolean {
  const events = facts.events ?? [];
  return events.includes("catch-up") || events.some((event) => (pack.actions.when as readonly string[]).includes(event));
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
  return { labels: wanted, unlabel: (facts.labels ?? []).filter((label) => owns(label) && !keep.has(label.toLowerCase())) };
}

/**
 * The rule labels a labels step writes, and the only `rule: …` labels it takes back: those of the built-in rules and
 * the policy's own. A repository's other `rule: …` labels are its own. Not a draft and no changes requested say where
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
      const { author, reviewers = [], reviewedBy = [] } = input.facts;
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

/**
 * The Dos of the verdict's list on this head; none when the event does not wake the policy. A step not for this author
 * is skipped, and one that does nothing is not listed. Suggest only: nothing here writes to GitHub.
 */
export function evaluateActions(input: ActionInput): SuggestedAction[] {
  if (!wakes(input.pack, input.facts)) return [];
  const { verdict: list, reason, facts } = input;
  const author = { login: facts.author, kind: facts.authorKind, teams: facts.authorTeams, teamsUnknown: facts.authorTeamsUnknown };
  const out: SuggestedAction[] = [];
  for (const [index, step] of input.pack.actions[list].entries()) {
    if (step.do === "nothing") continue;
    const base = { list, index, kind: step.do };
    const audience = stepForAuthor(step.for, author);
    if (audience.matches !== true) {
      out.push({ ...base, skipped: true, reason: sentence(`not run: ${audience.reason}`) });
      continue;
    }
    try {
      const target = resolve(step, input);
      const effectId = doEffectId({ repo: facts.repo, number: facts.number, headSha: facts.headSha, list, index, kind: step.do, target });
      if (!satisfied(step.do, target, facts)) out.push({ ...base, effectId, target, reason });
    } catch (e) {
      out.push({ ...base, skipped: true, reason: sentence(errorText(e)) });
    }
  }
  return out;
}

/**
 * Why an approval cannot stand on this head, if it cannot: it says the pull request may merge, so the verdict must pass
 * and CI must have finished green. A head without CI cannot be told apart from one whose CI has not started yet, so it is not approved either.
 */
export function approvalHeldBy(verdict: VerdictWord, ci: PrFacts["checks"]): string | undefined {
  if (verdict !== "pass") return "The pull request does not pass its policy.";
  if (ci !== "success") return "CI has not passed on this head.";
  return undefined;
}

function lists(pack: CheckPack, kind: ActionKind): boolean {
  return VERDICTS.some((list) => pack.actions[list].some((step) => step.do === kind));
}

/** The approvals its approve Dos made are its own to take back. */
export function packApproves(pack: CheckPack): boolean {
  return lists(pack, "approve");
}

/**
 * Whether anything failed is still the author's to fix in a pack that requests changes; once nothing is, or the pack no
 * longer requests changes, the App's standing requests are taken back. Undefined when there is nothing to take back or decide.
 */
export function changesWanted(input: Pick<ActionInput, "checks" | "pack" | "facts">): boolean | undefined {
  if (!lists(input.pack, "request-changes")) return input.facts.triageRequested === true ? false : undefined;
  return changesFor(input).length > 0;
}

/** An approve that may not stand is skipped before the CI hold, so running checks never turn it into a held approval. */
export function heldApprovals(actions: SuggestedAction[], approval: string | undefined, ci: PrFacts["checks"]): SuggestedAction[] {
  return actions.map(function held(action): SuggestedAction {
    if (!("effectId" in action)) return action;
    if (action.kind === "approve" && approval !== undefined) return { list: action.list, index: action.index, kind: action.kind, skipped: true, reason: approval };
    if (ci === "pending" || (action.kind === "merge" && !mergeableCi(ci, "ciOptional" in action.target))) return { ...action, held: true, reason: `${ciRefusal(ci)}.` };
    return action;
  });
}

/** `automatic` is the kinds the pr-triage role is granted on the repository; the run may not write the rest unattended. */
export function holdDos(actions: SuggestedAction[], automatic: readonly ActionKind[]): SuggestedAction[] {
  return actions.map(function hold(action): SuggestedAction {
    if (!("effectId" in action) || unrunnable(action) !== undefined) return action;
    if (automatic.includes(action.kind) && !alwaysHeld(action.list, action.kind)) return action;
    return { ...action, held: true };
  });
}
