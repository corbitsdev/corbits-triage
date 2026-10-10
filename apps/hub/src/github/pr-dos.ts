// Runs one pack Do named by the run that suggested it, so the hub, not the
// browser, decides what is written. The Do is looked up in the run's recorded
// verdict and written to GitHub at most once under its effect id.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { readPr } from "@corbits/github-tool/github";
import { ACTION_KINDS, repoPolicy } from "@corbits/triage-contracts";
import { schema } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunReader } from "@intx/hub-sessions";
import { doEffectId, type ResolvedTarget, type SuggestedDo } from "../../../../packages/triage-workflows/src/logic/actions.js";
import { DoNotRunnableError, executeDo, unrunnable } from "../../../../packages/triage-workflows/src/logic/execute-do.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import type { DoRun, DoRunStore } from "./do-run-store.js";
import { repoRecords, triageNs } from "./tenant-config.js";
import { verdictFor } from "./triage-runs.js";
import { GITHUB_VERB, githubFailed, githubRefusal } from "./github-refusal.js";
import { readJson } from "../read-json.js";

export const GITHUB_DOS_PATH = "/api/integrations/github-dos";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const Branch = type("'yes' | 'no' | 'unsure' | 'always'");

export const DoBody = type({
  runId: "string > 0",
  repo: REPO,
  number: "number.integer > 0",
  actionId: "string > 0",
  branch: Branch,
  index: "number.integer >= 0",
});

const DoQuery = type({
  repo: REPO,
  "number?": type("string.integer.parse").to("number.integer > 0"),
  "runId?": "string > 0",
});

const VerdictStep = type({
  id: "string",
  branch: Branch,
  index: "number.integer >= 0",
  kind: type.enumerated(...ACTION_KINDS),
  automatic: "boolean",
  reason: "string",
  effectId: "string",
  target: "object",
});

const MirrorRequest = type({ repo: "string", number: "number", labels: "string[]", owned: "string[]", comment: "string", close: "boolean" });

export const DoRunView = type({
  effectId: "string",
  runId: "string",
  repo: "string",
  number: "number",
  headSha: "string",
  actionId: "string",
  branch: Branch,
  index: "number",
  kind: type.enumerated(...ACTION_KINDS),
  source: "'portal' | 'workflow'",
  principalId: "string | null",
  status: "'running' | 'done' | 'satisfied' | 'failed'",
  result: "unknown",
  error: "string | null",
  attempts: "number",
  createdAt: "string",
  updatedAt: "string",
});
export const DoRunResponse = DoRunView.and({ replayed: "boolean" });
export const DoRunList = type({ dos: DoRunView.array() });

/** Writes that read as the verdict's judgement of one head; the others still hold on a later head. */
const HEAD_BOUND = new Set<SuggestedDo["kind"]>(["close", "comment"]);

export type GithubPrDosDeps = PortalCredentialDeps & {
  githubApiOrigin: string;
  runReader: Pick<WorkflowRunReader, "readRunEvents">;
  store: DoRunStore;
  log: (entry: Record<string, unknown>) => void;
};

function view(row: DoRun): typeof DoRunView.infer {
  const { tenantId: _tenantId, createdAt, updatedAt, ...rest } = row;
  return { ...rest, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

function settled(row: DoRun | undefined): row is DoRun {
  return row?.status === "done" || row?.status === "satisfied";
}

function replay(row: DoRun): Response {
  return Response.json({ ...view(row), replayed: true });
}

type Body = typeof DoBody.infer;
type Found = { step: SuggestedDo; headSha: string; request: typeof MirrorRequest.infer };

/** The Do as the verdict recorded it, with its effect id checked against the one the hub computes. */
function findDo(verdict: Record<string, unknown>, body: Body): Found | Response {
  const outdated = failure(409, "verdict_outdated", "This verdict predates Dos by reference. Run triage again.");
  if (!Array.isArray(verdict["actions"])) return outdated;
  const onBranch = (verdict["actions"] as Array<Record<string, unknown>>).filter((a) => a["id"] === body.actionId && a["branch"] === body.branch);
  const raw = onBranch.find((a) => a["index"] === body.index);
  if (!raw) return onBranch.some((a) => a["index"] === undefined) ? outdated : failure(404, "do_not_found", "The verdict has no such Do.");
  if (raw["skipped"] === true) return failure(409, "do_not_runnable", String(raw["reason"]));
  const step = VerdictStep(raw);
  const request = MirrorRequest(verdict["request"]);
  const headSha = verdict["headSha"];
  if (step instanceof type.errors || request instanceof type.errors || typeof headSha !== "string") return outdated;
  const target = step.target as ResolvedTarget;
  const effectId = doEffectId({ repo: body.repo, number: body.number, headSha, actionId: body.actionId, branch: body.branch, index: body.index, kind: step.kind, target });
  if (effectId !== step.effectId) return failure(409, "effect_mismatch", "The verdict's effect id does not match this Do.");
  const suggested = { ...step, target };
  const refused = unrunnable(suggested);
  if (refused) return failure(409, "do_not_runnable", refused);
  return { step: suggested, headSha, request };
}

export function createGithubPrDos(deps: GithubPrDosDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function runEvents(tenantId: string, domain: string, runId: string) {
    const run = await deps.db.query.workflowRun.findFirst({
      where: and(eq(schema.workflowRun.id, runId), eq(schema.workflowRun.tenantId, tenantId)),
      columns: { anchorRunId: true },
    });
    if (!run?.anchorRunId) return undefined;
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(run.anchorRunId, domain));
    return deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
  }

  async function run(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = DoBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const { repo, number } = body;
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record || !repoPolicy(record).enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");

    const events = await runEvents(tenantId, tenant.domain, body.runId);
    if (!events?.length) return failure(404, "run_not_found", "No such run in this workspace.");
    const verdict = verdictFor(events, repo, number);
    if (!verdict) return failure(404, "verdict_not_found", `The run has no verdict for ${repo}#${number}.`);
    const found = findDo(verdict, body);
    if (found instanceof Response) return found;
    const { step, headSha, request } = found;

    const prior = await deps.store.read(tenantId, step.effectId);
    if (settled(prior)) return replay(prior);

    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
    if (HEAD_BOUND.has(step.kind)) {
      let head: string;
      try {
        head = (await readPr(gh, repo, number)).sha;
      } catch (err) {
        return githubFailed(`read ${repo}#${number}`, err);
      }
      if (head !== headSha) return failure(409, "head_moved", `${repo}#${number} has new commits since this verdict. Run triage again.`);
    }

    const claimed = await deps.store.claim({
      tenantId, effectId: step.effectId, runId: body.runId, repo, number, headSha,
      actionId: body.actionId, branch: body.branch, index: body.index, kind: step.kind,
      source: "portal", principalId,
    });
    if (!claimed) {
      const current = await deps.store.read(tenantId, step.effectId);
      if (settled(current)) return replay(current);
      return failure(409, "do_in_progress", "This Do is already running.");
    }

    const logged = { tenantId, principalId, effectId: step.effectId, runId: body.runId, repo, number, actionId: body.actionId, branch: body.branch, index: body.index, kind: step.kind, attempt: claimed.attempts };
    try {
      const outcome = await executeDo(gh, { request, step });
      const row = await deps.store.settle(claimed, outcome);
      deps.log({ level: "info", msg: "github_do", ...logged, status: outcome.status, settled: row !== undefined });
      if (!row) return failure(409, "do_in_progress", "Another request took this Do over.");
      return Response.json({ ...view(row), replayed: false });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      deps.log({ level: "warn", msg: "github_do_failed", ...logged, error: cause });
      if (err instanceof DoNotRunnableError || step.kind === "agent") {
        await deps.store.fail(claimed, cause);
        return failure(409, "do_not_runnable", cause);
      }
      const message = githubRefusal(`${GITHUB_VERB[step.kind]} ${repo}#${number}`, err);
      await deps.store.fail(claimed, message);
      return failure(502, "github_failed", message);
    }
  }

  async function list(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const url = new URL(req.url);
    const query = DoQuery(Object.fromEntries(url.searchParams));
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const rows = await deps.store.list(tenantId, query);
    return Response.json({ dos: rows.map(view) });
  }

  return { run, list };
}
