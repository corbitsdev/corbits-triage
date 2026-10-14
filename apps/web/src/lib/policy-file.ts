import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { exportPolicyFile, loadPolicyFile, syncPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

function policyFileQuery(tenantId: string | undefined, repo: string) {
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyFile() {
    return loadPolicyFile(createHubTransport(), tenantId, repo);
  };
  return queryOptions({ queryKey: ["policy-file", tenantId, repo], queryFn, staleTime: 60_000 });
}

/** The repository's policy file, "Use file" to store it as the policy now, and exporting the policy as the file. */
export function usePolicyFile(repo: string, onSynced: () => void) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryClient = useQueryClient();
  const query = policyFileQuery(tenantId, repo);
  const file = useQuery(query);

  async function syncFromFile() {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return syncPolicyFile(createHubTransport(), tenantId, repo);
  }

  async function exportFile() {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return exportPolicyFile(createHubTransport(), tenantId, repo);
  }

  async function afterSync() {
    await queryClient.invalidateQueries({ queryKey: query.queryKey });
    onSynced();
  }

  const sync = useMutation({ mutationFn: syncFromFile, onSuccess: afterSync });
  const exported = useMutation({ mutationFn: exportFile });
  return { file, sync, exported };
}
