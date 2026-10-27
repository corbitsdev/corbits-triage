// Under the workspace's `policy` automation, what triage does unattended on an enabled repository is what its policy
// uses: each successful read grants the pr-triage role those kinds and takes back the rest. Under `ask` the hub grants
// only posting, on enable, and every other kind waits for a person.
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { policyKinds, postingKinds, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { grantWanted } from "./automation.js";
import type { CheckPackRead } from "./repo-policy.js";
import { automationMode, repoRecords, sourceOf, triageNs } from "./tenant-config.js";

export type PolicyGrantsDeps = {
  db: DB["db"];
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>;
  /** Edited policy file text read as triage would read it once merged. */
  preview: (tenantId: string, repo: string, source: RepoSource, text: string) => Promise<CheckPackRead>;
  /** Whether a read of the file at `sha` is still the repository's newest, so an overtaken read grants nothing. */
  isNewest: (tenantId: string, repo: string, source: RepoSource, sha: string) => boolean;
  now: () => Date;
};

export function createPolicyGrants(deps: PolicyGrantsDeps) {
  /** The read, with `automatic` as the role holds it once the read's kinds are granted. A read that failed grants nothing. */
  async function followPolicy(tenantId: string, repo: string, source: RepoSource, read: CheckPackRead): Promise<CheckPackRead> {
    if (read.status !== "ok") return read;
    const wanted = policyKinds(read.pack, read.policyWorkflow?.decide ?? [], source);
    const granted = await deps.db.transaction(async function grantPolicy(tx) {
      // Shares the row lock every writer of the namespace takes, so a repository switched off meanwhile is not granted again.
      const [tenant] = await tx.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("share");
      const ns = triageNs(tenant?.config);
      const enabled = repoRecords(ns).some((record) => record.name === repo && sourceOf(record) === source && record.enabled === true);
      if (!enabled || automationMode(ns) === "ask") return false;
      const sha = read.source.file?.sha;
      await grantWanted(tx, tenantId, repo, source, wanted, deps.now(), function newest() {
        return sha === undefined || deps.isNewest(tenantId, repo, source, sha);
      });
      return true;
    });
    return granted ? { ...read, automatic: await deps.automaticKinds(tenantId, repo) } : read;
  }

  /**
   * Edited text read as triage would read it once merged, with `automatic` as the role will hold it then: under `policy`
   * merging it grants what it uses, so the editor's merge caution is judged on those grants and not today's.
   */
  async function previewGranted(tenantId: string, repo: string, source: RepoSource, text: string): Promise<CheckPackRead> {
    const read = await deps.preview(tenantId, repo, source, text);
    if (read.status !== "ok") return read;
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (automationMode(triageNs(tenant?.config)) === "ask") return read;
    const wanted = policyKinds(read.pack, read.policyWorkflow?.decide ?? [], source);
    return { ...read, automatic: [...new Set([...read.automatic, ...wanted])] };
  }

  /**
   * Under `ask`, the kinds a policy file holding `text` uses that the role does not hold on the repository, which wait for
   * a person once it is merged. Under `policy` none do, and a file triage would refuse runs nothing.
   */
  async function waitingKinds(tenantId: string, repo: string, source: RepoSource, text: string): Promise<ActionKind[]> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (automationMode(triageNs(tenant?.config)) === "policy") return [];
    const read = await deps.preview(tenantId, repo, source, text);
    if (read.status !== "ok") return [];
    // Enabling a repository grants posting, and triage runs on no other.
    const waits = policyKinds(read.pack, read.policyWorkflow?.decide ?? [], source).filter((kind) => !postingKinds(source).includes(kind));
    return waits.filter((kind) => !read.automatic.includes(kind));
  }

  return { followPolicy, previewGranted, waitingKinds };
}
