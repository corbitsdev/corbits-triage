import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PolicyPatchChange, RepoSource } from "@corbits/triage-contracts";
import { exportPolicyFile, loadPolicyFile, loadPolicyPushAccess, patchPolicyFile, previewPolicy, pushPolicyFile, type CheckPackArtifact } from "./hub-api.ts";
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

/** The policy Triage would read from the open policy pull request's file, which the page's switches show until it merges. */
export function useBranchPolicy(repo: string, source: RepoSource, text: string | undefined) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryFn = tenantId === undefined || text === undefined ? skipToken : async function readBranchPolicy(): Promise<CheckPackArtifact> {
    return previewPolicy(createHubTransport(), tenantId, repo, source, text);
  };
  return useQuery({ queryKey: ["policy-branch", tenantId, repo, source, text], queryFn, staleTime: Infinity });
}

/** The file before and after a batch, and the policy Triage would read from the file after it. */
export type PatchPreview = { before: string; after: string; read: CheckPackArtifact };

/** What a batch of changes would make of the file, read again whenever the batch changes; it writes nothing. */
export function usePatchPreview(repo: string, source: RepoSource, changes: readonly PolicyPatchChange[]) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryFn = tenantId === undefined || changes.length === 0 ? skipToken : async function readPreview(): Promise<PatchPreview> {
    const transport = createHubTransport();
    const patched = await patchPolicyFile(transport, tenantId, repo, source, changes, true);
    if (!("after" in patched)) throw new Error("The preview opened a pull request.");
    return { ...patched, read: await previewPolicy(transport, tenantId, repo, source, patched.after) };
  };
  return useQuery({ queryKey: ["policy-patch-preview", tenantId, repo, source, changes], queryFn, retry: false });
}

/** Opening one pull request with a batch of changes, or adding them to the open one; the policy and its pull request are read again. */
export function usePolicyPatch(repo: string, source: RepoSource) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryClient = useQueryClient();

  async function reread() {
    await Promise.all([POLICY_FILE_QUERY_KEY, "check-pack", "policy-upgrades"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
  }

  return useMutation({
    mutationFn: async function openPull(changes: readonly PolicyPatchChange[]) {
      if (tenantId === undefined) throw new Error("The workspace is not known yet.");
      const opened = await patchPolicyFile(createHubTransport(), tenantId, repo, source, changes, false);
      if (!("status" in opened)) throw new Error("Nothing in the file changed, so no pull request was opened.");
      return opened;
    },
    onSuccess: reread,
  });
}
