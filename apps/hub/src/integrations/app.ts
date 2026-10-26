import { type } from "arktype";
import { Hono, type Context } from "hono";
import { every } from "hono/combine";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { honoLogger, type HonoContext } from "@intx/log/hono";
import { createHubContextMiddleware, createResolveTenant, requireAuth, type GetSession, type RequireGrant, type SessionInfo, type SessionUser, type TenantEnv } from "@intx/hub-api";
import { AuditLog, AUTHOR_KINDS, BacklogStarted, REPO_SOURCES, CodeReviewPlace, checkPackSchema, checkPolicyFile, PolicyExported, PolicyFileRead, PolicyRead, PolicyUpgrades, PolicyValidated, POLICY_FILE_MAX_BYTES, DeployedVersions, InviteRoles, InviteSent, MAX_MERGE_STATES, policyFileSchema, policyOverrideSchema, repoPolicySchema, SessionList, sharedPolicySchema, TriageStats, TriageVerdicts } from "@corbits/triage-contracts";
import { WorkflowDeploymentResponse } from "@intx/types";
import { AUDIT_PATH } from "../audit-log.js";
import { AUTH_METHODS_PATH } from "../auth.js";
import { CODE_REVIEW_PATH, CodeReviewBody, CodeReviewQueued, CodeReviewRunBody, CodeReviewSet } from "../code-review.js";
import { CodeReviewFound, CodeReviewQuery } from "../code-review-runs.js";
import { GITHUB_HELD_DOS_PATH, HeldDoBody, HeldDoSent } from "../github/held-dos.js";
import { AppBody, AppConnected, GITHUB_APP_PATH } from "../github/app-connection.js";
import { GITHUB_INSTALLATIONS_PATH } from "../github/installation-sync.js";
import { GITHUB_MANIFEST_CALLBACK_PATH, GITHUB_MANIFEST_PATH, StartBody, validManifestMutationRequest } from "../github/manifest.js";
import { MERGE_STATES_PATH } from "../github/merge-states.js";
import { GITHUB_OPEN_PULLS_PATH } from "../github/open-pulls.js";
import { KEPT_MS, type ReadScope } from "../github/repo-reads.js";
import { failure } from "../github/portal-credential.js";
import { ActionBody, GITHUB_PR_ACTIONS_PATH } from "../github/pr-actions.js";
import { GITHUB_PR_DETAILS_PATH } from "../github/pr-details.js";
import { GITHUB_PR_TRIAGE_PATH, TriageBody } from "../github/pr-triage.js";
import { PolicyExportBody, PolicyFileBody } from "../github/policy-file.js";
import { PolicyQuery } from "../github/policy-read.js";
import { BacklogBody } from "../github/backlog-triage.js";
import { TRIAGE_STATS_PATH } from "../github/triage-stats.js";
import { TRIAGE_TIMELINE_PATH, TriageTimeline } from "../github/triage-timeline.js";
import { TRIAGE_VERDICTS_PATH } from "../github/triage-verdicts.js";
import { CodeReviewSendBody } from "../bitbucket-datacenter/code-review-send.js";
import { BITBUCKET_PATH, BitbucketRepos, ConnectBody, Connected, Connection, Disconnected, HookSecretRotated, RepoDisabled, RepoEnabled, RepoWebhook, type BitbucketHandlers } from "../bitbucket-datacenter/integration.js";
import { ACCEPT_PATH, AcceptBody, Accepted, INVITATIONS_PATH, InviteBody } from "../invitations/invitations.js";
import { body, Failure, json, refuseInvalid } from "../route-schema.js";
import { SESSIONS_PATH } from "../sessions.js";
import { DeployBody, WORKFLOW_DEPLOY_PATH } from "../workflow-deploy.js";
import { WORKFLOW_VERSIONS_PATH } from "../workflow-versions.js";

export const INTEGRATIONS_PREFIX = "/api/integrations/";
const PACK_SCHEMA_PATH = `${INTEGRATIONS_PREFIX}pack-schema`;
const POLICY_VALIDATE_PATH = `${INTEGRATIONS_PREFIX}policy/validate`;
const PolicyValidateBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, text: "string" });
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
  authMethods: { google: boolean; emailPassword: boolean; passwordReset: boolean; verificationEmail: boolean };
  manifest: { start: (req: Request, tenantId: string) => Promise<Response>; callback: (req: Request) => Promise<Response> };
  syncInstallations: (member: Member) => Promise<Response>;
  connectGithubApp: BodyHandler<typeof AppBody.infer>;
  prActions: BodyHandler<typeof ActionBody.infer>;
  bitbucketCodeReviewSend: BodyHandler<typeof CodeReviewSendBody.infer>;
  heldDos: BodyHandler<typeof HeldDoBody.infer>;
  prTriage: BodyHandler<typeof TriageBody.infer>;
  policyRead: BodyHandler<typeof PolicyQuery.infer>;
  policyFileRead: BodyHandler<typeof PolicyFileBody.infer>;
  policyFileExport: BodyHandler<typeof PolicyExportBody.infer>;
  policyUpgrades: (member: Member) => Promise<Response>;
  backlog: BodyHandler<typeof BacklogBody.infer>;
  openPulls: (member: Member) => Promise<Response>;
  prDetails: MemberHandler;
  mergeStates: MemberHandler;
  triageStats: MemberHandler;
  triageTimeline: MemberHandler;
  triageVerdicts: MemberHandler;
  audit: MemberHandler;
  workflowDeploy: BodyHandler<typeof DeployBody.infer>;
  codeReview: BodyHandler<typeof CodeReviewBody.infer>;
  codeReviewRun: BodyHandler<typeof CodeReviewRunBody.infer>;
  codeReviewLatest: BodyHandler<typeof CodeReviewQuery.infer>;
  codeReviewPlace: (member: Member) => Promise<Response>;
  workflowVersions: (member: Member) => Promise<Response>;
  invitations: {
    create: (body: typeof InviteBody.infer, member: Member, req: Request) => Promise<Response>;
    roles: (member: Member) => Promise<Response>;
    resend: (req: Request, member: Member, principalId: string) => Promise<Response>;
    withdraw: (req: Request, member: Member, principalId: string) => Promise<Response>;
    markVerified: (member: Member, principalId: string) => Promise<Response>;
    accept: (body: typeof AcceptBody.infer, user: SessionUser) => Promise<Response>;
  };
  bitbucketDatacenter: BitbucketHandlers;
  sessions: {
    list: (caller: Caller) => Promise<Response>;
    revoke: (caller: Caller, sessionId: string) => Promise<Response>;
  };
};

const TAGS = ["integrations"];
function keptGithubReads(scope: ReadScope): string {
  return `GitHub's answer is shared by the workspace and kept until a webhook or the hub's own write says the repository changed, and at most ${KEPT_MS[scope] / 1000} seconds; another host's answer is not kept this way.`;
}

const PolicyPullOpen = type({ error: { code: "'policy_pull_open'", message: "string", url: "string", number: "number" } });
const ManifestFailure = type({ error: "string" });
const AuthMethods = type({ google: "boolean", emailPassword: "boolean", passwordReset: "boolean", verificationEmail: "boolean" });
const PackSchemas = type({ checkPack: "Record<string, unknown>", sharedPolicy: "Record<string, unknown>", policyOverride: "Record<string, unknown>", repoPolicy: "Record<string, unknown>", policyFile: "Record<string, unknown>" });
const ManifestStart = type({ manifest: "Record<string, unknown>", state: "string" });
const InstallationsSynced = type({ installations: "number", repos: "string[]" });
const TriageQueued = type({ status: "'queued'", headSha: "string" });
const OpenPull = type({
  number: "number",
  title: "string",
  author: "string | null",
  "authorKind?": type.enumerated(...AUTHOR_KINDS),
  "byTriage?": "true",
  draft: "boolean",
  "sha?": "string",
  branch: "string | null",
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
const MergeStates = type({
  prs: type({
    number: "number",
    mergeable: "boolean | null",
    "mergeableState?": "string",
    "reviewDecision?": "'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null",
    "canMerge?": "boolean",
    "mergeVetoes?": "string[]",
  }).array(),
});

function html(description: string) {
  return { description, content: { "text/html": {} } };
}

const failures = {
  401: json("Not signed in", Failure),
  403: json("Not from the portal, not a member or not allowed", Failure),
  409: json("GitHub, the workspace or the repository is not ready", Failure),
};
const invalid = { 400: json("Invalid request", Failure) };
const policyBodyLimit = bodyLimit({ maxSize: 4 * POLICY_FILE_MAX_BYTES, onError: function tooLarge() { return failure(413, "too_large", "The policy file is too large."); } });
const CODE_REVIEW_REFUSALS = [
  "`no_code_review`: no finished review;",
  "`code_review_outdated`: a newer review finished than `headSha`'s;",
  "`code_review_empty`: no summary and no findings;",
  "`head_moved`: the pull request has moved past `headSha`.",
].join(" ");
const CODE_REVIEW_SEND_REFUSALS = `GitHub, the workspace or the repository is not ready. For code-review: ${CODE_REVIEW_REFUSALS}`;
const githubLimited = { 503: json("`github_rate_limited`: GitHub's rate limit is reached; `Retry-After` and `resetAt` say when it lifts", Failure) };
const githubFailed = { 502: json("GitHub failed", Failure), ...githubLimited };

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

function memberOf(c: Context<TenantEnv>): Member {
  return { tenantId: c.get("tenant").id, principalId: c.get("principal").id };
}

function callerOf(c: Context<TenantEnv>): Caller {
  return { user: c.get("user")!, session: c.get("session")! };
}

const REQUEST_LOG = ["hub", "requests"];

// The path alone: a query, such as the manifest callback's one-time GitHub code, never reaches the log.
function requestLine(req: Request, status: number) {
  return { method: req.method, url: new URL(req.url).pathname, status };
}

function respondedLine(c: HonoContext, responseTime: number) {
  return { ...requestLine(c.req.raw, c.res.status), responseTime };
}

export function logRefusal(req: Request, res: Response): Response {
  getLogger(REQUEST_LOG).info("{method} {url} {status}", requestLine(req, res.status));
  return res;
}

export function createIntegrationsApp(guards: IntegrationGuards, handlers: IntegrationHandlers) {
  const app = new Hono<TenantEnv>();
  app.use(honoLogger({ category: REQUEST_LOG, format: respondedLine }));
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
      description: "Open to an unverified account. Every other `/api/` route outside `/api/auth/` and `/api/hooks/`, stock and custom, refuses a signed-in user whose address is not verified with 403 `email_unverified`, except the hub's first account when no allowlist is set. `verificationEmail`: email/password sign-ups are sent a link to verify their address, and can ask for it again through better-auth's `/api/auth/send-verification-email`.",
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
      description: "`checkPack`, `sharedPolicy`, `policyOverride`, `repoPolicy` and `policyFile`, what `.corbits-triage.yml` holds.",
      tags: TAGS,
      responses: { 200: json("Policy and repository settings JSON Schemas", PackSchemas) },
    }),
    function packSchema() {
      return Response.json(packSchemas);
    },
  );

  app.post(
    POLICY_VALIDATE_PATH,
    describeRoute({
      summary: "Check a policy file's text as triage reads it",
      description: "Open to anyone; reads nothing but the body. `repo` is the repository the file is for. Answers the policy the file holds, or each problem with the line of the rule or section it is in (for YAML errors, the exact line and column).",
      tags: TAGS,
      responses: { 200: json("The policy the file holds, or why it is refused", PolicyValidated), ...invalid, 413: json("The body is too large", Failure) },
    }),
    policyBodyLimit,
    body(PolicyValidateBody),
    function policyValidate(c) {
      const { repo, text } = c.req.valid("json");
      return Response.json(checkPolicyFile(text, repo));
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
      description: "GitHub redirects here with a one-time code; answers with a redirect to the new App's GitHub install page or an HTML error page.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "state", required: true, schema: { type: "string" } },
        { in: "query", name: "code", required: true, schema: { type: "string" } },
      ],
      responses: {
        303: { description: "Setup completed; redirects to GitHub to choose repositories" },
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
      description: "Needs `manage` on the `github` credential. A workspace uses one installation: the one its repositories came from, else the oldest. When the App has others, their repositories are left out and the answer is 409 `github_second_installation` naming them.",
      tags: TAGS,
      responses: { 200: json("Installations and repositories found", InstallationsSynced), ...failures, ...githubFailed },
    }),
    member,
    function syncInstallations(c) {
      return handlers.syncInstallations(memberOf(c));
    },
  );

  app.put(
    `${GITHUB_APP_PATH}/:tenantId`,
    describeRoute({
      summary: "Connect an existing GitHub App",
      description: "Needs `manage` on the `github` credential, or `create` on `credential:*` when there is none, and the workspace's `github` provider. GitHub must accept the App ID and private key (`GET /app`), which also gives the App's slug. The key is stored in the hub-only `github-app` credential and never returned; the `github` credential holds an installation token once the App is installed. The webhook secret is the stock `github-hook` credential. Without `appId`, the stored App's ID is used, so a new key replaces the old one. Once a key is stored, a different App ID is refused (`409 github_app_mismatch`) unless `replace` is true.",
      tags: TAGS,
      requestBody: { required: true, content: { "application/json": { schema: resolver(AppBody) } } },
      responses: { 200: json("Connected; the slug GitHub gave", AppConnected), 400: json("Invalid request, or GitHub did not accept the App", Failure), ...failures, 409: json("Another App is connected and `replace` is not set, or the workspace has no GitHub provider", Failure) },
    }),
    member,
    body(AppBody),
    function connectGithubApp(c) {
      return handlers.connectGithubApp(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_ACTIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Act on a pull request",
      description: "Needs `use` on the GitHub App credential and `invoke` on `triage-do:<kind>:<owner/name>` for the Do kind the action is: comment (comment, reply and code-review), labels, assign, request-review, approve or request-changes (review), close or merge. `code-review` sends the pull request's newest finished code review, which must be of `headSha`, as one COMMENT review on that head: findings the diff shows are inline comments (one whose lines run past its hunk names the rest, and one marked `unverified` says it was not checked against the file), the others are in the review's body, as many as fit GitHub's limit and then how many more the portal holds. It is sent once per head; sending it again answers `sent: false` with the review already there.",
      tags: TAGS,
      responses: {
        200: json("GitHub's answer", type("unknown")),
        ...invalid,
        ...failures,
        409: json(CODE_REVIEW_SEND_REFUSALS, Failure),
        ...githubFailed,
      },
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
        502: json("`source_failed`: the pull request could not be read; `hub_unavailable`: it could not be queued", Failure),
        503: json("`service_not_running`: neither the listener nor the pr-triage service is running; `github_rate_limited`: GitHub's rate limit is reached, `Retry-After` and `resetAt` say when it lifts", Failure),
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
      description: "Any member of the workspace. Answers `ok` with the resolved pack and what it came from, `missing`, `corrupt` with the reason and the artifact a save replaces, or `invalid` with why triage refuses the repository's policy file. `source.file` names the policy file when the pack was read from it, `source.repo` the stored policy otherwise. `mergeRisks` names what Triage's automatic approve or merge can let in: `first-timers` when one is for first-time contributors, `ci-config` when one fires on a verdict a pull request changing a GitHub workflow file under `.github/workflows` can reach. Both name GitHub's author associations and workflow paths. The `source` query parameter is the repository's host, GitHub when absent.",
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
      summary: "A repository's policy file and why triage refuses it, if it does",
      description: "Needs `read` or `use` on the workspace's source credential and a connected repository. Reads `.corbits-triage.yml`, else `.corbits-triage.yaml`, on the default branch; `file` is null when there is none. While a file is there, triage runs on it in place of the stored policy, and runs nothing while it has a `problem`. `source` is the repository's host; without it, a name connected on both hosts is refused.",
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

  app.get(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy/upgrades`,
    describeRoute({
      summary: "How each enabled repository's saved rules stand against its policy file",
      description: "Each enabled repository whose host credential the member may read. `start`: no saved rules and no policy file; its `pull` is found in the workspace's shared open pull request listing. `upgrade`: saved rules and no policy file. `differs`: both, running differently, or a file triage refuses; the saved rules apply until the file matches them or the `saved` artifact is archived through the stock artifact route. `ok`: the file alone, the saved rules alone with nothing to write, or both running the same, after which the saved rules are archived. `pull` is the open pull request on `corbits-triage/policy`. Each row names its repository's host as `source`.",
      tags: TAGS,
      responses: { 200: json("Each enabled repository's standing", PolicyUpgrades), ...failures },
    }),
    member,
    function policyUpgrades(c) {
      return handlers.policyUpgrades(memberOf(c));
    },
  );

  app.post(
    `${GITHUB_PR_TRIAGE_PATH}/:tenantId/policy/export`,
    describeRoute({
      summary: "Open a pull request writing the repository's saved rules, a starter policy or a chosen file to its policy file",
      description: "Needs `use` on the host credential (GitHub App or Bitbucket Data Center) and a connected repository whose saved rules differ from its policy file or have no file, or an enabled one with neither. Writes the saved rules as a schema 3 file at the existing file's path, else `.corbits-triage.yml`, on `corbits-triage/policy`, and opens a pull request listing what the file cannot hold; an enabled repository with neither gets a starter `.corbits-triage.yml` instead, and asking again while its pull request is open answers that pull request unchanged. Otherwise asking again updates the open pull request instead of opening another. With `text`, the repository need not be enabled: the text is written to `.corbits-triage.yml` and a new pull request opened, only for a repository with no policy file on its default branch (read fresh from the host), no saved rules and no policy pull request open, which is left as it is. The text is refused as triage would refuse it once merged, `extends` resolved against this workspace. `source` is the repository's host; without it, a name connected on both hosts is refused.",
      tags: TAGS,
      responses: {
        200: json("The pull request opened or brought up to date", PolicyExported),
        ...invalid,
        ...failures,
        409: json("GitHub, the workspace or the repository is not ready. With `text`: `policy_file_present`, the repository has a policy file; `saved_rules`, it has saved rules; `policy_pull_open`, its policy pull request is open, given as `url` and `number`", Failure.or(PolicyPullOpen)),
        413: json("The body is too large", Failure),
        422: json("`policy_file_invalid`: triage refuses `text`, or the policy it `extends`; `message` holds each problem, one per line, led by its line", Failure),
        502: json("The host refused", Failure),
        ...githubLimited,
      },
    }),
    member,
    policyBodyLimit,
    body(PolicyExportBody),
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
      description: keptGithubReads("pulls"),
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
      description: keptGithubReads("all"),
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

  app.get(
    `${MERGE_STATES_PATH}/:tenantId`,
    describeRoute({
      summary: "Whether the host would merge these pull requests now",
      description: keptGithubReads("all"),
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "numbers", required: true, description: `Comma-separated pull request numbers, at most ${MAX_MERGE_STATES}, each at most 2147483647`, schema: { type: "string", pattern: "^[1-9]\\d*(,[1-9]\\d*)*$" } },
      ],
      responses: { 200: json("GitHub's merge state and review decision, or Bitbucket's merge checks, per pull request", MergeStates), ...invalid, ...failures, ...githubFailed },
    }),
    member,
    function mergeStates(c) {
      return handlers.mergeStates(c.req.raw, memberOf(c));
    },
  );

  app.get(
    `${TRIAGE_STATS_PATH}/:tenantId`,
    describeRoute({
      summary: "Triage stats of a repository over the last whole UTC days",
      description: "Needs `workflow-run:*` read. From the recorded verdicts and the Dos their runs executed, degraded verdicts left out; states, needed-you and check results count each head's latest verdict. `since` is the earliest recorded verdict. `outcomes` holds medians, and 75th percentiles in `p75`, read from the repository's host for up to the 50 newest triaged pull requests, against a baseline of pull requests closed before the policy was first saved (host limits: see docs/IMPLEMENTATION.md). `firstApprovalMs` is over approved pull requests only; `reviewerWaitMs` is from Triage's first verdict in the window to the first review or merge by someone other than the author, over reviewed pull requests only and never in the baseline. Failed host reads are left out of the medians; `state` and `baselineState` say why a part is missing. The verdict counts are cached for a minute; `outcomes` is read per request with the member's credential grant, host reads cached longer. `outcomes` measures the newest triaged pull requests of every repository of that name, reading them from the host `source` names, or without `source` from the host of the first connected repository of that name. The verdict counts and `since` also cover every repository of that name.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: true, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "source", required: false, schema: { type: "string", enum: [...REPO_SOURCES] } },
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
      description: "Needs `workflow-run:*` read, as reading run logs does. Reads only what the hub already recorded: verdicts (recorded within seconds of their step completing, by a loop over tenants with pr-triage runs in flight), the last read of the live logs and each host's last listing of open pull requests (the github-open-pulls listing, or one read at most every 30 seconds with each host's credential; a host with no credential lists none of its repositories; when the caller is barred from a host's credential, or no host has one, the last listing of any age). Each open pull request of a connected repository with a verdict or a live run, with its latest verdict, its latest run when that has not completed (`unknown` until the hub read the workspace's live logs since it started), and when author activity last started a run. Each pull request names its host as `source`: a verdict's is its run's workflow's, GitHub for a verdict whose run is gone, and a live run's is its mail's, so the same repository and number on both hosts are two pull requests. Where its host's listing lacks a repository, those with a verdict in the last 14 days. With `repo` and `number`, that one pull request on `source`, open or not; without `source`, on GitHub where a connected GitHub repository has that name, else on the only host that has it. Sends an ETag; a matching If-None-Match gets 304, answered from memory while nothing changed.",
      tags: TAGS,
      parameters: [
        { in: "query", name: "repo", required: false, schema: { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" } },
        { in: "query", name: "number", required: false, schema: { type: "integer", minimum: 1, maximum: 2147483647 } },
        { in: "query", name: "source", required: false, schema: { type: "string", enum: [...REPO_SOURCES] } },
      ],
      responses: {
        200: json("Pull requests by host, repository and number", TriageVerdicts),
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
    `${CODE_REVIEW_PATH}/:tenantId`,
    describeRoute({
      summary: "Turn code review on or off for a repository",
      description: "Needs `manage` on the workspace. Sets `codeReview` on the repository's record (`source` absent means GitHub). Refuses a repository whose policy file decides code review (`policy_file_decides`). Turning it on needs a provisioner code review can run on (`no_isolated_place` otherwise; see `GET /api/integrations/code-review/{tenantId}/place`), the repository's host and the repository connected (`repo_not_connected` otherwise) and the workspace's Anthropic key; the portal then deploys that host's code review. Turning off the last repository of a host releases its code review deployment.",
      tags: TAGS,
      responses: {
        200: json("The repository's code review setting", CodeReviewSet),
        ...invalid,
        401: failures[401],
        403: failures[403],
        404: json("No such repository", Failure),
        409: json("`policy_file_decides`, `no_isolated_place`, `source_not_connected`, `anthropic_key_missing` or `repo_not_connected`", Failure),
      },
    }),
    member,
    body(CodeReviewBody),
    function setCodeReview(c) {
      return handlers.codeReview(c.req.valid("json"), memberOf(c));
    },
  );

  app.get(
    `${CODE_REVIEW_PATH}/:tenantId`,
    describeRoute({
      summary: "A pull request's latest code review",
      description: "Needs `workflow-run:*` read. Read from the run logs of the host's code review deployments (`source` absent means GitHub), newest first among the workspace's recent reviews: `running`, `failed`, or `completed` with the summary, each finding's comment (path, lines, title, explanation, priority, the code it quotes and `unverified` when none of its file's lines could be read) and `cut` when the diff was cut for size, with the files it left `unread`. `completed` is the newest finished review, the same as `review` unless a newer one is running or failed; both are null when the pull request has none. `head`: the pull request's head as the caller last read it. `carriedTo`: that head when its diff is the one the newest finished review read, else null. Nothing is posted to the host.",
      tags: TAGS,
      responses: { 200: json("The latest review, or null", CodeReviewFound), ...invalid, 401: failures[401], 403: failures[403] },
    }),
    member,
    requireGrant("workflow-run:*", "read"),
    validator("query", CodeReviewQuery, refuseInvalid),
    function latestCodeReview(c) {
      return handlers.codeReviewLatest(c.req.valid("query"), memberOf(c));
    },
  );

  app.get(
    `${CODE_REVIEW_PATH}/:tenantId/place`,
    describeRoute({
      summary: "Where the workspace's code review runs",
      description: "`provisioner`: the id of the registered sidecar provisioner Interchange selects for code review, which requires `isolation:workload`, under the workspace's sidecar placement policies. Null when none matches: Interchange would refuse it with `provisioner_no_match`, so code review cannot be turned on and is not run. `places`: every isolated place this hub's provisioner packages offer, never the hub's own machine, each with its label, why to choose it, the `.env` lines that set it up, its setup guide and its state: `active` (code review runs there), `ready` (registered, but another comes first), `not_set_up`, or `failing`, with the `reason` the hub could not register it at boot for callers who may `manage` the workspace.",
      tags: TAGS,
      responses: { 200: json("The provisioner and every place", CodeReviewPlace), 401: failures[401], 403: failures[403] },
    }),
    member,
    function codeReviewPlace(c) {
      return handlers.codeReviewPlace(memberOf(c));
    },
  );

  app.post(
    `${CODE_REVIEW_PATH}/:tenantId/run`,
    describeRoute({
      summary: "Review a pull request again",
      description: "Needs `manage` on the workspace. Sends the pull request's current head to its host's code review even when that head was reviewed already. Needs a provisioner code review can run on (`no_isolated_place` otherwise). The repository must have code review on and the workspace its Anthropic key. Refuses a repository whose policy file decides code review (`policy_file_decides`). Refuses a draft (`draft`) or a closed pull request (`not_open`).",
      tags: TAGS,
      responses: {
        202: json("Queued", CodeReviewQueued),
        ...invalid,
        401: failures[401],
        403: failures[403],
        404: json("No such connected repository", Failure),
        409: json("`no_isolated_place`, `policy_file_decides`, `code_review_off`, `draft` or `not_open`", Failure),
        502: json("The host or the run trigger failed", Failure),
        ...githubLimited,
      },
    }),
    member,
    body(CodeReviewRunBody),
    function runCodeReview(c) {
      return handlers.codeReviewRun(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${INVITATIONS_PATH}/:tenantId`,
    describeRoute({
      summary: "Invite someone to the workspace by email",
      description: "Needs `principal:*` create, and the caller must hold every permission the role grants (so only an owner invites into a `*:*` role). Creates the stock invited principal through `POST /api/tenants/{tenantId}/members/invite`; the invitee accepts on the portal's `/invite/{tenantId}` page. When the hub sends email, a plain-text better-auth magic link to that page is emailed (a new address gets an unverified user first); it signs the invitee in and verifies the address, works once and expires after 15 minutes. Without email set up on the hub, the page's link is returned to copy; it signs nobody in, and the invitee must have signed in before they can be invited. With email, an existing account whose address is not verified cannot be invited; without, it can, and joins once the hub's owner marks it verified. An address may be sent a limited number of invite links per hour.",
      tags: TAGS,
      responses: {
        201: json("The invited principal and whether its link was emailed", InviteSent),
        ...invalid,
        401: failures[401],
        403: json("Not from the portal, not allowed to invite, a role granting more than the caller holds, or an email outside the sign-in allowlist", Failure),
        404: json("Role not found, or without email an address with no account", Failure),
        409: json("Already a member or invited, or with email an account whose address is not verified", Failure),
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
      responses: { 200: json("Assignable role ids, email delivery, the sign-in allowlist, who has not verified their address and whether the caller may mark it verified", InviteRoles), 401: failures[401], 403: failures[403] },
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
    `${INVITATIONS_PATH}/:tenantId/:principalId/verify`,
    describeRoute({
      summary: "Mark a person's email address verified",
      description: "Only on a hub that sends no email, and only by the hub's owner, its first account, since verified holds hub-wide. Same grant as inviting. For a member or invitee of the workspace who signed up with email and password and has not verified the address: the owner vouches for it, so the person gets past the verify-email refusal and can accept an invite. Listed in `unverifiedPrincipalIds` of `GET /api/integrations/invitations/{tenantId}`, whose `canMarkVerified` says whether the caller may. Logged with who verified whom.",
      tags: TAGS,
      responses: {
        204: { description: "Verified" },
        401: failures[401],
        403: json("Not from the portal, not allowed to invite, or not the hub's owner", Failure),
        404: json("No one in this workspace with an unverified email and password account has this id", Failure),
        409: json("`sends_email`: the hub sends email, so the person verifies with its link", Failure),
      },
    }),
    member,
    requireGrant("principal:*", "create"),
    function markVerified(c) {
      return handlers.invitations.markVerified(memberOf(c), c.req.param("principalId"));
    },
  );

  app.post(
    ACCEPT_PATH,
    describeRoute({
      summary: "Accept the signed-in user's invite to a workspace",
      description: "Activates the signed-in user's invited principal in the workspace. Their address must be verified: an invite's magic link verifies it, and without email set up on the hub, the invitee must have signed in before they can be invited. Accepting again answers the same.",
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
      description: "Needs `manage` on the workspace. The token is tried once against `GET /rest/api/1.0/application-properties` and stored only when the instance accepts it, as the stock `bitbucket-datacenter` credential on the `bitbucket-datacenter` provider; a webhook secret is generated as `bitbucket-datacenter-hook` unless one exists. The token is never returned. Called again with the connected URL and a new token, it replaces the token. With `rotateHookSecret` instead, a new secret is stored and each webhook triage created is saved with it; one that cannot be saved is no longer recorded as created. `webhooksByHand` names enabled repositories whose webhook must be updated on the instance by hand.",
      tags: TAGS,
      requestBody: { required: true, content: { "application/json": { schema: resolver(ConnectBody) } } },
      responses: { 200: json("Connected, or the webhook secret rotated", Connected.or(HookSecretRotated)), 400: json("Invalid request, or the instance did not accept the token", Failure), ...bitbucketFailures },
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

  app.get(
    `${BITBUCKET_PATH}/:tenantId/repositories/:project/:slug/webhook`,
    describeRoute({
      summary: "A Bitbucket repository's webhook",
      description: "Needs `manage` on the workspace and `use` on the `bitbucket-datacenter-hook` credential. `registered` when triage created the webhook; otherwise `manual` with the hook URL, secret and events to set up by hand.",
      tags: TAGS,
      parameters: repoParameters,
      responses: { 200: json("The webhook", RepoWebhook), 401: failures[401], 403: failures[403], 404: json("No such repository recorded", Failure), 409: json("Bitbucket is not connected, or triage is off for the repository", Failure) },
    }),
    member,
    function bitbucketRepoWebhook(c) {
      return handlers.bitbucketDatacenter.webhook(memberOf(c), c.req.param("project"), c.req.param("slug"));
    },
  );

  app.post(
    `${BITBUCKET_PATH}/:tenantId/code-review`,
    describeRoute({
      summary: "Send a code review to a Bitbucket pull request",
      description: "Needs `use` on the `bitbucket-datacenter` credential and `invoke` on `triage-do:comment:<PROJECT/slug>`. Sends the pull request's newest finished code review, which must be of `headSha`, as the token user: each finding the diff shows is an inline comment on its first shown line (one whose lines run past it names the rest, and one marked `unverified` says it was not checked against the file), the others are in one summary comment, posted last. It is sent once per head; sending it again posts only what is missing, and once the summary stands answers `sent: false`.",
      tags: TAGS,
      requestBody: { required: true, content: { "application/json": { schema: resolver(CodeReviewSendBody) } } },
      responses: {
        200: json("Sent, or already sent", type({ commentId: "number", sent: "boolean" })),
        ...invalid,
        401: failures[401],
        403: failures[403],
        409: json(`Bitbucket or the repository is not connected. ${CODE_REVIEW_REFUSALS}`, Failure),
        502: json("Bitbucket failed", Failure),
      },
    }),
    member,
    body(CodeReviewSendBody),
    function sendBitbucketCodeReview(c) {
      return handlers.bitbucketCodeReviewSend(c.req.valid("json"), memberOf(c));
    },
  );

  app.post(
    `${BITBUCKET_PATH}/:tenantId/repositories/:project/:slug/disable`,
    describeRoute({
      summary: "Disable triage on a Bitbucket repository",
      description: "Needs `manage` on the workspace, and `use` on the `bitbucket-datacenter` credential to remove the webhook triage created; without it the repository is disabled and `webhookLeft` is true.",
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
