export const TRIAGE_STATES = [
  "needs-decision",
  "awaiting-review",
  "needs-author-update",
  "blocked",
  "ready-monitoring",
  "stale-unknown",
] as const;
export type WorkflowState = (typeof TRIAGE_STATES)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type TrustTier = "external" | "approved" | "internal";

export interface PRRecord {
  id: number;
  repo: string;
  title: string;
  body?: string;
  author: string;
  tier: TrustTier;
  revision: string;
  state: "open" | "closed";
  draft: boolean;
  conflicts: boolean;
  drift: boolean;
  checks: boolean;
  reviewers: boolean;
  duplicate: number;
  spam: number;
  tests: boolean;
  confidence: number;
  lines: number;
  path: string;
}
