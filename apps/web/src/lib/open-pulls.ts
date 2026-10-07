import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectQueue, type PrItem } from "./hub-api.ts";
import { loadOpenPulls } from "./github-manifest.ts";
import { usePortal } from "./portal.tsx";

/** Reads the open pull requests from GitHub, so PRs without a verdict still show up. */
export function useOpenPulls() {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useQuery({
    queryKey: ["open-pulls", tenantId],
    queryFn: async function fetchOpenPulls() {
      return loadOpenPulls(tenantId ?? "");
    },
    enabled: tenantId !== undefined,
    refetchInterval: 30_000,
  });
}

/** The inbox: every open pull request, with its verdict when it has one. */
export function useQueueItems(): PrItem[] {
  const { snapshot } = usePortal();
  const { data } = useOpenPulls();
  return useMemo(() => (snapshot ? projectQueue(snapshot, data) : []), [snapshot, data]);
}
