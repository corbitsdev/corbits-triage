export const CLEANUP_MODES = ["human-approved", "automated"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

export type RepoCheckFlags = {
  draft: boolean;
  ci: boolean;
  duplicate: boolean;
  conflicts: boolean;
  reviewers: boolean;
  drift: boolean;
};

export type RepoPolicy = {
  cleanupMode: CleanupMode;
  classificationAuthorized: boolean;
  checks: RepoCheckFlags;
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
  classificationAuthorized: true,
  checks: { ...DEFAULT_REPO_CHECKS },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
    classificationAuthorized: flag(source.classificationAuthorized, true),
    checks: {
      draft: flag(checks.draft, true),
      ci: flag(checks.ci, true),
      duplicate: flag(checks.duplicate, true),
      conflicts: flag(checks.conflicts, true),
      reviewers: flag(checks.reviewers, false),
      drift: flag(checks.drift, true),
    },
    ...(pointerName.length > 0 ? { checkPack: { name: pointerName } } : {}),
  };
}
