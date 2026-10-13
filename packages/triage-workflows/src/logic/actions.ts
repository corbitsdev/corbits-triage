import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { missingFrom } from "@corbits/github-reads";
import { alwaysHeld, checkName, classificationSources, type ActionKind, type CheckPack, type Do, type RepoRole, type ResolvedTarget, teamSlug, type VerdictWord, VERDICTS } from "@corbits/triage-contracts";
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

/** The idempotency key for one Do on one head; GitHub writes and their audit share it. */
export function doEffectId(ref: DoRef): string {
  const parts = [ref.repo, ref.number, ref.headSha, ref.list, ref.index, ref.kind, canonical(ref.target)];
  return bytesToHex(sha256(utf8ToBytes(parts.join("\x1f"))));
}

type Step = { list: VerdictWord; index: number; kind: ActionKind; reason: string };

/** `held` marks a Do the run does not write unattended: it waits for the approval mail of a person holding its grant. */
export type SuggestedDo = Step & { effectId: string; target: ResolvedTarget; held?: true };

/** A step resolves to a target or is skipped. */
export type SuggestedAction = SuggestedDo | (Step & { skipped: true });

export interface ActionInput {
  facts: PrFacts;
  /** The rendered checks, so judged rules count too. */
  checks: CheckResult[];
  verdict: VerdictWord;
  /** Why the verdict is what it is, recorded on each Do. */
  reason: string;
  pack: CheckPack;
  roles: Record<string, RepoRole>;
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

function people(task: Extract<Do, { kind: "assign" | "request-review" }>, { facts, roles }: ActionInput): People {
  const t = task.target;
  switch (t.to) {
    case "users":
      return { users: t.users, teams: [] };
    case "teams":
      return { users: [], teams: t.teams.map((team) => ownTeam(team, facts.repo)) };
    case "author":
      return { users: [facts.author], teams: [] };
    case "codeowners":
      return { unresolved: "codeowners" };
    case "role": {
      const role = roles[t.role];
      if (!role) throw new Error(`role ${t.role} is not defined in the repository settings`);
      return { users: role.users ?? [], teams: (role.teams ?? []).map((team) => ownTeam(team, facts.repo)) };
    }
  }
}

/** The failed checks that are the author's to fix. */
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

function resolve(task: Do, input: ActionInput): ResolvedTarget {
  switch (task.kind) {
    case "labels":
      return task.target.from === "list" ? { labels: task.target.labels } : { unresolved: "derive", from: task.target.from };
    case "assign": {
      const resolved = people(task, input);
      if ("unresolved" in resolved) return resolved;
      if (!resolved.users.length) throw new Error("assignees must be users and this target names none");
      return { users: resolved.users };
    }
    case "request-review": {
      const resolved = people(task, input);
      if ("unresolved" in resolved) return resolved;
      const { author, reviewers = [], reviewedBy = [] } = input.facts;
      const users = missingFrom([author], resolved.users);
      if (!users.length && !resolved.teams.length) throw new Error("no reviewer is left once the author is excluded");
      return { users: missingFrom([...reviewers, ...reviewedBy], users), teams: missingFrom(reviewers, resolved.teams) };
    }
    case "request-changes":
      return { body: changesBody(input) };
    case "comment":
    case "approve":
    case "close":
    case "agent":
      return task.target;
  }
}

/** Already true on the pull request, so suggesting it again would be noise. */
function satisfied(kind: ActionKind, target: ResolvedTarget, facts: PrFacts): boolean {
  if ("unresolved" in target) return false;
  switch (kind) {
    case "labels":
      return "labels" in target && missingFrom(facts.labels, target.labels).length === 0;
    case "assign":
      return "users" in target && missingFrom(facts.assignees, target.users).length === 0;
    // Resolution already dropped everyone requested or reviewed on this head.
    case "request-review":
      return "teams" in target && target.users.length === 0 && target.teams.length === 0;
    case "close":
      return facts.state === "closed";
    // No effect id records a posted comment or agent run yet, so these always stand; facts do not say which head the App's review is on.
    case "comment":
    case "approve":
    case "request-changes":
    case "agent":
      return false;
  }
}

function sentence(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/** The Dos of the verdict's list on this head; none when the event does not wake the policy. Suggest only: nothing here writes to GitHub. */
export function evaluateActions(input: ActionInput): SuggestedAction[] {
  if (!wakes(input.pack, input.facts)) return [];
  const { verdict: list, reason, facts } = input;
  const out: SuggestedAction[] = [];
  for (const [index, task] of input.pack.actions[list].entries()) {
    const base = { list, index, kind: task.kind };
    try {
      const target = resolve(task, input);
      const effectId = doEffectId({ repo: facts.repo, number: facts.number, headSha: facts.headSha, list, index, kind: task.kind, target });
      if (!satisfied(task.kind, target, facts)) out.push({ ...base, effectId, target, reason });
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
  return VERDICTS.some((list) => pack.actions[list].some((step) => step.kind === kind));
}

/** The pack approves pull requests, so the approvals its approve Dos made are its own to take back. */
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

/** Approve Dos are skipped for `reason`, when the head may not be approved. */
export function heldApprovals(actions: SuggestedAction[], reason: string | undefined): SuggestedAction[] {
  if (reason === undefined) return actions;
  return actions.map(function held(action): SuggestedAction {
    if (!("effectId" in action) || action.kind !== "approve") return action;
    const { list, index, kind } = action;
    return { list, index, kind, skipped: true, reason };
  });
}

/** Holds each runnable Do the run may not write unattended: `automatic` is the kinds the pr-triage role is granted on the repository. */
export function holdDos(actions: SuggestedAction[], automatic: readonly ActionKind[]): SuggestedAction[] {
  return actions.map(function hold(action): SuggestedAction {
    if (!("effectId" in action) || unrunnable(action) !== undefined) return action;
    if (automatic.includes(action.kind) && !alwaysHeld(action.list, action.kind)) return action;
    return { ...action, held: true };
  });
}
