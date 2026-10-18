import { useQuery } from "@tanstack/react-query";
import { loadGithubPull } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export const GITHUB_PULL_QUERY_KEY = "github-pull";

export function useGithubPull(repo: string, number: number | null) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  async function fetchPull() {
    return loadGithubPull(createHubTransport(), tenantId as string, repo, number as number);
  }
  return useQuery({
    queryKey: [GITHUB_PULL_QUERY_KEY, tenantId, repo, number],
    queryFn: fetchPull,
    enabled: tenantId !== undefined && number !== null,
    refetchOnWindowFocus: false,
  });
}
