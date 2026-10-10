import { useMemo } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import type { PrItem } from "./hub-api.ts";
import { unranDos, withoutRan, withRan, type PendingDo, type RanDos } from "./pending-dos.ts";
import { usePortal } from "./portal.tsx";

const RAN_DOS_QUERY_KEY = "ran-dos";

function ranDosKey(tenantId: string | undefined) {
  return [RAN_DOS_QUERY_KEY, tenantId];
}

/** Kept in IndexedDB, so a reload does not offer a Do that was already sent. */
export function isRanDosQuery(query: Query): boolean {
  return query.queryKey[0] === RAN_DOS_QUERY_KEY;
}

function noneRan(): RanDos {
  return {};
}

export function usePendingDos(item: PrItem | undefined): PendingDo[] {
  const { snapshot } = usePortal();
  const { data } = useQuery({ queryKey: ranDosKey(snapshot?.workspace.tenantId), queryFn: noneRan, staleTime: Infinity, gcTime: Infinity });
  return useMemo(() => (item === undefined ? [] : unranDos(item, data ?? {})), [item, data]);
}

type RanDoMarks = { mark: (item: PrItem, key: string) => void; unmark: (item: PrItem, key: string) => void };

export function useRanDoMarks(): RanDoMarks {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useMemo(function ranDoMarks() {
    function mark(item: PrItem, key: string) {
      queryClient.setQueryData<RanDos>(ranDosKey(tenantId), (ran) => withRan(ran, item, key));
    }
    function unmark(item: PrItem, key: string) {
      queryClient.setQueryData<RanDos>(ranDosKey(tenantId), (ran) => withoutRan(ran, item, key));
    }
    return { mark, unmark };
  }, [queryClient, tenantId]);
}
