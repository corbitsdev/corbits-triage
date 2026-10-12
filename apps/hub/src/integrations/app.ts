// Handlers check the session before reading the body, so bodies are described
// here but validated inside each handler.
import { type } from "arktype";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import { describeRoute, resolver } from "hono-openapi";
import { AUTHOR_KINDS, checkPackSchema, repoPolicySchema } from "@corbits/triage-contracts";
import { WorkflowDeploymentResponse } from "@intx/types";
import { AUTH_METHODS_PATH } from "../auth.js";
import { GITHUB_INSTALLATIONS_PATH } from "../github/installation-sync.js";
import { GITHUB_MANIFEST_CALLBACK_PATH, GITHUB_MANIFEST_PATH, StartBody } from "../github/manifest.js";
import { GITHUB_OPEN_PULLS_PATH } from "../github/open-pulls.js";
import { ActionBody, GITHUB_PR_ACTIONS_PATH } from "../github/pr-actions.js";
import { DoBody, DoRunList, DoRunResponse, GITHUB_DOS_PATH } from "../github/pr-dos.js";
import { GITHUB_PR_DETAILS_PATH } from "../github/pr-details.js";
import { GITHUB_PR_PREVIEW_PATH, PreviewBody, PreviewResponse } from "../github/pr-preview.js";
import { GITHUB_PR_TRIAGE_PATH, TriageBody } from "../github/pr-triage.js";
import { TRIAGE_STATS_PATH, TriageStats } from "../github/triage-stats.js";
import { TRIAGE_TIMELINE_PATH, TriageTimeline } from "../github/triage-timeline.js";
import { AcceptBody, Accepted, INVITATIONS_PATH, InvitationCreated, InvitationList, InviteBody, MY_INVITATIONS_PATH, MyInvitations } from "../invitations/invitations.js";
import { DeployBody, WORKFLOW_DEPLOY_PATH } from "../workflow-deploy.js";
import { DeployedVersions, WORKFLOW_VERSIONS_PATH } from "../workflow-versions.js";

export const INTEGRATIONS_PREFIX = "/api/integrations/";
const PACK_SCHEMA_PATH = `${INTEGRATIONS_PREFIX}pack-schema`;
const packSchemas = { checkPack: checkPackSchema.toJsonSchema(), repoPolicy: repoPolicySchema.toJsonSchema() };

type TenantHandler = (req: Request, tenantId: string) => Promise<Response>;

export type IntegrationHandlers = {
  authMethods: { google: boolean; emailPassword: boolean };
  manifest: { start: TenantHandler; cancel: TenantHandler; callback: (req: Request) => Promise<Response> };
  syncInstallations: TenantHandler;
  prActions: TenantHandler;
  dos: { run: TenantHandler; list: TenantHandler };
  prTriage: TenantHandler;
  openPulls: TenantHandler;
  prDetails: TenantHandler;
  prPreview: TenantHandler;
  triageStats: TenantHandler;
  triageTimeline: TenantHandler;
  workflowDeploy: TenantHandler;
  workflowVersions: TenantHandler;
  invitations: {
    create: TenantHandler;
    list: TenantHandler;
    revoke: (req: Request, tenantId: string, invitationId: string) => Promise<Response>;
    mine: (req: Request) => Promise<Response>;
    accept: (req: Request) => Promise<Response>;
  };
};

const TAGS = ["integrations"];

const Failure = type({ error: { code: "string", message: "string" } });
const ManifestFailure = type({ error: "string", "owned?": "boolean" });
const AuthMethods = type({ google: "boolean", emailPassword: "boolean" });
const PackSchemas = type({ checkPack: "Record<string, unknown>", repoPolicy: "Record<string, unknown>" });
const ManifestStart = type({ manifest: "Record<string, unknown>", state: "string" });
const ManifestCancel = type({ cancelled: "boolean" });
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

function body(schema: Parameters<typeof resolver>[0]) {
  return { required: true, content: { "application/json": { schema: resolver(schema) } } };
}

const failures = {
  401: json("Not signed in or not a member", Failure),
  403: json("Not from the portal or not allowed", Failure),
  409: json("GitHub, the workspace or the repository is not ready", Failure),
};
const invalid = { 400: json("Invalid request", Failure) };
const githubFailed = { 502: json("GitHub failed", Failure) };

const manifestFailures = {
  401: json("Not signed in", ManifestFailure),
  403: json("Untrusted origin or not allowed", ManifestFailure),
};

// An undecodable tenant id is a 404. Hono's param() hands such an id on
// undecoded, so the raw segment under :tenantId is decoded here.
function tenantRoute(handle: TenantHandler) {
  return function route(c: Context): Promise<Response> | Response {
    const index = routePath(c).split("/").indexOf(":tenantId");
    const segment = new URL(c.req.url).pathname.split("/")[index] ?? "";
    let tenantId: string;
    try {
      tenantId = decodeURIComponent(segment);
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return handle(c.req.raw, tenantId);
  };
}

function invitationRoute(handle: IntegrationHandlers["invitations"]["revoke"]) {
  return function route(c: Context): Promise<Response> | Response {
    const invitationId = c.req.param("invitationId") ?? "";
    return tenantRoute(function revokeInvitation(req, tenantId) {
      return handle(req, tenantId, invitationId);
    })(c);
  };
}

export function createIntegrationsApp(handlers: IntegrationHandlers) {
  const app = new Hono();

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
      summary: "JSON Schemas of the check pack and repository policy",
      tags: TAGS,
      responses: { 200: json("Check pack and repository policy JSON Schemas", PackSchemas) },
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
      requestBody: body(StartBody),
      responses: {
        201: json("Manifest and state to post to GitHub", ManifestStart),
        400: json("Invalid request", ManifestFailure),
        ...manifestFailures,
        409: json("Setup in progress, provider missing or replacement not confirmed", ManifestFailure),
      },
    }),
    tenantRoute(handlers.manifest.start),
  );

  app.post(
    `${GITHUB_MANIFEST_PATH}/:tenantId/cancel`,
    describeRoute({
      summary: "Cancel the caller's pending GitHub App setup",
      tags: TAGS,
      responses: { 200: json("Whether a pending setup was cancelled", ManifestCancel), ...manifestFailures },
    }),
    tenantRoute(handlers.manifest.cancel),
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
    tenantRoute(handlers.syncInstallations),
  );

  app.post(
    `${GITHUB_PR_ACTIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Act on a pull request",
      tags: TAGS,
      requestBody: body(ActionBody),
      responses: { 200: json("GitHub's answer", type("unknown")), ...invalid, ...failures, ...githubFailed },
    }),
    tenantRoute(handlers.prActions),
  );

  app.post(
    `${GITHUB_DOS_PATH}/:tenantId`,
    describeRoute({
      summary: "Run a pack Do from a triage run's verdict",
      description: "Writes to GitHub at most once per Do effect and records it; a repeat answers with the recorded row as replayed.",
      tags: TAGS,
      requestBody: body(DoBody),
      responses: {
        200: json("The recorded Do", DoRunResponse),
        ...invalid,
        ...failures,
        404: json("Run, verdict or Do not found in this workspace", Failure),
        409: json("GitHub not connected, repository not enabled, verdict outdated, effect id mismatch, head moved, Do running or not runnable", Failure),
        ...githubFailed,
      },
    }),
    tenantRoute(handlers.dos.run),
  );

  app.get(
    `${GITHUB_DOS_PATH}/:tenantId`,
    describeRoute({
      summary: "Recorded pack Dos of a repository, newest first",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: false, schema: { type: "integer", minimum: 1 } },
        { in: "query", name: "runId", required: false, schema: { type: "string" } },
      ],
      responses: { 200: json("Recorded Dos, at most 200", DoRunList), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    tenantRoute(handlers.dos.list),
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId`,
    describeRoute({
      summary: "Queue a pull request for triage",
      tags: TAGS,
      requestBody: body(TriageBody),
      responses: {
        202: json("Queued", TriageQueued),
        ...invalid,
        ...failures,
        502: json("GitHub or the run trigger failed", Failure),
        503: json("The pr-triage service is not running", Failure),
      },
    }),
    tenantRoute(handlers.prTriage),
  );

  app.get(
    `${GITHUB_OPEN_PULLS_PATH}/:tenantId`,
    describeRoute({
      summary: "Open pull requests of the connected repositories",
      tags: TAGS,
      responses: { 200: json("Open pull requests per repository", OpenPulls), ...failures },
    }),
    tenantRoute(handlers.openPulls),
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
    tenantRoute(handlers.prDetails),
  );

  app.post(
    `${GITHUB_PR_PREVIEW_PATH}/:tenantId`,
    describeRoute({
      summary: "Preview a pack on an open pull request",
      description: "Evaluates the saved pack, or a candidate, without writing to GitHub or storing anything. The judge is not run, so the checks it answers need it and actions on them list each branch they could take. Candidate roles apply only when the caller may manage the workspace; otherwise the saved roles are used.",
      tags: TAGS,
      requestBody: body(PreviewBody),
      responses: {
        200: json("Checks, verdict and each action's branch and Dos", PreviewResponse),
        400: json("Invalid request or candidate pack", Failure),
        ...failures,
        404: json("Pull request not found", Failure),
        409: json("GitHub, the workspace or the repository is not ready, the pack is unreadable or the pull request is not open", Failure),
        ...githubFailed,
      },
    }),
    tenantRoute(handlers.prPreview),
  );

  app.get(
    `${TRIAGE_STATS_PATH}/:tenantId`,
    describeRoute({
      summary: "Triage stats of a repository over the last whole UTC days",
      description: "From the recorded verdicts and Dos, degraded verdicts left out; states, needed-you and check results count each head's latest verdict. `since` is the earliest recorded verdict. Cached for a minute.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "days", required: false, schema: { type: "integer", minimum: 1, maximum: 30, default: 7 } },
      ],
      responses: { 200: json("Counts, rates and daily triaged pull requests", TriageStats), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    tenantRoute(handlers.triageStats),
  );

  app.get(
    `${TRIAGE_TIMELINE_PATH}/:tenantId`,
    describeRoute({
      summary: "Readiness history of a pull request",
      description: "From the recorded verdicts only, oldest first; the pull request's Do runs are read from github-dos. A verdict with the same head, settled and degraded state and check results as the one before it is left out. Each scores its checks (pass 1, unconfirmed half, fail 0, out of 100) and lists the checks whose result changed since the previous judged verdict; degraded verdicts score nothing.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: true, schema: { type: "integer", minimum: 1, maximum: 2147483647 } },
      ],
      responses: { 200: json("Verdicts in time order", TriageTimeline), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    tenantRoute(handlers.triageTimeline),
  );

  app.post(
    `${WORKFLOW_DEPLOY_PATH}/:tenantId`,
    describeRoute({
      summary: "Deploy a workflow published as a tarball in the workspace's package registry",
      description: "The stock deploy route with the package-registry asset as the source and a separate workflow asset as the definition.",
      tags: TAGS,
      requestBody: body(DeployBody),
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
    tenantRoute(handlers.workflowDeploy),
  );

  app.get(
    `${WORKFLOW_VERSIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Package versions of the workspace's live workflow deployments",
      description: "Each live deployment, newest first, with the workflow package it pinned and the packages its frozen closure carries. `package` is null for a deployment not pinned from a package registry.",
      tags: TAGS,
      responses: { 200: json("Live deployments and their versions", DeployedVersions), 401: failures[401], 403: failures[403] },
    }),
    tenantRoute(handlers.workflowVersions),
  );

  app.post(
    `${INVITATIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Invite someone to the workspace by email",
      description: "Needs `principal:*` create, and the caller must hold every permission the role grants (so only an owner invites into a `*:*` role). Stock role routes still let an admin assign roles directly; this route does not change that. Replaces the email's open invite. The invitee gets a plain-text email with the accept link when the hub sends email; otherwise the link is returned to copy. Links expire after 7 days. A workspace may send a limited number of invites per hour.",
      tags: TAGS,
      requestBody: body(InviteBody),
      responses: {
        201: json("The invite and whether it was emailed", InvitationCreated),
        ...invalid,
        401: failures[401],
        403: json("Not from the portal, not allowed to invite, a role granting more than the caller holds, or an email outside the sign-in allowlist", Failure),
        404: json("Role not found in this workspace", Failure),
        409: json("Already a member", Failure),
        429: json("Too many invites from this workspace in the last hour", Failure),
        502: json("The invite is saved but its email could not be sent", Failure),
      },
    }),
    tenantRoute(handlers.invitations.create),
  );

  app.get(
    `${INVITATIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Open invites of the workspace, newest first",
      description: "An invite's link is left out when its role grants more than the caller holds. `assignableRoleIds` lists the roles the caller may invite into.",
      tags: TAGS,
      responses: { 200: json("Open invites and the roles the caller may invite into", InvitationList), 401: failures[401], 403: failures[403] },
    }),
    tenantRoute(handlers.invitations.list),
  );

  app.delete(
    `${INVITATIONS_PATH}/:tenantId/:invitationId`,
    describeRoute({
      summary: "Withdraw an open invite",
      tags: TAGS,
      responses: {
        204: { description: "Withdrawn" },
        401: failures[401],
        403: failures[403],
        404: json("Invite not found", Failure),
        409: json("Already used, withdrawn or expired", Failure),
      },
    }),
    invitationRoute(handlers.invitations.revoke),
  );

  app.get(
    MY_INVITATIONS_PATH,
    describeRoute({
      summary: "Open invites to the signed-in user's email",
      description: "Empty unless the session's email is verified, so an unverified sign-up learns nothing about invites to that address.",
      tags: TAGS,
      responses: { 200: json("Open invites, newest first", MyInvitations), 401: failures[401], 403: failures[403] },
    }),
    function myInvitations(c) {
      return handlers.invitations.mine(c.req.raw);
    },
  );

  app.post(
    `${MY_INVITATIONS_PATH}/accept`,
    describeRoute({
      summary: "Accept an invite with its link token",
      description: "Activates the signed-in user's membership with the invited role. Accepting a link the same user already accepted answers the same.",
      tags: TAGS,
      requestBody: body(AcceptBody),
      responses: {
        200: json("The workspace joined", Accepted),
        ...invalid,
        401: failures[401],
        403: json("Not from the portal, signed in with a different email, or suspended", Failure),
        404: json("Unknown invite link", Failure),
        409: json("Already used, or already a member", Failure),
        410: json("Expired or withdrawn", Failure),
      },
    }),
    function acceptInvitation(c) {
      return handlers.invitations.accept(c.req.raw);
    },
  );

  return app;
}
