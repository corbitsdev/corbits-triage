import { asRecord } from "@corbits/common";
import type { RepoStore, WorkflowRunEvent, WorkflowRunReader } from "@intx/hub-sessions";

const BLOB_PREFIX = "blob:";
const HUB = { kind: "hub" } as const;

function blobRef(event: WorkflowRunEvent): string | undefined {
  const ref = asRecord(event.body["output"])?.["ref"];
  return typeof ref === "string" && ref.startsWith(BLOB_PREFIX) ? ref : undefined;
}

/** `reader` with each step output spilled to a `blob:<sha>` ref read back into an `inline:` ref; one that cannot be read is left as it is, which reads as no output. */
export function withBlobOutputs(reader: WorkflowRunReader, repoStore: Pick<RepoStore, "openCommittedReads">, log: { error(message: string, properties: Record<string, unknown>): void }): WorkflowRunReader {
  async function readRunEvents(...[repoId, ref, runId]: Parameters<WorkflowRunReader["readRunEvents"]>): Promise<WorkflowRunEvent[]> {
    const events = await reader.readRunEvents(repoId, ref, runId);
    if (!events.some(blobRef)) return events;
    const reads = await repoStore.openCommittedReads(HUB, repoId, ref);
    // Stock's blob substrate commits a spilled output at runs/<runId>/blobs/<sha>; the hub holds it only in git objects.
    const blobs = new Map((reads ? await reads.listDir(`runs/${runId}/blobs`) : []).map((entry) => [entry.name, entry.oid]));
    async function resolved(event: WorkflowRunEvent): Promise<WorkflowRunEvent> {
      const spilled = blobRef(event);
      if (spilled === undefined) return event;
      const oid = blobs.get(spilled.slice(BLOB_PREFIX.length));
      if (!reads || oid === undefined) {
        log.error("Step output {ref} of run {runId} is unreadable", { ref: spilled, runId });
        return event;
      }
      const output = `inline:${new TextDecoder().decode(await reads.readBlobByOid(oid))}`;
      return { ...event, body: { ...event.body, output: { ...asRecord(event.body["output"]), ref: output } } };
    }
    return Promise.all(events.map(resolved));
  }
  return { ...reader, readRunEvents };
}
