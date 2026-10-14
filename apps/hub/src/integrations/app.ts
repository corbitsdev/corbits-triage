import { type } from "arktype";
import { Hono, type Context } from "hono";
import { every } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import type { DB } from "@intx/db";
import { createHubContextMiddleware, createResolveTenant, requireAuth, type GetSession, type RequireGrant, type SessionInfo, type SessionUser, type TenantEnv } from "@intx/hub-api";
import { AuditLog, AUTHOR_KINDS, BacklogStarted, checkPackSchema, PolicyExported, PolicyFileRead, PolicyRead, PolicySynced, DeployedVersions, InviteRoles, InviteSent, policyFileSchema, policyOverrideSchema, repoPolicySchema, SessionList, sharedPolicySchema, TriageStats, TriageVerdicts } from "@corbits/triage-contracts";
import { WorkflowDeploymentResponse } from "@intx/types";
import { AUDIT_PATH } from "../audit-log.js";
import { AUTH_METHODS_PATH } from "../auth.js";
import { GITHUB_HELD_DOS_PATH, HeldDoBody, HeldDoSent } from "../github/held-dos.js";
import { GITHUB_INSTALLATIONS_PATH } from "../github/installation-sync.js";
import { GITHUB_MANIFEST_CALLBACK_PATH, GITHUB_MANIFEST_PATH, StartBody, validManifestMutationRequest } from "../github/manifest.js";
import { GITHUB_OPEN_PULLS_PATH } from "../github/open-pulls.js";
import { failure } from "../github/portal-credential.js";
import { ActionBody, GITHUB_PR_ACTIONS_PATH } from "../github/pr-actions.js";
import { GITHUB_PR_DETAILS_PATH } from "../github/pr-details.js";
import { GITHUB_PR_PREVIEW_PATH, PreviewBody, PreviewResponse } from "../github/pr-preview.js";
import { GITHUB_PR_TRIAGE_PATH, TriageBody } from "../github/pr-triage.js";
import { PolicyFileBody } from "../github/policy-file.js";
import { PolicyQuery } from "../github/policy-read.js";
import { BacklogBody } from "../github/backlog-triage.js";
import { TRIAGE_STATS_PATH } from "../github/triage-stats.js";
import { TRIAGE_TIMELINE_PATH, TriageTimeline } from "../github/triage-timeline.js";
import { TRIAGE_VERDICTS_PATH } from "../github/triage-verdicts.js";
import { BITBUCKET_PATH, BitbucketRepos, ConnectBody, Connected, Connection, Disconnected, RepoDisabled, RepoEnabled, type BitbucketHandlers } from "../bitbucket-datacenter/integration.js";
import { ACCEPT_PATH, AcceptBody, Accepted, INVITATIONS_PATH, InviteBody } from "../invitations/invitations.js";
import { SESSIONS_PATH } from "../sessions.js";
import { DeployBody, WORKFLOW_DEPLOY_PATH } from "../workflow-deploy.js";
import { WORKFLOW_VERSIONS_PATH } from "../workflow-versions.js";

export const INTEGRATIONS_PREFIX = "/api/integrations/";
export const PACK_SCHEMA_PATH = `${INTEGRATIONS_PREFIX}pack-schema`;
const packSchemas = {
  checkPack: checkPackSchema.toJsonSchema(),
  sharedPolicy: sharedPolicySchema.toJsonSchema(),
  policyOverride: policyOverrideSchema.toJsonSchema(),
  repoPolicy: repoPolicySchema.toJsonSchema(),
  policyFile: policyFileSchema.toJsonSchema(),
};

export type Member = { tenantId: string; principalId: string };
export type Caller = { user: SessionUser; session: SessionInfo };
type MemberHandler = (req: Request, member: Member) => Promise<Response>;
type BodyHandler<B> = (body: B, member: Member) => Promise<Response>;

export type IntegrationGuards = {
  db: DB["db"];
  getSession: GetSession;
  requireGrant: RequireGrant;
  trustedPortalOrigins: readonly string[];
  log: (entry: Record<string, unknown>) => void;
};

export type IntegrationHandlers = {
  authMethods: { google: boolean; emailPassword: boolean; passwordReset: boolean };
  manifest: { start: (req: Request, tenantId: string) => Promise<Response>; callback: (req: Request) => Promise<Response> };
  syncInstallations: (member: Member) => Promise<Response>;
  prActions: BodyHandler<typeof ActionBody.infer>;
  heldDos: BodyHandler<typeof HeldDoBody.infer>;
  prTriage: BodyHandler<typeof TriageBody.infer>;
  policyRead: BodyHandler<typeof PolicyQuery.infer>;
  policyFileRead: BodyHandler<typeof PolicyFileBody.infer>;
  policyFileSync: BodyHandler<typeof PolicyFileBody.infer>;
  policyFileExport: BodyHandler<typeof PolicyFileBody.infer>;
  backlog: BodyHandler<typeof BacklogBody.infer>;
  openPulls: (member: Member) => Promise<Response>;
  prDetails: MemberHandler;
  prPreview: (body: typeof PreviewBody.infer, member: Member, signal: AbortSignal) => Promise<Response>;
  triageStats: MemberHandler;
  triageTimeline: MemberHandler;
  triageVerdicts: MemberHandler;
  audit: MemberHandler;
  workflowDeploy: BodyHandler<typeof DeployBody.infer>;
  workflowVersions: (member: Member) => Promise<Response>;
  invitations: {
    create: (body: typeof InviteBody.infer, member: Member, req: Request) => Promise<Response>;
    roles: (member: Member) => Promise<Response>;
    resend: (req: Request, member: Member, principalId: string) => Promise<Response>;
    withdraw: (req: Request, member: Member, principalId: string) => Promise<Response>;
    accept: (body: typeof AcceptBody.infer, user: SessionUser) => Promise<Response>;
  };
  bitbucketDatacenter: BitbucketHandlers;
  sessions: {
    list: (caller: Caller) => Promise<Response>;
    revoke: (caller: Caller, sessionId: string) => Promise<Response>;
  };
};

const TAGS = ["integrations"];

const Failure = type({ error: { code: "string", message: "string" } });
const ManifestFailure = type({ error: "string" });
const AuthMethods = type({ google: "boolean", emailPassword: "boolean", passwordReset: "boolean" });
const PackSchemas = type({ checkPack: "Record<string, unknown>", sharedPolicy: "Record<string, unknown>", policyOverride: "Record<string, unknown>", repoPolicy: "Record<string, unknown>", policyFile: "Record<string, unknown>" });
const ManifestStart = type({ manifest: "Record<string, unknown>", state: "string" });
const InstallationsSynced = type({ installations: "number", repos: "string[]" });
const TriageQueued = type({ status: "'queued'", headSha: "string" });
const OpenPull = type({
  number: "number",
  title: "string",
  author: "string | null",
  "authorKind?": type.enumerated(...AUTHOR_KINDS),
  draft: "boolean",
  "sha?": "string",
  updatedAt: "string",
  labels: "string[]",
});
const OpenPulls = type({ repos: type({ repo: "string", prs: OpenPull.array(), "error?": "string" }).array() });
const PrDetails = type({
  pr: "Record<string, unknown>",
  files: "Record<string, unknown>[]",
  commits: "Record<string, unknown>[]",
  comments: "Record<string, unknown>[]",
  issues: "Record<string, unknown>[]",
  checks: "unknown",
  reviews: "Record<string, unknown>[]",
});

function json(description: string, schema: Parameters<typeof resolver>[0]) {
  return { description, content: { "application/json": { schema: resolver(schema) } } };
}

function html(description: string) {
  return { description, content: { "text/html": {} } };
}

const failures = {
  401: json("Not signed in", Failure),
  403: json("Not from the portal, not a member or not allowed", Failure),
  409: json("GitHub, the workspace or the repository is not ready", Failure),
};
const invalid = { 400: json("Invalid request", Failure) };
const githubFailed = { 502: json("GitHub failed", Failure) };

const manifestFailures = {
  401: json("Not signed in", ManifestFailure),
  403: json("Untrusted origin or not allowed", ManifestFailure),
};

// Browsers omit Origin on same-origin GETs, and reads change nothing, so they only need to not be cross-site.
// A bearer token without a cookie is an agent's device-code session; browsers never attach one on their own.
function fromPortal(req: Request, trustedOrigins: readonly string[]): boolean {
  if (req.headers.get("authorization")?.toLowerCase().startsWith("bearer ") && !req.headers.has("cookie")) return true;
  if (req.method === "GET") return req.headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
  return validManifestMutationRequest(req, new Set([new URL(req.url).origin, ...trustedOrigins]));
}

function refuseInvalid(result: { success: true } | { success: false; error: ReadonlyArray<{ message: string }> }) {
  if (!result.success) return failure(400, "invalid_request", result.error.map((issue) => issue.message).join("; "));
}

function body<S extends Parameters<typeof validator>[1]>(schema: S) {
  return validator("json", schema, refuseInvalid);
}

function memberOf(c: Context<TenantEnv>): Member {
  return { tenantId: c.get("tenant").id, principalId: c.get("principal").id };
}

function callerOf(c: Context<TenantEnv>): Caller {
  return { user: c.get("user")!, session: c.get("session")! };
}

export function createIntegrationsApp(guards: IntegrationGuards, handlers: IntegrationHandlers) {
  const app = new Hono<TenantEnv>();
  const portalOnly = createMiddleware(async function portalOnly(c, next) {
    if (!fromPortal(c.req.raw, guards.trustedPortalOrigins)) return failure(403, "forbidden", "This request did not come from the portal.");
    await next();
  });
  const signedIn = every(portalOnly, createHubContextMiddleware({ getSession: guards.getSession }), requireAuth);
  const member = every(signedIn, createResolveTenant({ db: guards.db }));
  const { requireGrant } = guards;
  // Hono throws on a body that is not JSON; it keeps the hub's error envelope.
  app.onError(function onError(err) {
    if (err instanceof HTTPException && err.status === 400) return failure(400, "invalid_request", err.message);
    if (err instanceof HTTPException) return err.getResponse();
    guards.log({ level: "error", msg: "integration_route_failed", error: String(err) });
    return failure(500, "internal", "Internal error.");
  });

  app.get(
    AUTH_METHODS_PATH,
    describeRoute({
      summary: "Sign-in methods the hub accepts",
      tags: TAGS,
      responses: { 200: json("Enabled sign-in methods", AuthMethods) },
    }),
    function authMethods() {
      return Response.json(handlers.authMethods);
    },
  );

  app.get(
    PACK_SCHEMA_PATH,
    describeRoute({
      summary: "JSON Schemas of the policy, workspace policy, repository override, repository settings and policy file",
      description: "`checkPack`, `sharedPolicy`, `policyOverride`, `repoPolicy` and `policyFile`, what `.corbits-triage.yaml` holds.",
      tags: TAGS,
      responses: { 200: json("Policy and repository settings JSON Schemas", PackSchemas) },
    }),
    function packSchema() {
      return Response.json(packSchemas);
    },
  );

  app.post(
    `${GITHUB_MANIFEST_PATH}/:tenantId/start`,
    describeRoute({
      summary: "Start GitHub App manifest setup",
      tags: TAGS,
      requestBody: { required: true, content: { "application/json": { schema: resolver(StartBody) } } },
      responses: {
        201: json("Manifest and state to post to GitHub", ManifestStart),
        400: json("Invalid request", ManifestFailure),
        ...manifestFailures,
        409: json("Provider missing or replacement not confirmed", ManifestFailure),
      },
    }),
    function manifestStart(c) {
      return handlers.manifest.start(c.req.raw, c.req.param("tenantId"));
    },
  );

  app.get(
    GITHUB_MANIFEST_CALLBACK_PATH,
    describeRoute({
      summary: "GitHub App manifest callback",
      description: "GitHub redirects here with a one-time code; answers with a redirect to the portal or an HTML error page.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "state", required: true, schema: { type: "string" } },
        { in: "query", name: "code", required: true, schema: { type: "string" } },
      ],
      responses: {
        303: { description: "Setup completed; redirects to the portal" },
        400: html("Setup could not be verified or completed"),
        401: html("Not signed in"),
        403: html("Not allowed to complete setup"),
        409: html("GitHub provider configuration is invalid"),
        503: html("GitHub temporarily unavailable"),
      },
    }),
    function manifestCallback(c) {
      return handlers.manifest.callback(c.req.raw);
    },
  );

  app.post(
    `${GITHUB_INSTALLATIONS_PATH}/:tenantId/sync`,
    describeRoute({
      summary: "Sync the GitHub App's installations and repositories",
      tags: TAGS,
      responses: { 200: json("Installations and repositories found", InstallationsSynced), ...failures, ...githubFailed },
    }),
    member,
    function syncInstallations(c) {
      return handlers.syncInstallations(memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_ACTIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Act on a pull request",
      description: "Needs `use` on the GitHub App credential and `invoke` on `triage-do:<kind>:<owner/name>` for the Do kind the action is: comment (comment and reply), labels, assign, request-review, approve or request-changes (review), close or merge.",
      tags: TAGS,
      responses: { 200: json("GitHub's answer", type("unknown")), ...invalid, ...failures, ...githubFailed },
    }),
    member,
    body(ActionBody),
    function prActions(c) {
      return handlers.prActions(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_HELD_DOS_PATH}/:tenantId`,
    describeRoute({
      summary: "Approve a Do a triage run held, failed or could not run",
      description: "Needs `use` on the GitHub App credential, and the approve grant for an approval. Mails the repository's pr-triage deployment the Do and who approved it; pr-triage writes the Do at most once under its effect id, and a close, comment or review not once the head has moved.",
      tags: TAGS,
      responses: {
        202: json("Sent to pr-triage", HeldDoSent),
        ...invalid,
        ...failures,
        404: json("Run, verdict or Do not found in this workspace", Failure),
        409: json("GitHub not connected, repository not enabled, Do already written or not awaiting approval, verdict outdated or superseded", Failure),
        502: json("The run trigger failed", Failure),
        503: json("The pr-triage service is not running", Failure),
      },
    }),
    member,
    body(HeldDoBody),
    function heldDos(c) {
      return handlers.heldDos(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId`,
    describeRoute({
      summary: "Queue a pull request for triage",
      description: "Needs `use` on the workspace's GitHub App credential, a connected and enabled repository and a readable policy.",
      tags: TAGS,
      responses: {
        202: json("Queued", TriageQueued),
        ...invalid,
        ...failures,
        502: json("GitHub or the run trigger failed", Failure),
        503: json("The pr-triage service is not running", Failure),
      },
    }),
    member,
    body(TriageBody),
    function prTriage(c) {
      return handlers.prTriage(c.req.valid("json"), memberOf(c));
    },
  );

  app.get(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy`,
    describeRoute({
      summary: "A repository's policy as triage reads it",
      description: "Any member of the workspace. Answers `ok` with the resolved pack and the policy versions it came from, `missing`, or `corrupt` with the reason and the artifact a save replaces. `source.file` names the policy file the current version was synced from.",
      tags: TAGS,
      parameters: [{ in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } }],
      responses: { 200: json("The resolved pack and the policy versions it was read from, or why there is none", PolicyRead), ...invalid, ...failures },
    }),
    member,
    validator("query", PolicyQuery, refuseInvalid),
    function policyRead(c) {
      return handlers.policyRead(c.req.valid("query"), memberOf(c));
    },
  );

  app.get(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy/file`,
    describeRoute({
      summary: "A repository's .corbits-triage.yaml and whether its policy holds what the file says",
      description: "Needs `read` or `use` on the workspace's GitHub App credential and a connected repository. Reads the file on the default branch; `file` is null when there is none.",
      tags: TAGS,
      parameters: [{ in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } }],
      responses: { 200: json("The policy file, or null", PolicyFileRead), ...invalid, ...failures, ...githubFailed },
    }),
    member,
    validator("query", PolicyFileBody, refuseInvalid),
    function policyFileRead(c) {
      return handlers.policyFileRead(c.req.valid("query"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy/sync`,
    describeRoute({
      summary: "Read a repository's .corbits-triage.yaml into its policy now",
      description: "Needs `use` on the workspace's GitHub App credential and a connected repository. Stores the file on the default branch as a new version of the repository's policy when it differs; pushes to the default branch do the same.",
      tags: TAGS,
      responses: {
        200: json("Synced, or already what the file holds", PolicySynced),
        ...invalid,
        ...failures,
        404: json("The repository has no policy file", Failure),
        422: json("The policy file is not a valid policy", Failure),
        ...githubFailed,
      },
    }),
    member,
    body(PolicyFileBody),
    function policyFileSync(c) {
      return handlers.policyFileSync(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy/export`,
    describeRoute({
      summary: "Open a pull request adding .corbits-triage.yaml from the repository's policy",
      description: "Needs `use` on the workspace's GitHub App credential, a connected repository and a stored policy. One commit on `corbits-triage/policy`; refused when the file or the branch already exists.",
      tags: TAGS,
      responses: { 200: json("The pull request opened", PolicyExported), ...invalid, ...failures, ...githubFailed },
    }),
    member,
    body(PolicyFileBody),
    function policyFileExport(c) {
      return handlers.policyFileExport(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/backlog`,
    describeRoute({
      summary: "Triage a repository's open pull requests again",
      description: "Needs `use` on the workspace's GitHub App credential, a connected and enabled repository and a readable policy. Mails pr-triage-historical the payload pr-triage gets.",
      tags: TAGS,
      responses: {
        202: json("Started", BacklogStarted),
        ...invalid,
        ...failures,
        502: json("The run trigger failed", Failure),
        503: json("The pr-triage-historical service is not running", Failure),
      },
    }),
    member,
    body(BacklogBody),
    function backlog(c) {
      return handlers.backlog(c.req.valid("json"), memberOf(c));
    },
  );

  app.get(
    `${GITHUB_OPEN_PULLS_PATH}/:tenantId`,
    describeRoute({
      summary: "Open pull requests of the connected repositories",
      tags: TAGS,
      responses: { 200: json("Open pull requests per repository", OpenPulls), ...failures },
    }),
    member,
    function openPulls(c) {
      return handlers.openPulls(memberOf(c));
    },
  );

  app.get(
    `${GITHUB_PR_DETAILS_PATH}/:tenantId`,
    describeRoute({
      summary: "Pull request details",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      responses: { 200: json("Files, commits, conversation, issues, checks and reviews", PrDetails), ...invalid, ...failures, ...githubFailed },
    }),
    member,
    function prDetails(c) {
      return handlers.prDetails(c.req.raw, memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_PREVIEW_PATH}/:tenantId`,
    describeRoute({
      summary: "Preview a policy on an open pull request",
      description: "Evaluates the saved policy, or a candidate, without writing to GitHub or storing anything. The judge is not run, so the rules it answers need it and each verdict's steps are listed. Team membership for a candidate policy's steps is read only when the caller may manage the workspace; otherwise those teams stay unknown.",
      tags: TAGS,
      responses: {
        200: json("Rules, verdict and each action's branch and Dos", PreviewResponse),
        400: json("Invalid request or candidate policy", Failure),
        ...failures,
        404: json("Pull request not found", Failure),
        409: json("GitHub, the workspace or the repository is not ready, the policy is unreadable or the pull request is not open", Failure),
        ...githubFailed,
      },
    }),
    member,
    body(PreviewBody),
    function prPreview(c) {
      return handlers.prPreview(c.req.valid("json"), memberOf(c), c.req.raw.signal);
    },
  );

  app.get(
    `${TRIAGE_STATS_PATH}/:tenantId`,
    describeRoute({
      summary: "Triage stats of a repository over the last whole UTC days",
      description: "Needs `workflow-run:*` read. From the recorded verdicts and the Dos their runs executed, degraded verdicts left out; states, needed-you and check results count each head's latest verdict. `since` is the earliest recorded verdict. Cached for a minute.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "days", required: false, schema: { type: "integer", minimum: 1, maximum: 30, default: 7 } },
      ],
      responses: { 200: json("Counts, rates and daily triaged pull requests", TriageStats), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("workflow-run:*", "read"),
    function triageStats(c) {
      return handlers.triageStats(c.req.raw, memberOf(c));
    },
  );

  app.get(
    `${TRIAGE_TIMELINE_PATH}/:tenantId`,
    describeRoute({
      summary: "Readiness history of a pull request",
      description: "Needs `workflow-run:*` read. From the recorded verdicts only, oldest first. A verdict with the same head, settled and degraded state and rule results as the one before it is left out. Each scores its rules (pass 1, unconfirmed half, fail 0, out of 100) and lists the rules whose result changed since the previous judged verdict; degraded verdicts score nothing.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: true, schema: { type: "integer", minimum: 1, maximum: 2147483647 } },
      ],
      responses: { 200: json("Verdicts in time order", TriageTimeline), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("workflow-run:*", "read"),
    function triageTimeline(c) {
      return handlers.triageTimeline(c.req.raw, memberOf(c));
    },
  );

  app.get(
    `${TRIAGE_VERDICTS_PATH}/:tenantId`,
    describeRoute({
      summary: "Latest verdict of each open pull request",
      description: "Needs `workflow-run:*` read, as reading run logs does. Reads only what the hub already recorded: verdicts (recorded within seconds of their step completing, by a loop over tenants with pr-triage runs in flight), the last read of the live logs and GitHub's last listing of open pull requests (the github-open-pulls listing, or one read as the App at most every 30 seconds when the caller holds `read` on the GitHub credential; without it, the last listing of any age). Each open pull request of a connected repository with a verdict or a live run, with its latest verdict, its latest run when that has not completed (`unknown` until the hub read the workspace's live logs since it started), and when author activity last started a run. Where GitHub's listing lacks a repository, those with a verdict in the last 14 days. With `repo` and `number`, that one pull request, open or not. Sends an ETag; a matching If-None-Match gets 304, answered from memory while nothing changed.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: false, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: false, schema: { type: "integer", minimum: 1, maximum: 2147483647 } },
      ],
      responses: {
        200: json("Pull requests by repository and number", TriageVerdicts),
        304: { description: "Unchanged since the ETag sent" },
        ...invalid,
        401: failures[401],
        403: json("Not from the portal or no read of the workspace's runs", Failure),
        404: json("The repository is not connected", Failure),
        409: json("The workspace is not set up yet", Failure),
      },
    }),
    member,
    requireGrant("workflow-run:*", "read"),
    function triageVerdicts(c) {
      return handlers.triageVerdicts(c.req.raw, memberOf(c));
    },
  );

  app.get(
    `${AUDIT_PATH}/:tenantId`,
    describeRoute({
      summary: "What the workspace recorded, newest first",
      description: "Needs `workflow-run:*` read. Reads only what is already stored: recorded verdicts and the Dos their runs ran (at the verdict's time; no separate time is recorded), held Do approvals from the run logs of the workflow's runs without a verdict, policy versions, members and invites, grants, and workflow deployments and how they ended. Withdrawn invites and removed grants leave no row, so they are not listed. `actor` is the person's email or principal id, `Triage` for the workflow, `hub` for a deployment the hub failed or replaced, or `unknown` where the store does not say. With `repo`, only that repository's verdicts, Dos, approvals and checks.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: false, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "since", required: false, schema: { type: "string", format: "date-time" } },
        { in: "query", name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      ],
      responses: { 200: json("Recorded events, newest first", AuditLog), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("workflow-run:*", "read"),
    function audit(c) {
      return handlers.audit(c.req.raw, memberOf(c));
    },
  );

  app.post(
    `${WORKFLOW_DEPLOY_PATH}/:tenantId`,
    describeRoute({
      summary: "Deploy a workflow published as a tarball in the workspace's package registry",
      description: "The stock deploy route with the package-registry asset as the source and a separate workflow asset as the definition.",
      tags: TAGS,
      responses: {
        201: json("Workflow deployment accepted for provisioning", WorkflowDeploymentResponse),
        ...invalid,
        401: failures[401],
        403: failures[403],
        404: json("Workspace, workflow asset or package registry asset not found", Failure),
        409: json("Workflow definition, source offering chain or tenant config invalid, or provisioning unavailable", Failure),
        500: json("Deployment missing after preparation", Failure),
        502: json("Sidecar unavailable", Failure),
      },
    }),
    member,
    requireGrant("workflow:*", "create"),
    body(DeployBody),
    function workflowDeploy(c) {
      return handlers.workflowDeploy(c.req.valid("json"), memberOf(c));
    },
  );

  app.get(
    `${WORKFLOW_VERSIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Package versions of the workspace's live workflow deployments",
      description: "Each live deployment, newest first, with the workflow package it pinned and the packages its frozen closure carries. `package` is null for a deployment not pinned from a package registry.",
      tags: TAGS,
      responses: { 200: json("Live deployments and their versions", DeployedVersions), 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("workflow:*", "read"),
    function workflowVersions(c) {
      return handlers.workflowVersions(memberOf(c));
    },
  );

  app.post(
    `${INVITATIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Invite someone to the workspace by email",
      description: "Needs `principal:*` create, and the caller must hold every permission the role grants (so only an owner invites into a `*:*` role). Creates the stock invited principal through `POST /api/tenants/{tenantId}/members/invite`; the invitee accepts on the portal's `/invite/{tenantId}` page. When the hub sends email, a plain-text better-auth magic link to that page is emailed (a new address gets an unverified user first); it signs the invitee in and verifies the address, works once and expires after 15 minutes. Without email set up on the hub, the page's link is returned to copy; it signs nobody in, and invitees must sign in with Google first. An existing account whose address is not verified cannot be invited. An address may be sent a limited number of invite links per hour.",
      tags: TAGS,
      responses: {
        201: json("The invited principal and whether its link was emailed", InviteSent),
        ...invalid,
        401: failures[401],
        403: json("Not from the portal, not allowed to invite, a role granting more than the caller holds, or an email outside the sign-in allowlist", Failure),
        404: json("Role not found, or without email an address with no account", Failure),
        409: json("Already a member or invited, or an account whose address is not verified", Failure),
        429: json("Too many invite links to this address in the last hour", Failure),
        502: json("The invite is saved but its email could not be sent", Failure),
      },
    }),
    member,
    requireGrant("principal:*", "create"),
    body(InviteBody),
    function createInvitation(c) {
      return handlers.invitations.create(c.req.valid("json"), memberOf(c), c.req.raw);
    },
  );

  app.get(
    `${INVITATIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Roles the caller may invite people into",
      description: "Roles whose every permission the caller holds. Open invites are the stock principals with status `invited`.",
      tags: TAGS,
      responses: { 200: json("Assignable role ids, email delivery and the sign-in allowlist", InviteRoles), 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("principal:*", "create"),
    function inviteRoles(c) {
      return handlers.invitations.roles(memberOf(c));
    },
  );

  app.post(
    `${INVITATIONS_PATH}/:tenantId/:principalId/resend`,
    describeRoute({
      summary: "Send a new magic link to an invited principal",
      description: "Same rules and rate limits as inviting. Earlier links keep working until they expire. At most once a minute per invite.",
      tags: TAGS,
      responses: {
        200: json("The invited principal and whether its link was emailed", InviteSent),
        401: failures[401],
        403: failures[403],
        404: json("No invited principal with this id", Failure),
        429: json("Sent within the last minute, or too many links to this address this hour", Failure),
        502: json("The email could not be sent", Failure),
      },
    }),
    member,
    requireGrant("principal:*", "create"),
    function resendInvitation(c) {
      return handlers.invitations.resend(c.req.raw, memberOf(c), c.req.param("principalId"));
    },
  );

  app.delete(
    `${INVITATIONS_PATH}/:tenantId/:principalId`,
    describeRoute({
      summary: "Withdraw an invite",
      description: "Deletes the invited principal through the stock principal delete, and the user the invite created for a new address when nothing else holds it, so the address stays free to sign up.",
      tags: TAGS,
      responses: {
        204: { description: "Withdrawn" },
        401: failures[401],
        403: failures[403],
        404: json("No invited principal with this id", Failure),
      },
    }),
    member,
    requireGrant("principal:*", "create"),
    function withdrawInvitation(c) {
      return handlers.invitations.withdraw(c.req.raw, memberOf(c), c.req.param("principalId"));
    },
  );

  app.post(
    ACCEPT_PATH,
    describeRoute({
      summary: "Accept the signed-in user's invite to a workspace",
      description: "Activates the signed-in user's invited principal in the workspace. Their address must be verified: an invite's magic link verifies it, and without email set up on the hub, invitees must sign in with Google first. Accepting again answers the same.",
      tags: TAGS,
      responses: {
        200: json("The workspace joined", Accepted),
        ...invalid,
        401: failures[401],
        403: json("Not from the portal, an unverified address, or suspended", Failure),
        404: json("No invite to this workspace", Failure),
      },
    }),
    signedIn,
    body(AcceptBody),
    function acceptInvitation(c) {
      return handlers.invitations.accept(c.req.valid("json"), c.get("user")!);
    },
  );

  app.get(
    SESSIONS_PATH,
    describeRoute({
      summary: "The signed-in user's sessions",
      description: "Browsers and devices signed in as this user, without their tokens. `isCurrent` marks the session making the request.",
      tags: TAGS,
      responses: { 200: json("Unexpired sessions, oldest first", SessionList), 401: failures[401], 403: failures[403] },
    }),
    signedIn,
    function listSessions(c) {
      return handlers.sessions.list(callerOf(c));
    },
  );

  app.delete(
    `${SESSIONS_PATH}/:sessionId`,
    describeRoute({
      summary: "Sign out one of the signed-in user's sessions",
      tags: TAGS,
      responses: { 204: { description: "Signed out" }, 401: failures[401], 403: failures[403], 404: json("Not one of this user's sessions", Failure) },
    }),
    signedIn,
    function revokeSession(c) {
      return handlers.sessions.revoke(callerOf(c), c.req.param("sessionId"));
    },
  );

  const bitbucketFailures = {
    401: failures[401],
    403: failures[403],
    409: json("Bitbucket is not connected, or the repository is not ready", Failure),
    502: json("The Bitbucket instance failed or could not be reached", Failure),
  };
  const repoParameters = [
    { in: "path" as const, name: "project", required: true, schema: { type: "string" as const }, description: "Project key, e.g. `TRI`" },
    { in: "path" as const, name: "slug", required: true, schema: { type: "string" as const }, description: "Repository slug" },
  ];

  app.put(
    `${BITBUCKET_PATH}/:tenantId/connection`,
    describeRoute({
      summary: "Connect a Bitbucket Data Center instance",
      description: "Needs `manage` on the workspace. The token is tried once against `GET /rest/api/1.0/application-properties` and stored only when the instance accepts it, as the stock `bitbucket-datacenter` credential on the `bitbucket-datacenter` provider; a webhook secret is generated as `bitbucket-datacenter-hook` unless one exists. The token is never returned.",
      tags: TAGS,
      requestBody: { required: true, content: { "application/json": { schema: resolver(ConnectBody) } } },
      responses: { 200: json("Connected", Connected), 400: json("Invalid request, or the instance did not accept the token", Failure), ...bitbucketFailures },
    }),
    member,
    body(ConnectBody),
    function connectBitbucket(c) {
      return handlers.bitbucketDatacenter.connect(c.req.valid("json"), memberOf(c), c.req.raw);
    },
  );

  app.get(
    `${BITBUCKET_PATH}/:tenantId/connection`,
    describeRoute({
      summary: "The workspace's Bitbucket connection",
      description: "Any member of the workspace. `hookUrl` is where the instance posts repository events.",
      tags: TAGS,
      responses: { 200: json("The connected instance", Connection), 401: failures[401], 403: failures[403], 404: json("Bitbucket is not connected", Failure) },
    }),
    member,
    function bitbucketConnection(c) {
      return handlers.bitbucketDatacenter.connection(memberOf(c));
    },
  );

  app.delete(
    `${BITBUCKET_PATH}/:tenantId/connection`,
    describeRoute({
      summary: "Disconnect Bitbucket",
      description: "Needs `manage` on the workspace. Removes the webhooks triage created, both credentials and the connection, and disables every Bitbucket repository; their records stay. `webhooksLeft` names repositories whose webhook could not be removed.",
      tags: TAGS,
      responses: { 200: json("Disconnected", Disconnected), 401: failures[401], 403: failures[403], 404: json("Bitbucket is not connected", Failure) },
    }),
    member,
    function disconnectBitbucket(c) {
      return handlers.bitbucketDatacenter.disconnect(memberOf(c), c.req.raw);
    },
  );

  app.get(
    `${BITBUCKET_PATH}/:tenantId/repositories`,
    describeRoute({
      summary: "Bitbucket repositories the token sees, with their records",
      description: "Needs `use` on the `bitbucket-datacenter` credential. Repository records as the workspace config holds them, named `PROJECT/slug`; a recorded repository the token no longer sees is listed with `connected: false`.",
      tags: TAGS,
      responses: { 200: json("Repositories", BitbucketRepos), ...bitbucketFailures },
    }),
    member,
    function bitbucketRepositories(c) {
      return handlers.bitbucketDatacenter.repositories(memberOf(c));
    },
  );

  app.post(
    `${BITBUCKET_PATH}/:tenantId/repositories/:project/:slug/enable`,
    describeRoute({
      summary: "Enable triage on a Bitbucket repository",
      description: "Needs `manage` on the workspace and `use` on the Bitbucket credentials. Records the repository with its default branch and creates its webhook. When the token may not manage webhooks, `webhook` is `manual` and the answer carries the hook URL, secret and events to set up by hand.",
      tags: TAGS,
      parameters: repoParameters,
      responses: { 200: json("Enabled", RepoEnabled), ...bitbucketFailures, 404: json("No such repository", Failure) },
    }),
    member,
    function enableBitbucketRepo(c) {
      return handlers.bitbucketDatacenter.enable(memberOf(c), c.req.param("project"), c.req.param("slug"));
    },
  );

  app.post(
    `${BITBUCKET_PATH}/:tenantId/repositories/:project/:slug/disable`,
    describeRoute({
      summary: "Disable triage on a Bitbucket repository",
      description: "Needs `manage` on the workspace. Removes the webhook triage created; `webhookLeft` is true when it could not.",
      tags: TAGS,
      parameters: repoParameters,
      responses: { 200: json("Disabled", RepoDisabled), 401: failures[401], 403: failures[403], 404: json("No such repository recorded", Failure) },
    }),
    member,
    function disableBitbucketRepo(c) {
      return handlers.bitbucketDatacenter.disable(memberOf(c), c.req.param("project"), c.req.param("slug"));
    },
  );

  return app;
}
