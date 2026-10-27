import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { exportPolicyFile, loadPolicyFile, loadPolicyPushAccess, previewPolicy, pushPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export const POLICY_FILE_QUERY_KEY = "policy-file";

function policyFileQuery(tenantId: string | undefined, repo: string, source: RepoSource) {
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyFile() {
    return loadPolicyFile(createHubTransport(), tenantId, repo, source);
  };
  // A merge on the host changes the file without the portal knowing, so each panel opening reads it again.
  return queryOptions({ queryKey: [POLICY_FILE_QUERY_KEY, tenantId, repo, source], queryFn, staleTime: 60_000, refetchOnMount: "always" });
}

/** The repository's policy file on its default branch, with its text. */
export function usePolicyFile(repo: string, source: RepoSource) {
  const { snapshot } = usePortal();
  return useQuery(policyFileQuery(snapshot?.workspace.tenantId, repo, source));
}

/** Whether the default branch lets the file be pushed to it, read only while `asking`, as it asks the host. */
export function usePolicyPushAccess(repo: string, source: RepoSource, asking: boolean) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryFn = tenantId === undefined || !asking ? skipToken : async function readPushAccess() {
    return loadPolicyPushAccess(createHubTransport(), tenantId, repo, source);
  };
  return useQuery({ queryKey: ["policy-push", tenantId, repo, source], queryFn, staleTime: 60_000, retry: false });
}

/** An edit to the file: the edited text and the sha of the file it was edited from. */
export type PolicyEdit = { text: string; sha: string };

/** Checking edited text as triage would read it, and saving it through a pull request or a push; a save reads the policy again. */
export function usePolicyEditActions(repo: string, source: RepoSource) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryClient = useQueryClient();

  function workspace(): string {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return tenantId;
  }

  async function reread() {
    await Promise.all([POLICY_FILE_QUERY_KEY, "check-pack", "policy-upgrades"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
  }

  const preview = useMutation({
    mutationFn: function previewText(text: string) {
      return previewPolicy(createHubTransport(), workspace(), repo, source, text);
    },
  });
  const propose = useMutation({
    mutationFn: function openPull(edit: PolicyEdit) {
      return exportPolicyFile(createHubTransport(), workspace(), repo, source, edit);
    },
    onSuccess: reread,
  });
  const push = useMutation({
    mutationFn: function pushFile(edit: PolicyEdit) {
      return pushPolicyFile(createHubTransport(), workspace(), repo, source, edit);
    },
    onSuccess: reread,
  });
  return { preview, propose, push };
}
