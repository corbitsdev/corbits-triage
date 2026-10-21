import { type } from "arktype";
import { resolveTenantSidecarCapabilityPolicies, type DB } from "@intx/db";
import type { SidecarPluginRegistry } from "@intx/hub-sessions";
import { CODE_REVIEW_PLACEMENT } from "@corbits/pr-code-review/pr-code-review";
import { REPO_SOURCES, type CodeReviewPlace, type CodeReviewPlaceOption, type PlaceGuide, type RepoSource } from "@corbits/triage-contracts";
import { failure } from "./github/portal-credential.js";
import { connectedSources, hasCodeReviewKey } from "./github/source-workflow.js";
import { tenantConfigOf } from "./github/bridge.js";
import { patchCorbitsTriage, repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import type { CodeReviewFeed, Offered } from "./code-review-feed.js";
import type { Member } from "./integrations/app.js";

export const CODE_REVIEW_PATH = "/api/integrations/code-review";

const Source = type.enumerated(...REPO_SOURCES);

export const CodeReviewBody = type({ repo: "string > 0", "source?": Source, enabled: "boolean" });
export const CodeReviewSet = type({ repo: "string", source: Source, codeReview: "boolean" });
export const CodeReviewRunBody = type({ repo: "string > 0", "source?": Source, number: "number.integer > 0" });
export const CodeReviewQueued = type({ status: "'queued'" });

/** The id of the provisioner a workspace's code review deploys to; null when Interchange would refuse it with `provisioner_no_match`. */
export type PlaceCodeReview = (tenantId: string) => Promise<string | null>;

/** Stock's own selection, with the workspace's sidecar placement policies and code review's requirement. */
export function createCodeReviewPlacement(db: DB["db"], plugins: Pick<SidecarPluginRegistry, "selectProvisioner">): PlaceCodeReview {
  return async function placeCodeReview(tenantId: string): Promise<string | null> {
    const selection = await plugins.selectProvisioner({
      tenantPolicies: await resolveTenantSidecarCapabilityPolicies(db, tenantId),
      workflowRules: CODE_REVIEW_PLACEMENT.capabilities,
    });
    return selection.ok ? selection.provisioner.id : null;
  };
}

const GUIDES = "https://github.com/corbitsdev/corbits-triage/blob/main/docs/provisioners";

/** A place and what boot found there: undefined when it is not set up, why it could not be registered, or what was. */
export type PlaceProbe = { readonly guide: PlaceGuide; readonly found: { readonly provisioner: { readonly id: string } } | string | undefined };

function placeOption({ guide, found }: PlaceProbe, active: string | null, showReason: boolean): CodeReviewPlaceOption {
  const option = { ...guide, guide: `${GUIDES}/${guide.guide}` };
  if (found === undefined) return { ...option, state: "not_set_up" };
  if (typeof found === "string") return { ...option, state: "failing", ...(showReason && { reason: found }) };
  return { ...option, state: found.provisioner.id === active ? "active" : "ready" };
}

type CodeReviewPlaceDeps = Pick<CodeReviewDeps, "authorize" | "place"> & { probes: readonly PlaceProbe[]; prWorkflowSources: (tenantId: string) => Promise<RepoSource[]> };

/** A failing place's reason names the server's own setup, so only those who may manage the workspace see it. */
export function createCodeReviewPlace(deps: CodeReviewPlaceDeps) {
  return async function codeReviewPlace({ tenantId, principalId }: Member): Promise<Response> {
    const [provisioner, manages, prWorkflow] = await Promise.all([deps.place(tenantId), deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"), deps.prWorkflowSources(tenantId)]);
    return Response.json({ provisioner, places: deps.probes.map((probe) => placeOption(probe, provisioner, manages)), prWorkflow } satisfies CodeReviewPlace);
  };
}

const REFUSED: Record<Exclude<Offered, "sent">, { code: string; message: string }> = {
  not_reviewed: { code: "code_review_off", message: "Code review is off for this repository, or the Anthropic key is missing." },
  draft: { code: "draft", message: "The pull request is a draft; code review starts once it is ready." },
  not_open: { code: "not_open", message: "The pull request is not open." },
};

type CodeReviewDeps = {
  db: DB["db"];
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  /** After a change: a host's code review deployment is released once none of its repositories has it on. */
  onChanged: (tenantId: string) => Promise<void>;
  place: PlaceCodeReview;
  /** Whether the repository's policy file needs the PR workflow, whose code review follows the file. */
  inPrWorkflow: (tenantId: string, repo: string, source: RepoSource) => Promise<boolean>;
};

const HOST_NAMES = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" } as const;

function noPlace(): Response {
  return failure(409, "no_isolated_place", "Code review needs an isolated place to run, and this server has none set up yet.");
}

function fileDecides(then: string): Response {
  return failure(409, "policy_file_decides", `This repository's policy file decides code review, which runs with triage. ${then}`);
}

/** Turns code review on or off for one repository; on needs its host connected and a code review provider's key. */
export function createCodeReviewSwitch(deps: CodeReviewDeps) {
  return async function setCodeReview(body: typeof CodeReviewBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    if (!(await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"))) {
      return failure(403, "forbidden", "You do not have permission to manage this workspace.");
    }
    const source = body.source ?? "github";
    if (await deps.inPrWorkflow(tenantId, body.repo, source)) return fileDecides("Change `code-review` in the file instead.");
    if (body.enabled && (await deps.place(tenantId)) === null) return noPlace();
    if (body.enabled && !(await connectedSources(deps.db, tenantId)).includes(source)) {
      return failure(409, "source_not_connected", `Connect ${HOST_NAMES[source]} before turning on code review.`);
    }
    if (body.enabled && !(await hasCodeReviewKey(deps.db, tenantId))) {
      return failure(409, "anthropic_key_missing", "Save an Anthropic key in Settings before turning on code review.");
    }
    function isRepo(record: RepoRecord): boolean {
      return record.name === body.repo && sourceOf(record) === source;
    }
    function setRepo(record: RepoRecord): RepoRecord {
      return isRepo(record) ? { ...record, codeReview: body.enabled } : record;
    }
    const stored = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).find(isRepo);
    if (!stored) return failure(404, "repo_not_found", "The workspace has no such repository.");
    if (body.enabled && !stored.connected) return failure(409, "repo_not_connected", `${body.repo} is no longer connected to ${HOST_NAMES[source]}.`);
    const written = await patchCorbitsTriage(deps.db, tenantId, function setRepoCodeReview(ns) {
      const repos = repoRecords(ns);
      return repos.some(isRepo) ? { ...ns, repos: repos.map(setRepo) } : undefined;
    });
    if (!written || !repoRecords(written).some(isRepo)) return failure(404, "repo_not_found", "The workspace has no such repository.");
    await deps.onChanged(tenantId);
    return Response.json({ repo: body.repo, source, codeReview: body.enabled });
  };
}

type CodeReviewRunDeps = Pick<CodeReviewDeps, "db" | "authorize" | "place" | "inPrWorkflow"> & { feed: Pick<CodeReviewFeed, "again"> };

/** "Review again": reviews the pull request's current head once more. */
export function createCodeReviewRun(deps: CodeReviewRunDeps) {
  return async function runCodeReview(body: typeof CodeReviewRunBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    if (!(await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"))) {
      return failure(403, "forbidden", "You do not have permission to manage this workspace.");
    }
    if ((await deps.place(tenantId)) === null) return noPlace();
    const source = body.source ?? "github";
    const record = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).find((row) => row.name === body.repo && sourceOf(row) === source && row.connected);
    if (!record) return failure(404, "repo_not_found", "The workspace has no such connected repository.");
    if (await deps.inPrWorkflow(tenantId, record.name, source)) return fileDecides("Press Triage again to review the latest commit.");
    let offered: Offered;
    try {
      offered = await deps.feed.again(tenantId, record, body.number);
    } catch (err) {
      return failure(502, "code_review_unavailable", `Could not send the pull request to code review: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (offered !== "sent") return failure(409, REFUSED[offered].code, REFUSED[offered].message);
    return Response.json({ status: "queued" }, { status: 202 });
  };
}
