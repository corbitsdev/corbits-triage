// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the run logs and the stored state, then
// queues what the plan says through the same path webhooks use.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { listOpenPrs, type GithubFetch } from "@corbits/github-tool/github";
import { repoPolicy, type CheckPack, type RepoPolicy } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { resolveLiveDeployment } from "./deployment.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch } from "./portal-credential.js";
import { planRepo, type OpenPr, type ReconcilePolicy } from "./reconcile-plan.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import type { ObservedRuns } from "./triage-runs.js";
import type { TriageStateStore } from "./triage-state-store.js";

export type TriageReconcilerDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  githubApiOrigin: string;
  /** The deployed workflow that triages one pull request. */
  workflowName: string;
  store: TriageStateStore;
  observeRuns: (tenantId: string, domain: string) => Promise<ObservedRuns>;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  sendMail: (tenantId: string, workflow: string, payload: unknown) => Promise<unknown>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

type EnabledRepo = { record: RepoRecord; policy: RepoPolicy };

/** Deliveries stop for the tenant once one fails: its deployment is unreachable until a later pass. */
class DeliveryFailed extends Error {}

function enabledRepos(config: unknown): EnabledRepo[] {
  return repoRecords(triageNs(config)).flatMap(function enabled(record) {
    const policy = repoPolicy(record);
    return record.connected && policy.enabled ? [{ record, policy }] : [];
  });
}

function openHeads(prs: Awaited<ReturnType<typeof listOpenPrs>>): OpenPr[] {
  return prs.flatMap((pr) => (typeof pr.sha === "string" && pr.sha !== "" ? [{ number: pr.number, headSha: pr.sha, updatedAt: pr.updatedAt }] : []));
}

export function createTriageReconciler(deps: TriageReconcilerDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function tenantGithub(tenantId: string): Promise<GithubFetch | undefined> {
    const credential = await deps.db.query.credential.findFirst({
      where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, "github"), eq(schema.credential.status, "active")),
    });
    if (!credential) return undefined;
    const appJson = await deps.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    return appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
  }

  async function reconcileRepo(tenantId: string, gh: GithubFetch, repo: EnabledRepo, pack: CheckPack, runs: ObservedRuns): Promise<void> {
    const name = repo.record.name;
    const prs = openHeads(await listOpenPrs(forInstallation(gh, repo.record.installationId), name));
    const stored = await deps.store.load(tenantId, name);
    const plan = planRepo({ prs, rows: stored, runs: runs.get(name) ?? new Map(), now: deps.now(), policy: deps.policy });
    const rows = [...plan.rows];
    let failure: unknown;
    for (const queued of plan.enqueue) {
      const index = rows.findIndex((row) => row.number === queued.number);
      const headSha = rows[index]!.headSha;
      if (failure !== undefined) {
        rows[index] = queued.undelivered;
        continue;
      }
      try {
        await deps.sendMail(tenantId, deps.workflowName, mailPayload(name, repo.policy, pack, { prNumber: queued.number, headSha }));
        deps.log({ level: "info", msg: "triage_requeued", tenantId, repo: name, pr: queued.number, headSha });
      } catch (err) {
        failure = err;
        rows[index] = { ...queued.undelivered, error: `delivery failed: ${String(err)}` };
      }
    }
    if (JSON.stringify(rows) !== JSON.stringify(stored)) await deps.store.save(tenantId, name, rows);
    if (failure !== undefined) throw new DeliveryFailed(String(failure));
  }

  async function reconcileTenant(tenant: { id: string; domain: string; config: unknown }): Promise<void> {
    const repos = enabledRepos(tenant.config);
    if (repos.length === 0) return;
    // The hub never deploys on its own; without a live deployment there is nothing to queue to.
    if (!(await resolveLiveDeployment(deps.db, tenant.id, deps.workflowName))) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return;
    }
    const gh = await tenantGithub(tenant.id);
    if (!gh) return;
    const runs = await deps.observeRuns(tenant.id, tenant.domain);
    for (const repo of repos) {
      const read = await deps.readCheckPack(tenant.id, repo.record.name);
      if (read.status !== "ok") continue;
      try {
        await reconcileRepo(tenant.id, gh, repo, read.pack, runs);
      } catch (err) {
        deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, repo: repo.record.name, error: String(err) });
        if (err instanceof DeliveryFailed) return;
      }
    }
  }

  return async function reconcileTriage(): Promise<void> {
    const tenants = await deps.db.select({ id: schema.tenant.id, domain: schema.tenant.domain, config: schema.tenant.config }).from(schema.tenant);
    for (const tenant of tenants) {
      try {
        await reconcileTenant(tenant);
      } catch (err) {
        deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, error: String(err) });
      }
    }
  };
}
