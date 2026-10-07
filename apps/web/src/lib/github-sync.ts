import { useQuery } from "@tanstack/react-query";
import { usePortal } from "./portal.tsx";

/** Reads the App's repositories from GitHub each time a page that needs them mounts. */
export function useGithubSync(enabled: boolean) {
  const { snapshot, syncFromGithub } = usePortal();
  return useQuery({
    queryKey: ["github-sync", snapshot?.workspace.tenantId],
    queryFn: syncFromGithub,
    enabled: enabled && snapshot !== null,
    refetchOnWindowFocus: false,
  });
}
