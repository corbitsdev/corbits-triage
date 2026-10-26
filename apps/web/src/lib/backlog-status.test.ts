import { expect, test } from "bun:test";
import type { TriageVerdicts } from "@corbits/triage-contracts";
import { catchingUpRepos } from "./backlog-status.ts";

function pull(repo: string, source: "github" | "bitbucket-datacenter", status: "running" | "failed"): TriageVerdicts["pulls"][number] {
  return { repo, number: 1, source, activityAt: null, verdict: null, run: { runId: "run_manager", startedAt: "2026-10-07T00:00:00.000Z", status } };
}

test("a repository is catching up while a pull request of it has a manager's run going and it has no verdict yet, on its own host", () => {
  const pulls = [pull("acme/widgets", "github", "running"), pull("acme/widgets", "bitbucket-datacenter", "running"), pull("acme/gadgets", "github", "failed")];
  expect(catchingUpRepos(pulls, [])).toEqual([{ name: "acme/widgets", source: "github" }, { name: "acme/widgets", source: "bitbucket-datacenter" }]);
  expect(catchingUpRepos(pulls, [{ name: "acme/widgets", source: "github" }])).toEqual([{ name: "acme/widgets", source: "bitbucket-datacenter" }]);
});
