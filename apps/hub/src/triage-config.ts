import { type } from "arktype";
import { nsRev, saveCorbitsTriage } from "./github/tenant-config.js";
import { failure, portalMember, type PortalCredentialDeps } from "./github/portal-credential.js";
import { readJson } from "./read-json.js";

export const TRIAGE_CONFIG_PATH = "/api/integrations/triage-config";

export const TriageConfigBody = type({ rev: "number.integer >= 0", config: "Record<string, unknown>" });
export const TriageConfigSaved = type({ rev: "number.integer", config: "Record<string, unknown>" });

export function createTriageConfig(deps: PortalCredentialDeps) {
  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    if (!(await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"))) {
      return failure(403, "forbidden", "You do not have permission to manage this workspace.");
    }
    const body = TriageConfigBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);

    const result = await saveCorbitsTriage(deps.db, tenantId, body.rev, body.config);
    if (!result) return failure(404, "not_found", "Workspace not found");
    if (!result.saved) return failure(409, "config_conflict", "These settings changed since you loaded them. Reload and try again.");
    return Response.json({ rev: nsRev(result.ns), config: result.ns });
  };
}
