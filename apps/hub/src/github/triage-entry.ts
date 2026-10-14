// Which pr-triage entry a workspace deploys: the definition binds the credentials of the hosts it is built for, and an
// unresolved binding fails the deployment, so the entry follows the hosts the workspace connected.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import type { RepoSource } from "@corbits/triage-contracts";

export type TriageEntry = { sources: readonly RepoSource[]; entry: string };

/** Every entry the pr-triage package ships; the GitHub one is what every workspace deployed before other hosts. */
export const TRIAGE_ENTRIES: readonly TriageEntry[] = [
  { sources: ["github"], entry: "./pr-triage.mjs" },
  { sources: ["bitbucket-datacenter"], entry: "./pr-triage-bitbucket-datacenter.mjs" },
  { sources: ["github", "bitbucket-datacenter"], entry: "./pr-triage-github-bitbucket-datacenter.mjs" },
];

const CREDENTIALS: Record<RepoSource, string> = { github: "github", "bitbucket-datacenter": "bitbucket-datacenter" };

export function isTriageEntry(entry: string): boolean {
  return TRIAGE_ENTRIES.some((candidate) => candidate.entry === entry);
}

/** The hosts whose credential the workspace holds, in `TRIAGE_ENTRIES` order. */
export async function connectedSources(db: DB["db"], tenantId: string): Promise<RepoSource[]> {
  const rows = await db.query.credential.findMany({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.status, "active"), inArray(schema.credential.name, Object.values(CREDENTIALS))),
    columns: { name: true },
  });
  const names = new Set(rows.map((row) => row.name));
  return (Object.keys(CREDENTIALS) as RepoSource[]).filter((source) => names.has(CREDENTIALS[source]));
}

/** The entry for exactly these hosts; undefined when none is connected. */
export function triageEntryFor(sources: readonly RepoSource[]): string | undefined {
  return TRIAGE_ENTRIES.find((candidate) => candidate.sources.length === sources.length && candidate.sources.every((source) => sources.includes(source)))?.entry;
}
