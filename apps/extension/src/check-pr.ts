import { errorText } from "@corbits/common";
import { getPostedCodeReview, type GithubFetch } from "@corbits/github-reads";
import type { GithubApi } from "./github-api.ts";
import type { PolicyRead } from "./policy-source.ts";
import { prKey, type PrRef } from "./pr.ts";
import { plansOf, runChecks } from "./run-checks.ts";
import type { TriageView } from "./view.ts";

export type Pull = { headSha: string; labels: string[] };

export async function pullOf(api: GithubApi, pr: PrRef): Promise<Pull> {
  const res = await api.gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  if (!res.ok) throw new Error(`GitHub did not return ${prKey(pr)} (${res.status}).`);
  const pull = (await res.json()) as { head: { sha: string }; labels: Array<{ name: string }> };
  return { headSha: pull.head.sha, labels: pull.labels.map((label) => label.name) };
}

/** A code review that cannot be read is said so beside the checks rather than failing them. */
async function readCodeReview(gh: GithubFetch, { repo, number }: PrRef): Promise<TriageView["codeReview"]> {
  try {
    return { review: await getPostedCodeReview(gh, repo, number) };
  } catch (cause) {
    return { error: errorText(cause) };
  }
}

/** The pull request against its policy; one carrying the policy's pause label is not checked, as the hub would not triage it. */
export async function checkPr(api: GithubApi, pr: PrRef, pull: Pull, policy: PolicyRead | null): Promise<TriageView> {
  const base = { pr, headSha: pull.headSha, ranAt: new Date().toISOString(), checks: [], notes: [], plans: [] };
  if (!policy) return { ...base, policy: null, codeReview: { review: null } };
  const file = { path: policy.path, url: policy.url };
  const plans = plansOf(policy.pack);
  const { pauseLabel } = policy.workflow;
  if (pauseLabel !== undefined && pull.labels.includes(pauseLabel)) return { ...base, policy: file, paused: pauseLabel, plans, codeReview: { review: null } };
  const [checked, codeReview] = await Promise.all([runChecks(pr, api.gh, policy.pack), readCodeReview(api.gh, pr)]);
  return { ...base, ...checked, policy: file, plans, codeReview };
}
