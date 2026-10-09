import { queryOptions } from "@tanstack/react-query";
import { listCheckPackTitles } from "./check-pack.ts";
import { createHubTransport } from "./hub-transport.ts";

export const CHECK_PACK_INDEX_QUERY_KEY = "check-pack-index";

/** Read only for repositories whose config lacks a pack pointer, at most once per minute plus after refresh(). */
export function checkPackIndexQuery(tenantId: string) {
  return queryOptions({
    queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId],
    queryFn: () => listCheckPackTitles(createHubTransport(), tenantId),
    staleTime: 60_000,
  });
}
