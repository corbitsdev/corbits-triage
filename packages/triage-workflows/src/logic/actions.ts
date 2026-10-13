import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { missingFrom } from "@corbits/github-reads";
import { ALL_CHECKS, alwaysHeld, checkName, classificationSources, type Action, type ActionKind, type CheckPack, type Do, type RepoRole, type ResolvedTarget, teamSlug } from "@corbits/triage-contracts";
import type { CheckResult, PrFacts } from "./checks.js";
import { authorFailures, type MergeVerdict } from "./render.js";
import { errorText } from "@corbits/common";
import { unrunnable } from "./execute-do.js";

export type Branch = "yes" | "no" | "unsure" | "always";

/**
 * Names one resolved Do on one head: `index` is its place in the branch's Do list as the pack defines it, so skipped or satisfied steps before it do not shift it.
 * `kind` and `target` keep a Do inserted earlier by a pack edit from taking a later Do's id on the same head.
 */
export type DoRef = { repo: string; number: number; headSha: string; actionId: string; branch: Branch; index: number; kind: ActionKind; target: ResolvedTarget };

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
  const parts = [ref.repo, ref.number, ref.headSha, ref.actionId, ref.branch, ref.index, ref.kind, canonical(ref.target)];
  return bytesToHex(sha256(utf8ToBytes(parts.join("\x1f"))));
}

type Step = { id: string; branch: Branch; index: number; kind: ActionKind; reason: string };

/** `held` marks a Do the run does not write unattended: it waits for the approval mail of a person holding its grant. */
export type SuggestedDo = Step & { effectId: string; target: ResolvedTarget; held?: true };

/** A step resolves to a target or is skipped; an action whose checks are off in the pack is skipped whole. */
export type SuggestedAction = SuggestedDo | (Step & { skipped: true }) | { id: string; skipped: true; reason: string };

export interface ActionInput {
  facts: PrFacts;
  /** The rendered checks, so model checks count too. */
  checks: CheckResult[];
  pack: CheckPack;
  roles: Record<string, RepoRole>;
}

function joined(names: string[]): string {
  return names.join(", ");
}

/** Catch-up runs every action. */
function wakes({ when }: Action, facts: PrFacts): boolean {
  const events = facts.events ?? [];
  return when === "every" || events.includes("catch-up") || events.some((event) => when.includes(event));
}

type Picked = { branch: Branch; dos: Do[]; reason: string } | { skipped: string };

/** An unconfirmed check makes the outcome unsure; a check the pack does not run cannot decide it at all. */
function pick(action: Action, { checks, pack }: ActionInput): Picked {
  if ("always" in action.branches) return { branch: "always", dos: action.branches.always, reason: "Always applies." };
  const every = action.checks.includes(ALL_CHECKS);
  if (every && !checks.length) return { skipped: "Every check is off in this pack." };
  const ids = every ? checks.map((c) => c.check) : action.checks;
  const results = ids.map((id) => ({ name: checkName(pack, id), result: checks.find((c) => c.check === id)?.result }));
  const off = results.filter((r) => r.result === undefined);
  if (off.length) return { skipped: `${joined(off.map((r) => r.name))} ${off.length === 1 ? "is" : "are"} off in this pack.` };
  const failed = results.filter((r) => r.result === "fail").map((r) => r.name);
  const unsure = results.filter((r) => r.result === "unconfirmed").map((r) => r.name);
  if (failed.length) return { branch: "no", dos: action.branches.no ?? [], reason: `${joined(failed)} failed.` };
  if (unsure.length) return { branch: "unsure", dos: action.branches.unsure ?? [], reason: `${joined(unsure)} not confirmed.` };
  return { branch: "yes", dos: action.branches.yes ?? [], reason: `${joined(results.map((r) => r.name))} passed.` };
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
      if (!role) throw new Error(`role ${t.role} is not defined in the repository policy`);
      return { users: role.users ?? [], teams: (role.teams ?? []).map((team) => ownTeam(team, facts.repo)) };
    }
  }
}

/** The failed checks among the action's own that are the author's to fix. */
function changesFor(action: Action, { checks, pack }: ActionInput): CheckResult[] {
  const own = action.checks.includes(ALL_CHECKS) ? checks : checks.filter((c) => (action.checks as string[]).includes(c.check));
  return authorFailures(own, classificationSources(pack));
}

/** Only what the author must fix is requested; anything else waits on a maintainer, not on the author. */
function changesBody(action: Action, input: ActionInput): string {
  const { pack } = input;
  const failed = changesFor(action, input);
  if (!failed.length) throw new Error("nothing that failed is the author's to fix");
  return ["Triage requests changes:", ...failed.map((c) => `- ${checkName(pack, c.check)}: ${c.reason}`)].join("\n");
}

function resolve(task: Do, action: Action, input: ActionInput): ResolvedTarget {
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
      return { body: changesBody(action, input) };
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

export type ActionOutcome = { skipped: string } | { branch: Branch; reason: string; dos: SuggestedAction[] };

/** One action's branch and Dos on this head, or why it is skipped whole; undefined when the event does not wake it. */
export function evaluateAction(action: Action, input: ActionInput): ActionOutcome | undefined {
  if (!wakes(action, input.facts)) return undefined;
  const picked = pick(action, input);
  if ("skipped" in picked) return picked;
  const { branch, dos, reason } = picked;
  const out: SuggestedAction[] = [];
  for (const [index, task] of dos.entries()) {
    const base = { id: action.id, branch, index, kind: task.kind };
    try {
      const target = resolve(task, action, input);
      const { repo, number, headSha } = input.facts;
      const effectId = doEffectId({ repo, number, headSha, actionId: action.id, branch, index, kind: task.kind, target });
      if (!satisfied(task.kind, target, input.facts)) out.push({ ...base, effectId, target, reason });
    } catch (e) {
      out.push({ ...base, skipped: true, reason: sentence(errorText(e)) });
    }
  }
  return { branch, reason, dos: out };
}

/**
 * Why an approval cannot stand on this head, if it cannot: it says the pull request may merge, so the verdict must be ready to merge and CI
 * must have finished green. A head without CI cannot be told apart from one whose CI has not started yet, so it is not approved either.
 */
export function approvalHeldBy(merge: MergeVerdict["verdict"], ci: PrFacts["checks"]): string | undefined {
  if (merge !== "ready") return "The pull request is not ready to merge.";
  if (ci !== "success") return "CI has not passed on this head.";
  return undefined;
}

/** The pack approves pull requests, so the approvals its approve Dos made are its own to take back. */
export function packApproves(pack: CheckPack): boolean {
  return pack.actions.some((action) => Object.values(action.branches).some((dos: Do[]) => dos.some((step) => step.kind === "approve")));
}

function requestsChanges(action: Action): boolean {
  return Object.values(action.branches).some((dos: Do[]) => dos.some((step) => step.kind === "request-changes"));
}

/**
 * Whether any request-changes action still has something of its own checks for the author to fix; once none has, or the pack no longer
 * requests changes, the App's standing requests are taken back. Undefined when there is nothing to take back or decide.
 */
export function changesWanted(input: ActionInput): boolean | undefined {
  const requesting = input.pack.actions.filter(requestsChanges);
  if (!requesting.length) return input.facts.triageRequested === true ? false : undefined;
  return requesting.some((action) => changesFor(action, input).length > 0);
}

/** Approve Dos are skipped for `reason`, when the head may not be approved. */
export function heldApprovals(actions: SuggestedAction[], reason: string | undefined): SuggestedAction[] {
  if (reason === undefined) return actions;
  return actions.map(function held(action): SuggestedAction {
    if (!("effectId" in action) || action.kind !== "approve") return action;
    const { id, branch, index, kind } = action;
    return { id, branch, index, kind, skipped: true, reason };
  });
}

/** Holds each runnable Do the run may not write unattended: `automatic` is the kinds the pr-triage role is granted on the repository. */
export function holdDos(actions: SuggestedAction[], automatic: readonly ActionKind[]): SuggestedAction[] {
  return actions.map(function hold(action): SuggestedAction {
    if (!("effectId" in action) || unrunnable(action) !== undefined) return action;
    if (automatic.includes(action.kind) && !alwaysHeld(action.branch, action.kind)) return action;
    return { ...action, held: true };
  });
}

/** Suggest only: nothing here writes to GitHub. */
export function evaluateActions(input: ActionInput): SuggestedAction[] {
  return input.pack.actions.flatMap(function suggested(action): SuggestedAction[] {
    const outcome = evaluateAction(action, input);
    if (outcome === undefined) return [];
    if ("skipped" in outcome) return [{ id: action.id, skipped: true, reason: outcome.skipped }];
    return outcome.dos;
  });
}
