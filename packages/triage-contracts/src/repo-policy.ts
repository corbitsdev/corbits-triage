import { type } from "arktype";
import { asRecord } from "@corbits/common";
import type { TrustTier } from "./types.js";

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
  ci: boolean;
  conflicts: boolean;
};

export type RepoPolicy = {
  enabled: boolean;
  checks: RepoCheckFlags;
  approvedAuthors: string[];
  /** Not params. */
  checkPack?: { name: string; id?: string };
};

export const DEFAULT_REPO_CHECKS: RepoCheckFlags = {
  ci: true,
  conflicts: true,
};

export const DEFAULT_REPO_POLICY: RepoPolicy = {
  enabled: false,
  checks: { ...DEFAULT_REPO_CHECKS },
  approvedAuthors: [],
};

export const repoPolicySchema = type({
  "enabled?": "boolean",
  "checks?": {
    "ci?": "boolean",
    "conflicts?": "boolean",
  },
  "checkPack?": { name: "string", "id?": "string" },
});

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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

/** Keeps all checks on for pre-policy tenant config. */
export function repoPolicy(raw: unknown): RepoPolicy {
  const row = asRecord(raw) ?? {};
  const nested = asRecord(row.policy) ?? {};
  const source = Object.keys(nested).length > 0 ? { ...row, ...nested } : row;
  const checks = asRecord(source.checks) ?? {};
  const pointer = asRecord(source.checkPack) ?? {};
  const pointerName = typeof pointer.name === "string" ? pointer.name.trim() : "";
  return {
    enabled: flag(source.enabled, false),
    checks: {
      ci: flag(checks.ci, true),
      conflicts: flag(checks.conflicts, true),
    },
    approvedAuthors: logins(source.approvedAuthors),
    ...(pointerName.length > 0 ? { checkPack: { name: pointerName, ...(typeof pointer.id === "string" && { id: pointer.id }) } } : {}),
  };
}
