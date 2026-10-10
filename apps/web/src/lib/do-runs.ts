import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { listDoRuns, runPackDo, type DoRef, type DoRun, type PrItem } from "./hub-api.ts";
import { createHubTransport, createLeavingHubTransport } from "./hub-transport.ts";
import { pendingDos, type PendingDo } from "./pending-dos.ts";
import { usePortal } from "./portal.tsx";

const DO_RUNS_QUERY_KEY = "do-runs";
const HELD_DOS_QUERY_KEY = ["held-dos"];

function doRunsKey(tenantId: string | undefined, repo: string, number: number | null) {
  return [DO_RUNS_QUERY_KEY, tenantId, repo, number];
}

/** The hub's records are durable, so they are kept in IndexedDB and a reload hides sent Dos before the hub answers. */
export function isDoRunsQuery(query: Query): boolean {
  return query.queryKey[0] === DO_RUNS_QUERY_KEY;
}

function noneHeld(): string[] {
  return [];
}

/** Effect ids of Dos waiting for Undo, kept above the pane so switching pull requests does not offer them again. */
function useHeldDoKeys(): string[] {
  const { data } = useQuery({ queryKey: HELD_DOS_QUERY_KEY, queryFn: noneHeld, staleTime: Infinity, gcTime: Infinity });
  return data ?? [];
}

type HeldDos = { hold: (key: string) => void; release: (key: string) => void };

export function useHeldDos(): HeldDos {
  const queryClient = useQueryClient();
  return useMemo(function heldDos() {
    function hold(key: string) {
      queryClient.setQueryData<string[]>(HELD_DOS_QUERY_KEY, (held) => [...(held ?? []), key]);
    }
    function release(key: string) {
      queryClient.setQueryData<string[]>(HELD_DOS_QUERY_KEY, (held) => (held ?? []).filter((heldKey) => heldKey !== key));
    }
    return { hold, release };
  }, [queryClient]);
}

/** Until the hub's records arrive, every Do the verdict suggests is offered; a sent one is replayed rather than written twice. */
export function usePendingDos(item: PrItem | undefined): PendingDo[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const repo = item?.repo ?? "";
  const number = item?.number ?? null;
  async function fetchDoRuns() {
    return listDoRuns(createHubTransport(), tenantId as string, repo, number as number);
  }
  const { data } = useQuery({ queryKey: doRunsKey(tenantId, repo, number), queryFn: fetchDoRuns, enabled: tenantId !== undefined && number !== null });
  const held = useHeldDoKeys();
  return useMemo(() => (item === undefined ? [] : pendingDos(item, data ?? [], new Set(held))), [item, data, held]);
}

/** `leaving` sends a held Do as the page goes away, so the request must outlive it. The returned record replaces the cached one before the list is read again. */
export function useRunDo(): (ref: DoRef, leaving: boolean) => Promise<DoRun> {
  const { snapshot, refresh } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useCallback(async function runDo(ref: DoRef, leaving: boolean) {
    if (tenantId === undefined) throw new Error("The workspace is not loaded yet.");
    const queryKey = doRunsKey(tenantId, ref.repo, ref.number);
    try {
      const run = await runPackDo(leaving ? createLeavingHubTransport() : createHubTransport(), tenantId, ref);
      queryClient.setQueryData<DoRun[]>(queryKey, (runs) => [run, ...(runs ?? []).filter((row) => row.effectId !== run.effectId)]);
      refresh();
      return run;
    } finally {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient, refresh, tenantId]);
}
