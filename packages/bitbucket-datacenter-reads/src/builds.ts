import { type } from "arktype";
import type { CheckRun } from "@corbits/github-reads";
import { jsonAll, type BitbucketFetch } from "./client.js";

const Build = type({ state: "string", key: "string", "name?": "string | null" });

// UNKNOWN is unconfirmed, so it counts as not finished rather than passed.
const RUNS: Record<string, Omit<CheckRun, "name">> = {
  SUCCESSFUL: { status: "completed", conclusion: "success" },
  FAILED: { status: "completed", conclusion: "failure" },
  CANCELLED: { status: "completed", conclusion: "cancelled" },
  INPROGRESS: { status: "in_progress", conclusion: null },
  UNKNOWN: { status: "queued", conclusion: null },
};

function checkRun(row: unknown): CheckRun {
  const build = Build.assert(row);
  const run = RUNS[build.state];
  if (run === undefined) throw new Error(`bitbucket build ${build.key} has an unknown state ${build.state}`);
  return { name: build.name ?? build.key, ...run };
}

/** Build statuses on a commit as GitHub check runs; the repository-scoped builds route answers only for a named key. */
export async function getChecks(bb: BitbucketFetch, sha: string): Promise<CheckRun[]> {
  return (await jsonAll(bb, `/rest/build-status/1.0/commits/${encodeURIComponent(sha)}`)).map(checkRun);
}
