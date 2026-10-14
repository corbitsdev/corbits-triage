import {
  CHECK_PACK_KIND,
  CHECK_PACK_SCHEMA_VERSION,
  CUSTOM_CHECK_CAP,
  readCheckPack,
  readPolicyOverride,
  readSharedPolicy,
  WORKSPACE_POLICY_TITLE_PREFIX,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type PolicyOverride,
  type SharedPolicy,
} from "./check-pack.js";

export type ArtifactRef = { id: string; version: number };

export type PolicySource = { repo: ArtifactRef; shared?: ArtifactRef };

/**
 * A repository's policy over the shared policy it extends. The shared policy holds wherever the repository is silent:
 * - Built-in rules merge by rule id, field by field: the repository's row replaces the shared row's fields it sets, so
 *   `{ enabled: false }` switches a shared rule off, and a limit or glob list alone replaces the shared one and keeps
 *   its switch. A rule the shared policy lacks is on unless the repository says otherwise.
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
  for (const [id, row] of Object.entries(repo.checks) as Array<[CatalogId, Partial<CatalogCheck>]>) checks[id] = { enabled: true, ...shared.checks[id], ...row };
  const own = new Map(repo.custom.map((row) => [row.id, row]));
  const sharedIds = new Set(shared.custom.map((row) => row.id));
  const custom = [...shared.custom.map((row) => own.get(row.id) ?? row), ...repo.custom.filter((row) => !sharedIds.has(row.id))];
  if (custom.length > CUSTOM_CHECK_CAP) throw new Error(`Policy and the shared policy it extends must have at most ${CUSTOM_CHECK_CAP} custom rules together.`);
  const { dropped } = shared;
  return {
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
  };
}

/**
 * The pack a stored repository policy runs as: the policy itself, or resolved over the workspace policy it extends.
 * `shared` is that workspace policy's artifact when the policy extends one, and null when it no longer exists.
 */
export function storedPolicyPack(repo: string, content: unknown, shared?: { title: string; content: unknown } | null): CheckPack {
  if (shared === undefined) return readCheckPack(content, repo);
  if (shared === null) throw new Error("The workspace policy it extends no longer exists.");
  if (!shared.title.startsWith(WORKSPACE_POLICY_TITLE_PREFIX)) throw new Error("It extends an artifact that is not a workspace policy.");
  return resolvePolicy(readSharedPolicy(shared.content), readPolicyOverride(content, repo));
}
