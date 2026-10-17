import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import { loadPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

function policyFileQuery(tenantId: string | undefined, repo: string) {
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyFile() {
    return loadPolicyFile(createHubTransport(), tenantId, repo);
  };
  // A merge on GitHub changes the file without the portal knowing, so each panel opening reads it again.
  return queryOptions({ queryKey: ["policy-file", tenantId, repo], queryFn, staleTime: 60_000, refetchOnMount: "always" });
}

/** The repository's policy file. */
export function usePolicyFile(repo: string) {
  const { snapshot } = usePortal();
  return useQuery(policyFileQuery(snapshot?.workspace.tenantId, repo));
}
