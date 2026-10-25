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
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE, REPO_SOURCES, StageResult } from "@corbits/triage-contracts";
import { failure } from "./github/portal-credential.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { body, Failure, json } from "./route-schema.js";
import type { ManagerIntake } from "./manager-intake.js";
import { ManagerUnavailableError } from "./manager-unavailable.js";
import { done, EventState, PassState, ReviewerState, take } from "./manager-state.js";


const TAKE_PATH = "/manager/take";
const DONE_PATH = "/manager/done";
const REVIEWER_RESULT_PATH = "/manager/reviewer-result";

export const MANAGER_RUN_TOKEN_ROUTES: readonly RunTokenRoute[] = [
  { method: "POST", path: `/api/tenants/:tenantId${TAKE_PATH}` },
  { method: "POST", path: `/api/tenants/:tenantId${DONE_PATH}` },
  { method: "POST", path: `/api/tenants/:tenantId${REVIEWER_RESULT_PATH}` },
];

const PullRequest = type({ source: type.enumerated(...REPO_SOURCES), repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });
const DoneBody = PullRequest.and({ reviewers: ReviewerState.array() });
const ReviewerResultBody = PullRequest.and(StageResult);

const Taken = type({ outcome: "'idle'" }).or({ outcome: "'pass'", pass: PassState, events: type({ key: "string", event: EventState }).array(), resumed: "boolean" });
const Done = type({ outcome: "'ended' | 'more'" });
const Recorded = type({ recorded: "boolean" });

const TAGS = ["manager"];
const TOO_LARGE = `The body is over ${MAX_BODY_BYTES / 1024 / 1024} MiB.`;
const UNAVAILABLE = "`manager_unavailable`: the result is recorded, but the workspace has no manager to start for the pull request's host.";
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

export type ManagerRoutesDeps = { db: DB["db"]; requireGrant: RequireGrant; intake: ManagerIntake; log: (entry: Record<string, unknown>) => void };

export function createManagerRoutes({ db, requireGrant, intake, log }: ManagerRoutesDeps) {
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

  app.post(
    TAKE_PATH,
    describeRoute({
      summary: "Take the pull request's pending events as its manager",
      description: `Run token only. Answers the open pass again (\`resumed\`), or a new pass on the newest head over every pending event no other request holds, or \`idle\`. ${NOT_MANAGER}`,
      tags: TAGS,
      responses: { 200: json("The pass to work on, or idle", Taken), ...refusals, 409: json(NOT_MANAGER, Failure) },
    }),
    limited,
    asRun,
    granted,
    body(PullRequest),
    async function takeEvents(c) {
      const result = await take(db, c.get("tenant").id, c.req.valid("json"), c.get("runId"));
      if (result.outcome === "refused") return refused();
      return c.json(result);
    },
  );

  app.post(
    DONE_PATH,
    describeRoute({
      summary: "Close the manager's pass and record its reviewers",
      description: `Run token only. \`ended\`: no event is pending and no reviewer of the current head is due, so the claim ended and the run should end. \`more\`: the manager waits for its next mail. ${NOT_MANAGER}`,
      tags: TAGS,
      responses: { 200: json("Whether the manager is done", Done), ...refusals, 409: json(NOT_MANAGER, Failure) },
    }),
    limited,
    asRun,
    granted,
    body(DoneBody),
    async function finishPass(c) {
      const valid = c.req.valid("json");
      const result = await done(db, c.get("tenant").id, valid, c.get("runId"), valid.reviewers);
      if (result.outcome === "refused") return refused();
      return c.json(result);
    },
  );

  app.post(
    REVIEWER_RESULT_PATH,
    describeRoute({
      summary: "Record a reviewer's result for the pull request's manager",
      description: "Run token only. The body is a `StageResult`. The event is recorded under the calling run's id, so `recorded` is false when that run reported before. Then the pull request's manager is started, or nudged when one is live.",
      tags: TAGS,
      responses: { 200: json("Whether the result was recorded now", Recorded), ...refusals, 503: json(UNAVAILABLE, Failure) },
    }),
    limited,
    asRun,
    granted,
    body(ReviewerResultBody),
    async function reviewerResult(c) {
      const valid = c.req.valid("json");
      try {
        return c.json(await intake(c.get("tenant").id, valid, c.get("runId"), { type: "reviewer-result", head: valid.head, payload: { kind: valid.kind, result: valid.result } }));
      } catch (err) {
        if (err instanceof ManagerUnavailableError) return failure(503, "manager_unavailable", err.message);
        throw err;
      }
    },
  );

  return app;
}
