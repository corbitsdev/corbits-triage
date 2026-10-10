// Handlers check the session before reading the body, so bodies are described
// here but validated inside each handler.
import { type } from "arktype";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import { describeRoute, resolver } from "hono-openapi";
import { checkPackSchema, repoPolicySchema } from "@corbits/triage-contracts";
import { AUTH_METHODS_PATH } from "../auth.js";
import { GITHUB_INSTALLATIONS_PATH } from "../github/installation-sync.js";
import { GITHUB_MANIFEST_CALLBACK_PATH, GITHUB_MANIFEST_PATH, StartBody } from "../github/manifest.js";
import { GITHUB_OPEN_PULLS_PATH } from "../github/open-pulls.js";
import { ActionBody, GITHUB_PR_ACTIONS_PATH } from "../github/pr-actions.js";
import { GITHUB_PR_DETAILS_PATH } from "../github/pr-details.js";
import { GITHUB_PR_TRIAGE_PATH, TriageBody } from "../github/pr-triage.js";

export const INTEGRATIONS_PREFIX = "/api/integrations/";
const PACK_SCHEMA_PATH = `${INTEGRATIONS_PREFIX}pack-schema`;
const packSchemas = { checkPack: checkPackSchema.toJsonSchema(), repoPolicy: repoPolicySchema.toJsonSchema() };

type TenantHandler = (req: Request, tenantId: string) => Promise<Response>;

export type IntegrationHandlers = {
  authMethods: { google: boolean; emailPassword: boolean };
  manifest: { start: TenantHandler; cancel: TenantHandler; callback: (req: Request) => Promise<Response> };
  syncInstallations: TenantHandler;
  prActions: TenantHandler;
  prTriage: TenantHandler;
  openPulls: TenantHandler;
  prDetails: TenantHandler;
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
const OpenPulls = type({ repos: type({ repo: "string", prs: "Record<string, unknown>[]", "error?": "string" }).array() });
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

  return app;
}
