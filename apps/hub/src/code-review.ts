import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { resolveTenantSidecarCapabilityPolicies, type DB } from "@intx/db";
import type { SidecarPluginRegistry } from "@intx/hub-sessions";
import { CODE_REVIEW_PLACEMENT } from "@corbits/pr-code-review/pr-code-review";
import { errorText } from "@corbits/common";
import { EVERYONE, REPO_SOURCES, triageStopped, VERDICTS, type CodeReviewPlace, type CodeReviewPlaceOption, type PlaceGuide } from "@corbits/triage-contracts";
import { githubLimited } from "./github/github-refusal.js";
import { failure } from "./github/portal-credential.js";
import { hasCodeReviewKey } from "./github/source-workflow.js";
import { mailPayload, tenantConfigOf } from "./github/bridge.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import type { PullRequestHead } from "./pull-request-reader.js";
import type { PolicyReader } from "./github/check-pack-store.js";
import { NoLiveDeploymentError } from "./github/deployment.js";
import { triageInputs } from "./github/pr-triage.js";
import type { Member } from "./integrations/app.js";

export const CODE_REVIEW_PATH = "/api/integrations/code-review";

const Source = type.enumerated(...REPO_SOURCES);

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

function envName(line: string): string {
  const at = line.indexOf("=");
  if (at <= 0) throw new Error("a place .env line has no variable name");
  return line.slice(0, at);
}

/** Variable names the places declare, in place order, with no duplicates. */
function declaredEnvNames(guides: readonly Pick<PlaceGuide, "env">[]): string[] {
  const names: string[] = [];
  for (const guide of guides) {
    for (const line of guide.env) {
      const name = envName(line);
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * One boot line when no isolated place is registered. The hub still starts and triage still runs.
 * The line names the variables the places declare and docs/provisioners/, and does not choose a place.
 */
export function isolatedPlaceBootWarning(registered: boolean, guides: readonly Pick<PlaceGuide, "env">[]): { level: "warn"; msg: "code_review_no_isolated_place"; reason: string } | undefined {
  if (registered) return undefined;
  const declared = declaredEnvNames(guides);
  if (declared.length === 0) throw new Error("isolated places declare no environment variables");
  return {
    level: "warn",
    msg: "code_review_no_isolated_place",
    reason: `Code review needs an isolated place to run. Environment variables the places declare: ${declared.join(", ")}. See docs/provisioners/.`,
  };
}

function placeOption({ guide, found }: PlaceProbe, active: string | null, showReason: boolean): CodeReviewPlaceOption {
  const option = { ...guide, guide: `${GUIDES}/${guide.guide}` };
  if (found === undefined) return { ...option, state: "not_set_up" };
  if (typeof found === "string") return { ...option, state: "failing", ...(showReason && { reason: found }) };
  return { ...option, state: found.provisioner.id === active ? "active" : "ready" };
}

type CodeReviewPlaceDeps = Pick<CodeReviewDeps, "authorize" | "place"> & { probes: readonly PlaceProbe[] };

/** A failing place's reason names the server's own setup, so only those who may manage the workspace see it. */
export function createCodeReviewPlace(deps: CodeReviewPlaceDeps) {
  return async function codeReviewPlace({ tenantId, principalId }: Member): Promise<Response> {
    const [provisioner, manages] = await Promise.all([deps.place(tenantId), deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage")]);
    return Response.json({ provisioner, places: deps.probes.map((probe) => placeOption(probe, provisioner, manages)) } satisfies CodeReviewPlace);
  };
}

type CodeReviewDeps = {
  db: DB["db"];
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  place: PlaceCodeReview;
};

function noPlace(): Response {
  return failure(409, "no_isolated_place", "Code review needs an isolated place to run, and this server has none set up yet.");
}

type CodeReviewRunDeps = Pick<CodeReviewDeps, "db" | "authorize" | "place"> & {
  readCheckPack: PolicyReader;
  /** The pull request as its host shows it now, without its diff. */
  readHead: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestHead>;
  /** Hands the mail to the host's listener, whose manager deploys the review. */
  send: (tenantId: string, payload: unknown) => Promise<void>;
};

/** Code review as "Review again" asks for it: on, whatever the policy's own scope says, and named as a review of its own. */
function reviewNow() {
  return { on: true, for: [EVERYONE], triage: [...VERDICTS], rules: "any", again: randomUUID() };
}

/** "Review again": triages the pull request's current head with code review on, so its manager reviews it once more. */
export function createCodeReviewRun(deps: CodeReviewRunDeps) {
  return async function runCodeReview(body: typeof CodeReviewRunBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    if (!(await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"))) {
      return failure(403, "forbidden", "You do not have permission to manage this workspace.");
    }
    if ((await deps.place(tenantId)) === null) return noPlace();
    if (!(await hasCodeReviewKey(deps.db, tenantId))) return failure(409, "anthropic_key_missing", "Save an Anthropic key in Settings before reviewing again.");
    const source = body.source ?? "github";
    const record = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).find((row) => row.name === body.repo && sourceOf(row) === source && row.connected);
    if (!record) return failure(404, "repo_not_found", "The workspace has no such connected repository.");
    const inputs = await triageInputs(deps, tenantId, record);
    if (inputs instanceof Response) return inputs;
    try {
      const pull = await deps.readHead(tenantId, record, body.number);
      if (!pull.open) return failure(409, "not_open", "The pull request is not open.");
      if (pull.draft) return failure(409, "draft", "The pull request is a draft; code review starts once it is ready.");
      const payload = mailPayload(record, inputs.policy, inputs.pack, { prNumber: body.number, headSha: pull.headSha, noWait: true });
      await deps.send(tenantId, { ...payload, codeReview: reviewNow() });
    } catch (err) {
      if (err instanceof NoLiveDeploymentError) return failure(503, "service_not_running", triageStopped(source));
      return githubLimited(err) ?? failure(502, "code_review_unavailable", `Could not send the pull request to code review: ${errorText(err)}`);
    }
    return Response.json({ status: "queued" }, { status: 202 });
  };
}
