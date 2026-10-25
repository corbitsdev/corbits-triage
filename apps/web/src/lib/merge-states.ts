import { useCallback, useMemo } from "react";
import { queryOptions, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { MAX_MERGE_STATES } from "@corbits/triage-contracts";
import { createHubTransport } from "./hub-transport.ts";
import { loadMergeStates, type MergeState, type PrItem } from "./hub-api.ts";
import { mergeBlockOf } from "./inbox-pane.ts";
import { usePortal } from "./portal.tsx";

const MERGE_STATES_QUERY_KEY = "merge-states";

/** Only a pass can be listed as ready to merge. */
function asksHost(item: PrItem): item is PrItem & { number: number } {
  return !item.closed && item.number !== null && (item.verdict === "pass" || item.state === "ready");
}

export function mergeStateReads(items: PrItem[]): Array<{ repo: string; batch: number; numbers: number[] }> {
  const byRepo = new Map<string, number[]>();
  for (const item of items) {
    if (asksHost(item)) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item.number]);
  }
  return [...byRepo].flatMap(function batches([repo, unsorted]) {
    const numbers = unsorted.toSorted((a, b) => a - b);
    return Array.from({ length: Math.ceil(numbers.length / MAX_MERGE_STATES) }, (_, batch) => ({
      repo,
      batch,
      numbers: numbers.slice(batch * MAX_MERGE_STATES, (batch + 1) * MAX_MERGE_STATES),
    }));
  });
}

/** Keyed by repository and batch, not by the numbers asked, so a pull request passing keeps what is known of the others until the next read asks about it too. */
function mergeStatesQuery(tenantId: string | undefined, repo: string, batch: number, numbers: number[]) {
  return queryOptions({
    queryKey: [MERGE_STATES_QUERY_KEY, tenantId, repo, batch],
    queryFn: function fetchMergeStates() {
      return loadMergeStates(createHubTransport(), tenantId ?? "", repo, numbers);
    },
    enabled: tenantId !== undefined,
    refetchInterval: 30_000,
  });
}

function stateKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** A read that failed says nothing, even of pull requests an earlier read answered. */
export function knownMergeStates(repos: string[], results: Array<Pick<UseQueryResult<MergeState[]>, "data" | "isError">>): Map<string, MergeState> {
  return new Map(results.flatMap((result, i) => (result.isError ? [] : (result.data ?? []).map((state) => [stateKey(repos[i]!, state.number), state] as const))));
}

/** The host's word on whether it would merge each pass now; a pass it has not answered for stays not known. */
export function useMergeBlocks(items: PrItem[]): PrItem[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const asked = useMemo(() => mergeStateReads(items), [items]);
  const byKey = useCallback(function byKey(results: Array<UseQueryResult<MergeState[]>>): Map<string, MergeState> {
    return knownMergeStates(asked.map(({ repo }) => repo), results);
  }, [asked]);
  const states = useQueries({ queries: asked.map(({ repo, batch, numbers }) => mergeStatesQuery(tenantId, repo, batch, numbers)), combine: byKey });
  return useMemo(function withMergeBlocks() {
    return items.map(function withMergeBlock(item) {
      const state = item.number === null ? undefined : states.get(stateKey(item.repo, item.number));
      return state === undefined ? item : { ...item, mergeable: state.mergeable, mergeBlock: mergeBlockOf(state) };
    });
  }, [items, states]);
}
