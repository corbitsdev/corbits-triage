import { type } from "arktype";
import type { ActionKind, LabelsTarget } from "./check-pack.js";

/** The branch of an action a Do is on: the checks' combined verdict, or `always`. */
export const DoBranch = type("'yes' | 'no' | 'unsure' | 'always'");

/**
 * The system role whose grants say what the pr-triage deployment does on its own: a deployment's run principal changes
 * with every redeploy, and stock refuses to rename or delete a system role.
 */
export const TRIAGE_ROLE = "pr-triage";

export const DO_GRANT_ACTION = "invoke";
export const DO_GRANT_PREFIX = "triage-do";

/** Every Do kind on every repository. */
export const ANY_DO_RESOURCE = `${DO_GRANT_PREFIX}:*`;

/** Holding `invoke` on it lets a person approve a held Do of `kind` in `repo`, and the pr-triage role run it unattended. */
export function doResource(kind: ActionKind, repo: string): string {
  return `${DO_GRANT_PREFIX}:${kind}:${repo.toLowerCase()}`;
}

/** Closing on an unsure verdict, and closing or running an agent from an action without checks, always waits for a person. */
export function alwaysHeld(branch: typeof DoBranch.infer, kind: ActionKind): boolean {
  if (branch === "unsure") return kind === "close";
  return branch === "always" && (kind === "close" || kind === "agent");
}

export type ResolvedTarget =
  | { labels: string[] }
  | { users: string[] }
  | { users: string[]; teams: string[] }
  | { body: string }
  | Record<string, never>
  | { prompt: string; tools: string[] }
  | { unresolved: "codeowners" }
  | { unresolved: "derive"; from: Exclude<LabelsTarget["from"], "list"> };

export const AGENT_DO = "agent Dos cannot run yet";
export const DERIVED_LABELS_DO = "labels derived from the pull request cannot run yet";
