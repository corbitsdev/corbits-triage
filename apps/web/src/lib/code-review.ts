import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { latestCodeReview, reviewAgain } from "./hub-api.ts";
import { GITHUB_PULL_QUERY_KEY } from "./github-pull.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const CODE_REVIEW_QUERY_KEY = "code-review";
const RUNNING_REFRESH_MS = 10_000;
/** A new commit or "Review again" starts a review the hub queues first, so a finished review is read again too. */
const REFRESH_MS = 30_000;

type Pull = { repo: string; source: RepoSource; number: number };

/** The pull request's latest code review, and whether it stands for `headSha` too, read again more often while one runs. */
export function useCodeReview({ repo, source, number, headSha }: Pull & { headSha: string | null }) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  async function fetchReview() {
    return latestCodeReview(createHubTransport(), tenantId as string, { name: repo, source }, number, headSha);
  }
  return useQuery({
    queryKey: [CODE_REVIEW_QUERY_KEY, tenantId, source, repo, number, headSha],
    queryFn: fetchReview,
    enabled: tenantId !== undefined,
    refetchInterval: (query) => (query.state.data?.review?.status === "running" ? RUNNING_REFRESH_MS : REFRESH_MS),
  });
}

/** Sends the review of `headSha` to the pull request on GitHub, then reads the pull request again so the sent review shows. */
export function useSendCodeReview({ repo, number }: Pull) {
  const { snapshot, writeGithub } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: function sendToGithub(headSha: string) {
      return writeGithub({ action: "code-review", repo, number, headSha }, "now");
    },
    onSuccess: function readPullAgain() {
      return queryClient.invalidateQueries({ queryKey: [GITHUB_PULL_QUERY_KEY, tenantId, repo, number] });
    },
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
