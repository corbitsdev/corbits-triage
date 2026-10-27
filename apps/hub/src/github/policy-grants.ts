// Under the workspace's `policy` automation, what triage does unattended on an enabled repository is what its policy
// uses: each successful read grants the pr-triage role those kinds and takes back the rest. Under `ask` the hub grants
// only posting, on enable, and every other kind waits for a person.
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { checkPolicyFile, policyKinds, postingKinds, type ActionKind, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { grantWanted } from "./automation.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { prWorkflowKeys } from "./pr-workflow.js";
import { automationMode, repoRecords, sourceOf, triageNs } from "./tenant-config.js";

export type PolicyGrantsDeps = {
  db: DB["db"];
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>;
  /** The pack a policy file holding `policy` runs, its `extends` resolved; throws why triage would refuse it. */
  filePack: (tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) => Promise<CheckPack>;
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
      await grantWanted(tx, tenantId, repo, source, wanted, deps.now());
      return true;
    });
    return granted ? { ...read, automatic: await deps.automaticKinds(tenantId, repo) } : read;
  }

  /**
   * Under `ask`, the kinds a policy file holding `text` uses that the role does not hold on the repository, which wait for
   * a person once it is merged. Under `policy` none do, and a file triage would refuse runs nothing.
   */
  async function waitingKinds(tenantId: string, repo: string, source: RepoSource, text: string): Promise<ActionKind[]> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (automationMode(triageNs(tenant?.config)) === "policy") return [];
    const checked = checkPolicyFile(text, repo);
    if (!checked.ok) return [];
    let pack: CheckPack;
    try {
      pack = await deps.filePack(tenantId, repo, source, checked.policy);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return [];
    }
    const held = await deps.automaticKinds(tenantId, repo);
    // Enabling a repository grants posting, and triage runs on no other.
    const waits = policyKinds(pack, prWorkflowKeys(checked.workflow, pack)?.decide ?? [], source).filter((kind) => !postingKinds(source).includes(kind));
    return waits.filter((kind) => !held.includes(kind));
  }

  return { followPolicy, waitingKinds };
}
