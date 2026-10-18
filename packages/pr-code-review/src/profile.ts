import type { TokenUsage } from "@intx/types/runtime";
import { type } from "arktype";

export const Effort = type("'low' | 'medium' | 'high'");
export type Effort = typeof Effort.infer;

/** The review's model steps; each runs on its own model and effort. */
export const ROLES = ["plan", "diffFinder", "repoFinder", "consolidate", "check", "write"] as const;
export type Role = (typeof ROLES)[number];

/** What one provider's code review package sets: the base workflow is the same for every provider. */
export interface CodeReviewProfile {
  /** The package director ids are namespaced by when run from source; a workflow build names its published package instead. */
  packageName: string;
  /** The catalog provider every step's model is declared on. */
  provider: string;
  models: Record<Role, string>;
  /** Each step's effort when the request names none. */
  efforts: Record<Role, Effort>;
  /** The tokens of one reader turn charged to the repository finder's budget. */
  billableTokens(usage: TokenUsage): number;
}
