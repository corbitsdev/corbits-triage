import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { approveHeldDo, type HeldDoRef } from "./hub-api.ts";
import { createHubTransport, createLeavingHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const HIDDEN_DOS_QUERY_KEY = "hidden-dos";
const SENT_DOS_QUERY_KEY = ["sent-dos"];

function hiddenKey(tenantId: string | undefined) {
  return [HIDDEN_DOS_QUERY_KEY, tenantId];
}

/** Skip hides a Do for this browser only, so the hidden ones are kept in IndexedDB across reloads. */
export function isHiddenDosQuery(query: Query): boolean {
  return query.queryKey[0] === HIDDEN_DOS_QUERY_KEY;
}

function none(): string[] {
  return [];
}

function useKeys(queryKey: unknown[]): string[] {
  const { data } = useQuery({ queryKey, queryFn: none, staleTime: Infinity, gcTime: Infinity });
  return data ?? [];
}

type HeldDoKeys = {
  /** Hides a Do, by its `sentKey`, while its approval waits for Undo or for its run's outcome; `release` offers it again. */
  hold: (key: string) => void;
  release: (key: string) => void;
  hide: (key: string) => void;
};

export function useHeldDoKeys(): HeldDoKeys {
  const queryClient = useQueryClient();
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useMemo(function heldDoKeys() {
    function add(queryKey: unknown[], key: string) {
      queryClient.setQueryData<string[]>(queryKey, (keys) => [...(keys ?? []), key]);
    }
    function hold(key: string) {
      add(SENT_DOS_QUERY_KEY, key);
    }
    function release(key: string) {
      queryClient.setQueryData<string[]>(SENT_DOS_QUERY_KEY, (keys) => (keys ?? []).filter((held) => held !== key));
    }
    function hide(key: string) {
      add(hiddenKey(tenantId), key);
    }
    return { hold, release, hide };
  }, [queryClient, tenantId]);
}

export type DecidedDoKeys = { hidden: ReadonlySet<string>; sent: ReadonlySet<string> };

export function useDecidedDoKeys(): DecidedDoKeys {
  const { snapshot } = usePortal();
  const hidden = useKeys(hiddenKey(snapshot?.workspace.tenantId));
  const sent = useKeys(SENT_DOS_QUERY_KEY);
  return useMemo(() => ({ hidden: new Set(hidden), sent: new Set(sent) }), [hidden, sent]);
}

/** `leaving` sends the approval as the page goes away, so the request must outlive it. */
export function useApproveDo(): (ref: HeldDoRef, leaving: boolean) => Promise<void> {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useCallback(async function approveDo(ref: HeldDoRef, leaving: boolean) {
    if (tenantId === undefined) throw new Error("The workspace is not loaded yet.");
    await approveHeldDo(leaving ? createLeavingHubTransport() : createHubTransport(), tenantId, ref);
  }, [tenantId]);
}
