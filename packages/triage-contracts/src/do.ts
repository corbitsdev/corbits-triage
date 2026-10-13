import { type } from "arktype";
import type { LabelsTarget } from "./check-pack.js";

/** The branch of an action a Do is on: the checks' combined verdict, or `always`. */
export const DoBranch = type("'yes' | 'no' | 'unsure' | 'always'");

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
