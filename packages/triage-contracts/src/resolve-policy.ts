import {
  CHECK_PACK_KIND,
  CHECK_PACK_SCHEMA_VERSION,
  CUSTOM_CHECK_CAP,
  readPolicyOverride,
  readSharedPolicy,
  refuseTriageLabels,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type PolicyOverride,
  type SharedPolicy,
} from "./check-pack.js";

export type ArtifactRef = { id: string; version: number };

/** `sha` is the file's blob on the default branch. */
export type PolicyFileRef = { path: string; sha: string };

/** The policy file of the repository a policy file extends. */
export type SharedFileRef = PolicyFileRef & { repo: string };

/** What a policy was read from: the repository's policy file, which may extend another repository's file, or else its stored policy. */
export type PolicySource = { repo?: ArtifactRef; file?: PolicyFileRef; sharedFile?: SharedFileRef };

/**
 * A repository's policy over the shared policy it extends. The shared policy holds wherever the repository is silent:
 * - Built-in rules merge by rule id, field by field: the repository's row replaces the shared row's fields it sets, so
 *   `{ enabled: false }` switches a shared rule off, and a limit or glob list alone replaces the shared one and keeps
 *   its switch. A rule the shared policy lacks is on unless the repository says otherwise. What a listed rule's
 *   failure does is the repository's, absent being fail.
 * - Custom rules merge by rule id: a repository rule replaces the shared rule of the same id whole, so a copy with
 *   `enabled: false` switches it off; the repository's other rules follow the shared ones. Together they stay within
 *   the custom rule cap, or the policy is refused.
 * - Actions merge by verdict: the repository's Pass, Fail or Unsure steps replace the shared steps for that verdict
 *   only when the repository sets them, and its `when` replaces the shared `when` only when set.
 * - Labels merge by verdict: a label the repository names replaces the shared one for that verdict.
 * What reading the shared policy left out is kept in `dropped`.
 */
export function resolvePolicy(shared: SharedPolicy, repo: PolicyOverride): CheckPack {
  const checks: CheckPack["checks"] = { ...shared.checks };
  for (const [id, row] of Object.entries(repo.checks) as Array<[CatalogId, Partial<CatalogCheck>]>) {
    const merged: CatalogCheck = { enabled: true, ...shared.checks[id], ...row };
    if (row.onFail === undefined) delete merged.onFail;
    if (row.label === undefined) delete merged.label;
    checks[id] = merged;
  }
  const own = new Map(repo.custom.map((row) => [row.id, row]));
  const sharedIds = new Set(shared.custom.map((row) => row.id));
  const custom = [...shared.custom.map((row) => own.get(row.id) ?? row), ...repo.custom.filter((row) => !sharedIds.has(row.id))];
  if (custom.length > CUSTOM_CHECK_CAP) throw new Error(`Policy and the shared policy it extends must have at most ${CUSTOM_CHECK_CAP} custom rules together.`);
  const { dropped } = shared;
  return refuseTriageLabels({
    ...(dropped && { dropped }),
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo: repo.repo,
    checks,
    custom,
    actions: {
      when: repo.actions.when ?? shared.actions.when,
      pass: repo.actions.pass ?? shared.actions.pass,
      fail: repo.actions.fail ?? shared.actions.fail,
      unsure: repo.actions.unsure ?? shared.actions.unsure,
    },
    labels: {
      pass: repo.labels.pass ?? shared.labels.pass,
      fail: repo.labels.fail ?? shared.labels.fail,
      unsure: repo.labels.unsure ?? shared.labels.unsure,
    },
  });
}

/** A policy file's pack over the policy file of the repository its `extends` names, which must extend nothing itself. */
export function extendedFilePack(repo: string, content: unknown, shared: { repo: string; policy: Record<string, unknown> }): CheckPack {
  if (shared.policy.extends !== undefined) throw new Error(`${shared.repo}'s policy extends another, so no policy can extend it.`);
  return resolvePolicy(readSharedPolicy(shared.policy), readPolicyOverride(content, repo));
}
