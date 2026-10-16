import { type } from "arktype";
import { ACTION_KINDS, VERDICTS, type ActionKind, type VerdictWord } from "./check-pack.js";
import type { RepoSource } from "./repo-source.js";

export const DoList = type.enumerated(...VERDICTS);

/**
 * The system role whose grants say what the pr-triage deployment does on its own: a deployment's run principal changes
 * with every redeploy, and stock refuses to rename or delete a system role.
 */
export const TRIAGE_ROLE = "pr-triage";

export const DO_GRANT_ACTION = "invoke";
export const DO_GRANT_PREFIX = "triage-do";

export const ANY_DO_RESOURCE = `${DO_GRANT_PREFIX}:*`;

/** Holding `invoke` on it lets a person approve a held Do of `kind` in `repo`, and the pr-triage role run it unattended. */
export function doResource(kind: ActionKind, repo: string): string {
  return `${DO_GRANT_PREFIX}:${kind}:${repo.toLowerCase()}`;
}

/** Bitbucket Data Center has no labels or assignees. */
const HOSTLESS_KINDS: Record<RepoSource, readonly ActionKind[]> = { github: [], "bitbucket-datacenter": ["labels", "assign"] };

/** The action kinds the host can write. */
export function hostKinds(source: RepoSource): ActionKind[] {
  return ACTION_KINDS.filter((kind) => !HOSTLESS_KINDS[source].includes(kind));
}

/** Closing on an unsure verdict, and merging on anything but a pass, always waits for a person. */
export function alwaysHeld(list: VerdictWord, kind: ActionKind): boolean {
  return (list === "unsure" && kind === "close") || (list !== "pass" && kind === "merge");
}

/** `unlabel` names labels the step owns that are on the pull request and no longer apply, which it removes; `ciOptional` lets a merge go ahead on a head with no CI. */
export type ResolvedTarget =
  | { labels: string[]; unlabel?: string[] }
  | { users: string[] }
  | { users: string[]; teams: string[] }
  | { body: string }
  | Record<string, never>
  | { ciOptional: true }
  | { unresolved: "codeowners" };

/** Agent Dos and labels derived from the type or paths were removed; verdicts recorded before may still hold one. */
export const AGENT_DO = "agent Dos no longer run";
export const DERIVED_LABELS_DO = "labels derived from the pull request's type or paths no longer run";
