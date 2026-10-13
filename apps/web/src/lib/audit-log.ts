import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { AuditEntry } from "@corbits/triage-contracts";
import { loadAuditLog } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

/** Events the page shows. */
export const AUDIT_LIMIT = 100;

function auditLogQuery(tenantId: string | undefined, repo: string | null) {
  const queryFn = tenantId === undefined ? skipToken : async function loadAudit() {
    return loadAuditLog(createHubTransport(), tenantId, repo, AUDIT_LIMIT);
  };
  return queryOptions({ queryKey: ["audit-log", tenantId, repo], queryFn, staleTime: 30_000 });
}

export function useAuditLog(repo: string | null) {
  const { snapshot } = usePortal();
  return useQuery(auditLogQuery(snapshot?.workspace.tenantId, repo));
}

/** Entries any of whose fields contains `search`, ignoring case. */
export function matchingEntries(entries: readonly AuditEntry[], search: string): AuditEntry[] {
  const term = search.trim().toLowerCase();
  if (term === "") return [...entries];
  return entries.filter((entry) => Object.values(entry).some((value) => value.toLowerCase().includes(term)));
}
