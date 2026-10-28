// Lets triage do one kind of Do on its own in one repository, from a held Do a person chose to always allow there.
// The hub builds the grant itself, so the portal never names a role or a grant resource.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { ACTION_KINDS, alwaysHeld, DO_GRANT_ACTION, doResource, hostKinds, REPO_SOURCES, repoPolicy, TRIAGE_ROLE, VERDICTS, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { allowRole } from "./admin-github-grant.js";
import { triageRoleId } from "./automation.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";
import type { Member } from "../integrations/app.js";

export const TRIAGE_AUTOMATION_PATH = "/api/integrations/triage-automation";

/** `list` is the verdict of the held action the person chose this from. */
export const AutomationBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, source: type.enumerated(...REPO_SOURCES), kind: type.enumerated(...ACTION_KINDS), list: type.enumerated(...VERDICTS) });

export type TriageAutomationDeps = Pick<PortalCredentialDeps, "authorize"> & {
  db: DB["db"];
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>;
  /** The kinds the repository's policy file has Triage take on its own on the host; none without a file Triage runs. */
  wantedKinds: (tenantId: string, repo: string, source: RepoSource) => Promise<ActionKind[]>;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

type Refusal = { status: number; code: string; message: string };

export function createTriageAutomation(deps: TriageAutomationDeps) {
  return async function allowAutomation({ repo, source, kind, list }: typeof AutomationBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    if (!(await deps.authorize(principalId, tenantId, "grant:*", "create"))) return failure(403, "forbidden", "You may not change what Triage does on its own.");
    if (!hostKinds(source).includes(kind)) return failure(422, "kind_not_on_host", `The repository's host has no ${kind}.`);
    if (alwaysHeld(list, kind)) return failure(422, "always_held", `A ${kind} on a ${list} verdict always waits for a person.`);
    if (!(await deps.wantedKinds(tenantId, repo, source)).includes(kind)) return failure(422, "kind_not_wanted", `The repository's policy file does not name ${kind}. Add it to the file first.`);
    // The tenant row is read under a share lock, so a repository switched off in the meantime loses this grant with the others.
    const refused = await deps.db.transaction(async function allowLocked(tx): Promise<Refusal | undefined> {
      const [tenant] = await tx.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("share");
      if (!tenant) return { status: 409, code: "workspace_unconfigured", message: "The workspace is not set up yet." };
      const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && sourceOf(row) === source && row.connected);
      if (!record || !repoPolicy(record).enabled) return { status: 409, code: "repo_not_enabled", message: "Triage is disabled for this repository. Enable it first." };
      const roleId = await triageRoleId(tx, tenantId);
      if (!roleId) throw new Error(`Workspace ${tenantId} has no ${TRIAGE_ROLE} role; connecting a host creates it.`);
      await allowRole(tx, tenantId, roleId, doResource(kind, repo), DO_GRANT_ACTION, deps.now());
      return undefined;
    });
    if (refused) return failure(refused.status, refused.code, refused.message);
    deps.log({ level: "info", msg: "triage_automation_allowed", tenantId, principalId, repo, source, kind });
    return Response.json({ automatic: await deps.automaticKinds(tenantId, repo) });
  };
}
