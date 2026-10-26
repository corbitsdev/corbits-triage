// Each pull request host binds the credential named after it, so a workspace runs a host's triage once it holds that
// credential.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { CODE_REVIEW_PROVIDERS, codeReviewProviderOf, REPO_SOURCES, TRIAGE_LISTENERS, TRIAGE_MANAGERS, type RepoSource } from "@corbits/triage-contracts";

/** The workflows that carried out held Do approvals before the managers did; the audit log still reads their runs. */
export const APPROVAL_WORKFLOWS: readonly string[] = REPO_SOURCES.flatMap((source) => [`pr-triage-${source}`, `pr-workflow-anthropic-${source}`]);

/** Every workflow whose runs recorded a host's verdicts: the workflows a manager replaced, then its manager. */
export function verdictWorkflowsFor(source: RepoSource): string[] {
  return [`pr-triage-${source}`, `pr-code-review-${source}`, `pr-workflow-anthropic-${source}`, TRIAGE_MANAGERS[source]];
}

/** The names of the code review provider credentials the workspace holds active; names only, never secrets. */
async function codeReviewKeys(db: DB["db"], tenantId: string): Promise<string[]> {
  const credentials = Object.values(CODE_REVIEW_PROVIDERS).map((provider) => provider.credential);
  const rows = await db.query.credential.findMany({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.status, "active"), inArray(schema.credential.name, credentials)),
    columns: { name: true },
  });
  return rows.map((row) => row.name);
}

/** Whether the workspace stores a code review provider's key. */
export async function hasCodeReviewKey(db: DB["db"], tenantId: string): Promise<boolean> {
  return codeReviewProviderOf(await codeReviewKeys(db, tenantId)) !== undefined;
}

/** The hosts whose credential the workspace holds. */
export async function connectedSources(db: DB["db"], tenantId: string): Promise<RepoSource[]> {
  const rows = await db.query.credential.findMany({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.status, "active"), inArray(schema.credential.name, [...REPO_SOURCES])),
    columns: { name: true },
  });
  const names = new Set(rows.map((row) => row.name));
  return REPO_SOURCES.filter((source) => names.has(source));
}

export type HostReleaseDeps = {
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  liveDeployments: (tenantId: string, workflow: string) => Promise<Array<{ runId: string; cancelling: boolean }>>;
  cancel: (tenantId: string, runId: string) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

/** A host's listener and the managers it deployed hold its credential, so they are released once the host is disconnected. */
export function createHostRelease(deps: HostReleaseDeps) {
  return async function releaseDisconnected(tenantId: string): Promise<void> {
    const connected = await deps.connectedSources(tenantId);
    for (const source of REPO_SOURCES.filter((host) => !connected.includes(host))) {
      for (const workflow of [TRIAGE_LISTENERS[source], TRIAGE_MANAGERS[source]]) {
        for (const live of await deps.liveDeployments(tenantId, workflow)) {
          if (live.cancelling) continue;
          await deps.cancel(tenantId, live.runId);
          deps.log({ level: "info", msg: "triage_deployment_released", tenantId, workflow, deployment: live.runId, reason: "source_disconnected" });
        }
      }
    }
  };
}
