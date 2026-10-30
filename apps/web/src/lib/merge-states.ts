import { useCallback, useMemo } from "react";
import { queryOptions, skipToken, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { MAX_MERGE_STATES, type RepoSource } from "@corbits/triage-contracts";
import { createHubTransport } from "./hub-transport.ts";
import { loadMergeStates, type MergeState, type PrItem } from "./hub-api.ts";
import { mergeBlockOf } from "./inbox-pane.ts";
import { usePortal } from "./portal.tsx";

const MERGE_STATES_QUERY_KEY = "merge-states";

/** Only a pass can be listed as ready to merge. */
function asksHost(item: PrItem): item is PrItem & { number: number } {
  return !item.closed && item.number !== null && (item.verdict === "pass" || item.state === "ready");
}

export function mergeStateReads(items: PrItem[]): Array<{ repo: string; source: RepoSource; batch: number; numbers: number[] }> {
  const byHost = new Map<string, { repo: string; source: RepoSource; numbers: number[] }>();
  for (const item of items) {
    if (!asksHost(item)) continue;
    const key = `${item.source}\n${item.repo}`;
    const group = byHost.get(key) ?? { repo: item.repo, source: item.source, numbers: [] };
    group.numbers.push(item.number);
    byHost.set(key, group);
  }
  return [...byHost.values()].flatMap(function batches({ repo, source, numbers: unsorted }) {
    const numbers = unsorted.toSorted((a, b) => a - b);
    return Array.from({ length: Math.ceil(numbers.length / MAX_MERGE_STATES) }, (_, batch) => ({
      repo,
      source,
      batch,
      numbers: numbers.slice(batch * MAX_MERGE_STATES, (batch + 1) * MAX_MERGE_STATES),
    }));
  });
}

/** Keyed by host, repository and batch, not by the numbers asked, so a pull request passing keeps what is known of the others until the next read asks about it too. */
function mergeStatesQuery(tenantId: string | undefined, repo: string, source: RepoSource, batch: number, numbers: number[]) {
  return queryOptions({
    queryKey: [MERGE_STATES_QUERY_KEY, tenantId, source, repo, batch],
    queryFn: tenantId === undefined ? skipToken : async function fetchMergeStates() {
      return loadMergeStates(createHubTransport(), tenantId, repo, numbers, source);
    },
    refetchInterval: 30_000,
  });
}

function stateKey(source: RepoSource, repo: string, number: number): string {
  return `${source}\n${repo}#${number}`;
}

/** A read that failed says nothing, even of pull requests an earlier read answered. */
export function knownMergeStates(reads: Array<{ repo: string; source: RepoSource }>, results: Array<Pick<UseQueryResult<MergeState[]>, "data" | "isError">>): Map<string, MergeState> {
  return new Map(results.flatMap((result, i) => {
    const read = reads[i];
    if (read === undefined || result.isError) return [];
    return (result.data ?? []).map((state) => [stateKey(read.source, read.repo, state.number), state] as const);
  }));
}

/** The host's word on whether it would merge each pass now; a pass it has not answered for stays not known. */
export function useMergeBlocks(items: PrItem[]): PrItem[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const asked = useMemo(() => mergeStateReads(items), [items]);
  const byKey = useCallback(function byKey(results: Array<UseQueryResult<MergeState[]>>): Map<string, MergeState> {
    return knownMergeStates(asked.map(({ repo, source }) => ({ repo, source })), results);
  }, [asked]);
  const states = useQueries({ queries: asked.map(({ repo, source, batch, numbers }) => mergeStatesQuery(tenantId, repo, source, batch, numbers)), combine: byKey });
  return useMemo(function withMergeBlocks() {
    return items.map(function withMergeBlock(item) {
      const state = item.number === null ? undefined : states.get(stateKey(item.source, item.repo, item.number));
      return state === undefined ? item : { ...item, mergeable: state.mergeable, mergeBlock: mergeBlockOf(state) };
    });
  }, [items, states]);
}
