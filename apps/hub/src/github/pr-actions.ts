// Human-initiated pull request writes (comment, review, merge, close). The
// operator's click is the approval, so these run synchronously in the hub
// against the tenant's vaulted GitHub App credential instead of as workflows.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { createIssueComment, createReview, mergePr, mirror, type GithubFetch } from "@corbits/github-tool/github";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { validManifestMutationRequest } from "./manifest.js";

export const GITHUB_PR_ACTIONS_PATH = "/api/integrations/github-actions";

type SessionResult = { user: { id: string } };

const VERB = { comment: "comment on", review: "review", merge: "merge", close: "close" } as const;

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

const ActionBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" }).and(
  type({ action: "'comment'", body: "string > 0" })
    .or({ action: "'review'", event: "'APPROVE' | 'REQUEST_CHANGES'", body: "string" })
    .or({ action: "'merge'" })
    .or({ action: "'close'", labels: "string[]", comment: "string" }),
);

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function createGithubPrActions({ db, cipher, getSession, authorize, trustedPortalOrigins, githubApiOrigin }: {
  db: DB["db"];
  cipher: CredentialCipher;
  getSession: (headers: Headers) => Promise<SessionResult | null>;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  trustedPortalOrigins: readonly string[];
  githubApiOrigin: string;
}) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: githubApiOrigin });

  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const trusted = new Set([new URL(req.url).origin, ...trustedPortalOrigins]);
    if (!validManifestMutationRequest(req, trusted)) return failure(403, "forbidden", "This request did not come from the portal.");
    const session = await getSession(req.headers);
    if (!session) return failure(401, "unauthorized", "Sign in again.");
    const member = await db.query.principal.findFirst({
      where: and(
        eq(schema.principal.tenantId, tenantId),
        eq(schema.principal.kind, "user"),
        eq(schema.principal.refId, session.user.id),
        eq(schema.principal.status, "active"),
      ),
    });
    if (!member) return failure(401, "unauthorized", "You are not a member of this workspace.");

    const body = ActionBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);

    const credential = await db.query.credential.findFirst({
      where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, "github"), eq(schema.credential.status, "active")),
    });
    if (!credential) return failure(409, "github_not_connected", "Connect GitHub first.");
    if (!(await authorize(member.id, tenantId, `credential:${credential.id}`, "use"))) {
      return failure(403, "forbidden", "You do not have access to the GitHub App credential.");
    }
    const appJson = await cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    const gh: GithubFetch = function appCredentialFetch(path, init) {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${appJson}`);
      headers.set("accept", "application/vnd.github+json");
      return appFetch(`${githubApiOrigin}${path}`, { ...init, headers });
    };

    try {
      const { repo, number } = body;
      const result = body.action === "comment"
        ? await createIssueComment(gh, { repo, number, body: body.body })
        : body.action === "review"
          ? await createReview(gh, { repo, number, body: body.body, event: body.event })
          : body.action === "merge"
            ? await mergePr(gh, { repo, number })
            : await mirror(gh, { repo, number, labels: body.labels, comment: body.comment, close: true });
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "github_pr_action", tenantId, principalId: member.id, action: body.action, repo, number }));
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "github_pr_action_failed", tenantId, action: body.action, repo: body.repo, number: body.number, error: message }));
      const status = /-> (\d{3})$/.exec(message)?.[1];
      return failure(502, "github_failed", `GitHub refused to ${VERB[body.action]} ${body.repo}#${body.number}${status ? ` (HTTP ${status})` : `: ${message}`}.`);
    }
  };
}
