import { type } from "arktype";
import type { RepoSource } from "@corbits/triage-contracts";

/** A workflow as a release publishes it: its source asset at one commit, the workspace member that is the definition and its entry. */
const PublishedWorkflow = type({ assetId: "string > 0", commitSha: "string > 0", packageName: "string > 0", entry: "string > 0" });

/** The workspace's model offerings a deployment runs on. */
const Offerings = type({ ids: type("string > 0").array().atLeastLength(1), defaultId: "string > 0" });

/** What a workflow deploys next, fixed when the release is published: the published workflow and the offerings it runs on. */
export const Release = type({ workflow: PublishedWorkflow, offerings: Offerings });
export type Release = typeof Release.infer;

/** What each host's listener and manager deploy, set by the release build to what the workspace published; a source run has none. */
declare const TRIAGE_RELEASE: Partial<Record<RepoSource, { manager?: Release; codeReview?: Release }>> | undefined;

export function publishedFor(source: RepoSource): { manager?: Release; codeReview?: Release } | undefined {
  return typeof TRIAGE_RELEASE === "undefined" ? undefined : TRIAGE_RELEASE[source];
}
