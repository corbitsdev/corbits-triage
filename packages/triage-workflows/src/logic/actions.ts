import type { Action, ActionKind, CatalogId, CheckPack, Do, LabelsTarget, RepoRole } from "@corbits/triage-contracts";
import type { CheckResult, PrFacts } from "./checks.js";
import { errorText } from "./extract.js";

export type ResolvedTarget =
  | { labels: string[] }
  | { users: string[] }
  | { users: string[]; teams: string[] }
  | { body: string }
  | Record<string, never>
  | { prompt: string; tools: string[] }
  | { unresolved: "codeowners" }
  | { unresolved: "derive"; from: Exclude<LabelsTarget["from"], "list"> };

export type Branch = "yes" | "no" | "unsure" | "always";

type Step = { id: string; branch: Branch; kind: ActionKind; automatic: boolean; reason: string };

/** A step resolves to a target or is skipped; an action whose checks are off in the pack is skipped whole. */
export type SuggestedAction = (Step & { target: ResolvedTarget }) | (Step & { skipped: true }) | { id: string; skipped: true; reason: string };

export interface ActionInput {
  facts: PrFacts;
  /** The rendered checks, so model checks count too. */
  checks: CheckResult[];
  pack: CheckPack;
  roles: Record<string, RepoRole>;
}

const CHECK_NAMES: Record<CatalogId, string> = {
  draft: "Draft",
  size: "Size",
  duplicate: "Duplicate",
  focused: "Focused change",
  docs: "Docs",
  issue: "Linked issue",
  reviewers: "Reviewers",
  conflicts: "Merge conflicts",
  drift: "Base drift",
  ci: "CI",
  tests: "Tests",
  paths: "Forbidden paths",
};

function checkName(id: string, pack: CheckPack): string {
  return CHECK_NAMES[id as CatalogId] ?? pack.custom.find((c) => c.id === id)?.name ?? id;
}

/** GitHub logins, org names, team slugs and label names are case-insensitive. */
function fold(name: string): string {
  return name.toLowerCase();
}

function missingFrom(have: string[] | undefined, wanted: string[]): string[] {
  const held = new Set((have ?? []).map(fold));
  return wanted.filter((name) => !held.has(fold(name)));
}

function joined(names: string[]): string {
  return names.join(", ");
}

/** Catch-up runs every action. */
function wakes(action: Action, facts: PrFacts): boolean {
  return action.when === "every" || facts.event === "catch-up" || (facts.event !== undefined && action.when.includes(facts.event));
}

type Picked = { branch: Branch; dos: Do[]; reason: string } | { skipped: string };

/** An unconfirmed check makes the outcome unsure; a check the pack does not run cannot decide it at all. */
function pick(action: Action, { checks, pack }: ActionInput): Picked {
  if ("always" in action.branches) return { branch: "always", dos: action.branches.always, reason: "Always applies." };
  const results = action.checks.map((id) => ({ name: checkName(id, pack), result: checks.find((c) => c.check === id)?.result }));
  const off = results.filter((r) => r.result === undefined);
  if (off.length) return { skipped: `${joined(off.map((r) => r.name))} ${off.length === 1 ? "is" : "are"} off in this pack.` };
  const failed = results.filter((r) => r.result === "fail").map((r) => r.name);
  const unsure = results.filter((r) => r.result === "unconfirmed").map((r) => r.name);
  if (failed.length) return { branch: "no", dos: action.branches.no ?? [], reason: `${joined(failed)} failed.` };
  if (unsure.length) return { branch: "unsure", dos: action.branches.unsure ?? [], reason: `${joined(unsure)} not confirmed.` };
  return { branch: "yes", dos: action.branches.yes ?? [], reason: `${joined(results.map((r) => r.name))} passed.` };
}

/** GitHub takes team slugs; a team may name `@org/slug`, and only the repository owner's teams can review. */
function teamSlug(team: string, repo: string): string {
  const [org, slug] = team.replace(/^@/, "").split("/", 2);
  if (slug === undefined) return org!;
  const owner = repo.split("/", 1)[0]!;
  if (fold(org!) !== fold(owner)) throw new Error(`team ${team} is not in ${owner}`);
  return slug;
}

type People = { users: string[]; teams: string[] } | { unresolved: "codeowners" };

function people(task: Extract<Do, { kind: "assign" | "request-review" }>, { facts, roles }: ActionInput): People {
  const t = task.target;
  switch (t.to) {
    case "users":
      return { users: t.users, teams: [] };
    case "teams":
      return { users: [], teams: t.teams.map((team) => teamSlug(team, facts.repo)) };
    case "author":
      return { users: [facts.author], teams: [] };
    case "codeowners":
      return { unresolved: "codeowners" };
    case "role": {
      const role = roles[t.role];
      if (!role) throw new Error(`role ${t.role} is not defined in the repository policy`);
      return { users: role.users ?? [], teams: (role.teams ?? []).map((team) => teamSlug(team, facts.repo)) };
    }
  }
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
    case "comment":
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
    // No effect id records a posted comment or agent run yet, so these always stand.
    case "comment":
    case "agent":
      return false;
  }
}

function sentence(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/** Suggest only: nothing here writes to GitHub, and automatic steps are suggested like the rest. */
export function evaluateActions(input: ActionInput): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  for (const action of input.pack.actions) {
    if (!wakes(action, input.facts)) continue;
    const picked = pick(action, input);
    if ("skipped" in picked) {
      out.push({ id: action.id, skipped: true, reason: picked.skipped });
      continue;
    }
    const { branch, dos, reason } = picked;
    for (const task of dos) {
      const base = { id: action.id, branch, kind: task.kind, automatic: task.automatic };
      try {
        const target = resolve(task, input);
        if (!satisfied(task.kind, target, input.facts)) out.push({ ...base, target, reason });
      } catch (e) {
        out.push({ ...base, skipped: true, reason: sentence(errorText(e)) });
      }
    }
  }
  return out;
}
