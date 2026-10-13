import { useQuery } from "@tanstack/react-query";
import { activeGithubCredential, hasActiveGithubCredential } from "./hub-api.ts";
import { usePortal } from "./portal.tsx";
import { useAccess } from "./tenant-entities.ts";

/** Whether the member may manage the App credential; the sync rewrites the stored repositories, so others read them as stored. */
export function useGithubManageAccess() {
  const { snapshot } = usePortal();
  const credential = snapshot ? activeGithubCredential(snapshot.credentials) : undefined;
  return useAccess(`credential:${credential?.id ?? "*"}`, "manage");
}

/** Reads the App's repositories from GitHub each time a page that needs them mounts. */
export function useGithubSync(enabled: boolean) {
  const { snapshot, syncFromGithub } = usePortal();
  const access = useGithubManageAccess();
  const sync = useQuery({
    queryKey: ["github-sync", snapshot?.workspace.tenantId],
    queryFn: syncFromGithub,
    enabled: enabled && snapshot !== null && hasActiveGithubCredential(snapshot.credentials) && access.data === true,
    refetchOnWindowFocus: false,
  });
  return { ...sync, error: sync.error ?? access.error, denied: access.data === false };
}
