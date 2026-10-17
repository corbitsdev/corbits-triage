import { queryOptions, skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { exportPolicyFile, loadPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

function policyFileQuery(tenantId: string | undefined, repo: string) {
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyFile() {
    return loadPolicyFile(createHubTransport(), tenantId, repo);
  };
  // A merge on GitHub changes the file without the portal knowing, so each panel opening reads it again.
  return queryOptions({ queryKey: ["policy-file", tenantId, repo], queryFn, staleTime: 60_000, refetchOnMount: "always" });
}

/** The repository's policy file, and exporting the policy as the file. */
export function usePolicyFile(repo: string) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const file = useQuery(policyFileQuery(tenantId, repo));

  async function exportFile() {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return exportPolicyFile(createHubTransport(), tenantId, repo);
  }

  const exported = useMutation({ mutationFn: exportFile });
  return { file, exported };
}
