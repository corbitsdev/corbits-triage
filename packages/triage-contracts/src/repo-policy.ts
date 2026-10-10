import { type } from "arktype";
import type { TrustTier } from "./types.js";

export const CLEANUP_MODES = ["human-approved", "automated"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

export const AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
  "MANNEQUIN",
] as const;
export type AuthorAssociation = (typeof AUTHOR_ASSOCIATIONS)[number];

export type RepoCheckFlags = {
  draft: boolean;
  ci: boolean;
  duplicate: boolean;
  conflicts: boolean;
  reviewers: boolean;
  drift: boolean;
};

export type RepoRole = { users?: string[]; teams?: string[] };

export type RepoPolicy = {
  cleanupMode: CleanupMode;
  enabled: boolean;
  /** Off, draft pull requests are not mailed for triage until marked ready. */
  triageDrafts: boolean;
  checks: RepoCheckFlags;
  /** Named reviewer groups that pack actions target by role. */
  roles: Record<string, RepoRole>;
  /** GitHub logins trusted as approved authors without org membership. */
  approvedAuthors: string[];
  /** Pointer at the per-repo check-pack artifact. Not params. */
  checkPack?: { name: string };
};

export const DEFAULT_REPO_CHECKS: RepoCheckFlags = {
  draft: true,
  ci: true,
  duplicate: true,
  conflicts: true,
  reviewers: false,
  drift: true,
};

export const DEFAULT_REPO_POLICY: RepoPolicy = {
  cleanupMode: "human-approved",
  enabled: false,
  triageDrafts: true,
  checks: { ...DEFAULT_REPO_CHECKS },
  roles: {},
  approvedAuthors: [],
};

/** The policy as clients write it; `repoPolicy` defaults whatever is missing. */
export const repoPolicySchema = type({
  "cleanupMode?": type.enumerated(...CLEANUP_MODES),
  "enabled?": "boolean",
  "triageDrafts?": "boolean",
  "checks?": {
    "draft?": "boolean",
    "ci?": "boolean",
    "duplicate?": "boolean",
    "conflicts?": "boolean",
    "reviewers?": "boolean",
    "drift?": "boolean",
  },
  "roles?": { "[string]": { "users?": "string[]", "teams?": "string[]" } },
  "checkPack?": { name: "string" },
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function members(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const item of value) if (typeof item === "string" && item.trim().length > 0) out.add(item.trim());
  return [...out];
}

function roles(value: unknown): Record<string, RepoRole> {
  const out: Record<string, RepoRole> = {};
  for (const [rawName, raw] of Object.entries(asRecord(value))) {
    const name = rawName.trim();
    const row = asRecord(raw);
    const users = members(row.users);
    const teams = members(row.teams);
    if (!name || !users || !teams || users.length + teams.length === 0) continue;
    out[name] = { ...(users.length > 0 ? { users } : {}), ...(teams.length > 0 ? { teams } : {}) };
  }
  return out;
}

function logins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.flatMap((v) => (typeof v === "string" ? [v.trim().toLowerCase()] : []));
  return [...new Set(names.filter((name) => name.length > 0))];
}

export function authorAssociation(value: unknown): AuthorAssociation | null {
  return AUTHOR_ASSOCIATIONS.find((a) => a === value) ?? null;
}

/** `approvedAuthors` must already be normalised by `repoPolicy`. */
export function tierOf(association: AuthorAssociation | null, author: string, approvedAuthors: readonly string[]): TrustTier {
  if (association === "OWNER" || association === "MEMBER") return "internal";
  // A collaborator is invited per repo, so trusted, but not an org member.
  if (association === "COLLABORATOR") return "approved";
  return approvedAuthors.includes(author.toLowerCase()) ? "approved" : "external";
}

/** Defaults missing fields so pre-policy tenant config keeps all checks on. */
export function repoPolicy(raw: unknown): RepoPolicy {
  const row = asRecord(raw);
  const nested = asRecord(row.policy);
  const source = Object.keys(nested).length > 0 ? { ...row, ...nested } : row;
  const checks = asRecord(source.checks);
  const pointer = asRecord(source.checkPack);
  const pointerName = typeof pointer.name === "string" ? pointer.name.trim() : "";
  return {
    cleanupMode: source.cleanupMode === "automated" ? "automated" : "human-approved",
    enabled: flag(source.enabled, false),
    triageDrafts: flag(source.triageDrafts, true),
    checks: {
      draft: flag(checks.draft, true),
      ci: flag(checks.ci, true),
      duplicate: flag(checks.duplicate, true),
      conflicts: flag(checks.conflicts, true),
      reviewers: flag(checks.reviewers, false),
      drift: flag(checks.drift, true),
    },
    roles: roles(source.roles),
    approvedAuthors: logins(source.approvedAuthors),
    ...(pointerName.length > 0 ? { checkPack: { name: pointerName } } : {}),
  };
}
