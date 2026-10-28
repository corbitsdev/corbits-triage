import { type } from "arktype";
import { DEFAULT_TIMINGS, REPO_SOURCES, workflowTimings, WorkflowTimings, type RepoSource } from "@corbits/triage-contracts";
import published from "./release.json" with { type: "json" };

/** A workflow as a release publishes it: its source asset at one commit, the workspace member that is the definition and its entry. */
const PublishedWorkflow = type({ assetId: "string > 0", commitSha: "string > 0", packageName: "string > 0", entry: "string > 0" });

/** The workspace's model offerings a deployment runs on. */
const Offerings = type({ ids: type("string > 0").array().atLeastLength(1), defaultId: "string > 0" });

/** What a workflow deploys next, fixed when the release is published: the published workflow and the offerings it runs on. */
export const Release = type({ workflow: PublishedWorkflow, offerings: Offerings });
export type Release = typeof Release.infer;

const Slots = type({ "manager?": Release, "codeReview?": Release, "judge?": Release });
const slotsBySource = Object.fromEntries(REPO_SOURCES.map((source) => [`${source}?`, Slots])) as { [S in RepoSource as `${S}?`]: typeof Slots };

/**
 * What each host's listener and manager deploy, and the waits they run on: the hub writes `release.json` into each
 * published tree; a source run, or a tree published before the hub wrote waits, runs on the defaults.
 */
const Published = type({ ...slotsBySource, "timings?": WorkflowTimings });

/** The waits this release runs on. */
export const TIMINGS: WorkflowTimings = Published.assert(published).timings ?? workflowTimings(DEFAULT_TIMINGS);

/** The creator-sourced grants to deploy the published workflow: create a deployment, read exactly its asset, and read the run it starts. */
export function deployGrants({ workflow }: Release) {
  return [
    { resource: "workflow:*", action: "create", source: "creator" as const },
    { resource: `asset:${workflow.assetId}`, action: "read", source: "creator" as const },
    { resource: "workflow-run:*", action: "read", source: "creator" as const },
  ];
}

/** The host's published `which`, or undefined when `release.json` publishes none; it never throws, so every entry imports. */
export function publishedFor(source: RepoSource, which: "manager" | "codeReview" | "judge"): Release | undefined {
  return Published.assert(published)[source]?.[which];
}
