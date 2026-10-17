import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { latestCodeReview, reviewAgain } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const CODE_REVIEW_QUERY_KEY = "code-review";
const RUNNING_REFRESH_MS = 10_000;
/** A new commit or "Review again" starts a review the hub queues first, so a finished review is read again too. */
const REFRESH_MS = 30_000;

type Pull = { repo: string; source: RepoSource; number: number };

/** The pull request's latest code review, read again more often while one runs. */
export function useCodeReview({ repo, source, number }: Pull) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  async function fetchReview() {
    return latestCodeReview(createHubTransport(), tenantId as string, { name: repo, source }, number);
  }
  return useQuery({
    queryKey: [CODE_REVIEW_QUERY_KEY, tenantId, source, repo, number],
    queryFn: fetchReview,
    enabled: tenantId !== undefined,
    refetchInterval: (query) => (query.state.data?.review?.status === "running" ? RUNNING_REFRESH_MS : REFRESH_MS),
  });
}

/** "Review again", then the review is read again so its running state shows. */
export function useReviewAgain({ repo, source, number }: Pull) {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: function sendAgain() {
      return reviewAgain(createHubTransport(), tenantId as string, { name: repo, source }, number);
    },
    onSuccess: function readAgain() {
      return queryClient.invalidateQueries({ queryKey: [CODE_REVIEW_QUERY_KEY, tenantId, source, repo, number] });
    },
  });
}
