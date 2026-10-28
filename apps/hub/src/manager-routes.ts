// The routes a pull request's manager run and its reviewers reach with their run token. The caller's run is the run
// token's principal, never a field of the body, so a run can only take, finish or report as itself.
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import { schema, type DB } from "@intx/db";
import type { RequireGrant, RunTokenRoute, TenantEnv } from "@intx/hub-api";
import { asRecord } from "@corbits/common";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE, REPO_SOURCES, StageResult, type RepoSource } from "@corbits/triage-contracts";
import { failure } from "./github/portal-credential.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { body, Failure, json } from "./route-schema.js";
import type { Tx } from "./github/admin-github-grant.js";
import { recordApproved, replaceVerdict } from "./github/verdict-record-store.js";
import { doResultsOf, eventOf, mirrorOutcomesOf, ruledOf, summaryOf, withResults } from "./github/verdict-row.js";
import { done, EventState, PassState, recordResult, ReviewerState, take, type Closing, type PassReport, type PullRequestRef } from "./manager-state.js";

const TAKE_PATH = "/manager/take";
const DONE_PATH = "/manager/done";
const REVIEWER_RESULT_PATH = "/manager/reviewer-result";

export const MANAGER_RUN_TOKEN_ROUTES: readonly RunTokenRoute[] = [
  { method: "POST", path: `/api/tenants/:tenantId${TAKE_PATH}` },
  { method: "POST", path: `/api/tenants/:tenantId${DONE_PATH}` },
  { method: "POST", path: `/api/tenants/:tenantId${REVIEWER_RESULT_PATH}` },
];

const PullRequest = type({ source: type.enumerated(...REPO_SOURCES), repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });
/**
 * What the pass did on its head: triaged it, with a reviewer still out, or posted a verdict, given as its evaluate,
 * mirror, execute and rules steps output it. A pass that triaged nothing reports nothing.
 */
const Report = type({
  head: "string > 0",
  // A pass that triaged a head still waiting for CI while a reviewer is out, so it posted no verdict.
  "waiting?": "true",
  "verdict?": "Record<string, unknown>",
  "mirror?": "Record<string, unknown>",
  "executed?": "Record<string, unknown>",
  "rules?": "Record<string, unknown>",
});
/** `approvals` is the pass's approved Dos as its approvals step ran them; `wait` that the pass's head still awaits CI or a reviewer. */
const DoneBody = PullRequest.and({ reviewers: ReviewerState.array(), "wait?": "boolean", "report?": Report, "approvals?": { results: "Record<string, unknown>[]" } });
const ReviewerResultBody = PullRequest.and(StageResult);

const Latest = { "request?": "Record<string, unknown>", reviewers: ReviewerState.array(), "waitingSince?": "string", "headSince?": "string", claimedAt: "string" } as const;
const Taken = type({ outcome: "'idle'", ...Latest }).or({ outcome: "'pass'", pass: PassState, events: type({ key: "string", event: EventState }).array(), resumed: "boolean", ...Latest });
const Done = type({ outcome: "'ended'" }).or({ outcome: "'more'", wait: "boolean" });
const Recorded = type({ recorded: "boolean" });

const TAGS = ["manager"];
const TOO_LARGE = `The body is over ${MAX_BODY_BYTES / 1024 / 1024} MiB.`;
const NOT_MANAGER = "`not_manager`: the pull request's claim does not name the calling run as its live manager.";

const refusals = {
  400: json("Invalid request", Failure),
  401: json("No valid run token", Failure),
  403: json("Not a workflow run, or the run lacks `write` on `triage-manager:state`", Failure),
  413: json(`\`too_large\`: ${TOO_LARGE}`, Failure),
};

function refused(): Response {
  return failure(409, "not_manager", "The pull request's claim does not name this run.");
}

type RunEnv = TenantEnv & { Variables: TenantEnv["Variables"] & { runId: string } };

export type ManagerRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
  log: (entry: Record<string, unknown>) => void;
  /** Wakes the pull request's manager for a reviewer result, as a host event does; false when the workspace has no listener for the host. */
  wake: (tenantId: string, pr: PullRequestRef, head: string) => Promise<boolean>;
  /** Stops the pull request's reviewers on a head older than its newest and takes them off the claim; never throws. */
  supersede: (tenantId: string, pr: PullRequestRef) => Promise<void>;
  /** Notes that a manager of the host took a pull request, so the hub knows its managers still run. */
  taken: (tenantId: string, source: RepoSource, at: string) => void;
};

type Reported = typeof Report.infer;

/** The verdict the pass posted, with the outcomes of the Dos it ran. */
function postedOf(report: Reported | undefined): Record<string, unknown> | undefined {
  return report?.verdict && withResults(report.verdict, doResultsOf(report.executed));
}

/** What done keeps on the closed pass: whether its verdict waits for the host's checks, or the mirror request of its verdict. */
function passReport(report: Reported | undefined, posted: Record<string, unknown> | undefined): PassReport | undefined {
  if (!report) return undefined;
  if (posted?.["waiting"] === true || report.waiting === true) return { head: report.head, waiting: true };
  const request = asRecord(posted?.["request"]);
  return { head: report.head, ...(request && { request }) };
}

export function createManagerRoutes({ db, requireGrant, log, wake, supersede, taken }: ManagerRoutesDeps) {
  const app = new Hono<RunEnv>();
  // Hono throws on a body that is not JSON; it keeps the hub's error envelope.
  app.onError(function onError(err) {
    if (err instanceof HTTPException && err.status === 400) return failure(400, "invalid_request", err.message);
    if (err instanceof HTTPException) return err.getResponse();
    log({ level: "error", msg: "manager_route_failed", error: String(err) });
    return failure(500, "internal", "Internal error.");
  });
  const limited = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: function tooLarge() { return failure(413, "too_large", TOO_LARGE); } });
  const asRun = createMiddleware<RunEnv>(async function asRun(c, next) {
    const principal = c.get("principal");
    const [run] = await db.select({ id: schema.workflowRun.id }).from(schema.workflowRun)
      .where(and(eq(schema.workflowRun.id, principal.refId), eq(schema.workflowRun.principalId, principal.id), eq(schema.workflowRun.tenantId, principal.tenantId)));
    if (!run) return failure(403, "forbidden", "Only a workflow run may call this route.");
    c.set("runId", run.id);
    await next();
  });
  const granted = requireGrant(MANAGER_STATE_RESOURCE, MANAGER_STATE_ACTION);
  const reports = requireGrant(MANAGER_RESULT_RESOURCE, MANAGER_RESULT_ACTION);

  app.post(
    TAKE_PATH,
    describeRoute({
      summary: "Take the pull request's pending events as its manager",
      description: `Run token only. Claims the pull request for the calling run when no live run holds it. Answers the open pass again (\`resumed\`), or a new pass on the newest head over every pending event no other request holds, or \`idle\`; either way with the reviewers the last done recorded, \`request\`, the newest pull request mail the hub recorded, \`waitingSince\`, when the passes on the head began waiting for its CI while the last of them still does, \`headSince\`, when the head's first closed pass was taken, and \`claimedAt\`, when the calling run claimed the pull request. ${NOT_MANAGER}`,
      tags: TAGS,
      responses: { 200: json("The pass to work on, or idle", Taken), ...refusals, 409: json(NOT_MANAGER, Failure) },
    }),
    limited,
    asRun,
    granted,
    body(PullRequest),
    async function takeEvents(c) {
      const pr = c.req.valid("json");
      const result = await take(db, c.get("tenant").id, pr, c.get("runId"));
      if (result.outcome === "refused") return refused();
      taken(c.get("tenant").id, pr.source, new Date().toISOString());
      return c.json(result);
    },
  );

  app.post(
    DONE_PATH,
    describeRoute({
      summary: "Close the manager's pass and record its reviewers and its verdict",
      description: `Run token only. In the same transaction, a \`report\` of a verdict the pass posted is recorded as the run's verdict on the pull request, replacing one the run recorded before, and \`approvals\` sets each approved Do's outcome on the verdicts that suggest it. A reviewer the claim recorded that ran past its deadline with no result and that \`reviewers\` no longer waits for is logged. Each reviewer the claim then holds on a head older than the newest a pull request mail named, as one the pass deployed while a push arrived, is stopped and taken off the claim. \`more\`: an event is pending, so the manager takes again at once, or the pass asked to \`wait\` because its head still awaits CI or a reviewer, so it takes again after polling. \`ended\`: otherwise, as once the head has its final verdict; the claim ended and the run should end, and a later event starts the next manager. ${NOT_MANAGER}`,
      tags: TAGS,
      responses: { 200: json("Whether the manager is done", Done), ...refusals, 409: json(NOT_MANAGER, Failure) },
    }),
    limited,
    asRun,
    granted,
    body(DoneBody),
    async function finishPass(c) {
      const { reviewers, wait, report, approvals, ...pr } = c.req.valid("json");
      const tenantId = c.get("tenant").id;
      const runId = c.get("runId");
      const posted = postedOf(report);
      const kept = passReport(report, posted);
      async function recordPass(tx: Tx, closing: Closing | undefined): Promise<void> {
        if (posted && closing && !kept?.waiting) {
          const event = closing.mail && eventOf(closing.mail);
          const trigger = { ...pr, headSha: closing.head, startedAt: closing.startedAt, ...(event !== undefined && { event }) };
          const summary = summaryOf(posted, new Date().toISOString(), trigger, mirrorOutcomesOf(report?.mirror), ruledOf(report?.rules).get(`${pr.repo}#${pr.number}`));
          if (summary) await replaceVerdict(tx, tenantId, { runId, repo: pr.repo, number: pr.number, headSha: closing.head, startedAt: new Date(closing.startedAt), ...summary, runStatus: "completed" });
        }
        const approved = approvals === undefined ? [] : approvals.results.flatMap((ran) => [...doResultsOf(ran).values()].map((outcome) => ({ repo: pr.repo, number: pr.number, ...outcome })));
        await recordApproved(tx, tenantId, approved);
      }
      const result = await done(db, tenantId, pr, runId, reviewers, { ...(wait !== undefined && { wait }), ...(kept && { report: kept }), record: recordPass, log });
      if (result.outcome === "refused") return refused();
      await supersede(tenantId, pr);
      return c.json(result);
    },
  );

  app.post(
    REVIEWER_RESULT_PATH,
    describeRoute({
      summary: "Record a reviewer's result for the pull request's manager",
      description: "Run token only, for a reviewer granted `create` on `triage-manager:result`, which reaches no other manager route. The body is a `StageResult`. A result for a head the pull request has moved past is dropped and logged, and `recorded` is false. Otherwise the event is recorded under the calling run's id, so `recorded` is false when that run reported before, and the pull request's manager is woken as a host event wakes it: its live manager is mailed, or the host's listener deploys one, whose take collects the result. When that wake fails the result stays recorded, the route answers `wake_failed`, and the hub's next reconcile pass wakes a manager for it.",
      tags: TAGS,
      responses: {
        200: json("Whether the result was recorded now", Recorded),
        ...refusals,
        403: json("Not a workflow run, or the run lacks `create` on `triage-manager:result`", Failure),
        502: json("`wake_failed`: the result is recorded, but the pull request's manager could not be woken", Failure),
      },
    }),
    limited,
    asRun,
    reports,
    body(ReviewerResultBody),
    async function reviewerResult(c) {
      const { source, repo, number, head, ...reported } = c.req.valid("json");
      const tenantId = c.get("tenant").id;
      const runId = c.get("runId");
      const pr = { source, repo, number };
      const { recorded, current } = await recordResult(db, tenantId, pr, runId, head, reported);
      const entry = { tenantId, source, repo, number, kind: reported.kind, head, runId };
      if (!recorded && current !== undefined && current !== head) {
        log({ level: "info", msg: "reviewer_result_stale", ...entry, current });
        return c.json({ recorded: false });
      }
      try {
        if (!(await wake(tenantId, pr, head))) log({ level: "warn", msg: "reviewer_result_unrouted", ...entry, reason: "the workspace has no listener for the host" });
      } catch (err) {
        log({ level: "error", msg: "reviewer_result_wake_failed", ...entry, error: String(err) });
        return failure(502, "wake_failed", "The result is recorded, but the pull request's manager could not be woken.");
      }
      return c.json({ recorded });
    },
  );

  return app;
}
