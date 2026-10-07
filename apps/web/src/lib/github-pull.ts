import { useQuery } from "@tanstack/react-query";
import { loadGithubPull } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

/** Reads a pull request's files, commits, checks, reviews, issues and conversation live from GitHub. */
export function useGithubPull(repo: string, number: number | null) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  async function fetchPull() {
    return loadGithubPull(createHubTransport(), tenantId as string, repo, number as number);
  }
  return useQuery({
    queryKey: ["github-pull", tenantId, repo, number],
    queryFn: fetchPull,
    enabled: tenantId !== undefined && number !== null,
    refetchOnWindowFocus: false,
  });
}
