// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { doResource } from "@corbits/triage-contracts";
import { createRepoReads } from "../github/repo-reads.js";
import { createBitbucketCodeReviewSend } from "./code-review-send.js";
import { PROVIDER, TOKEN_CREDENTIAL } from "./names.js";

async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_bitbucket_code_review";
const REPO = "TRI/widgets";
const PR_PATH = "/rest/api/1.0/projects/TRI/repos/widgets/pull-requests/1";
const testSchema = `corbits_bb_review_${randomBytes(6).toString("hex")}`;
const handle = createDB({ ...TEST_DB, schema: testSchema });
const grants = createGrantStore(handle.db);
const posted: string[] = [];

const COMPLETED = { status: "completed" as const, headSha: "abc", startedAt: "2026-10-22T00:00:00.000Z", summary: "Looks fine.", budgetExhausted: false, complete: true, comments: [] };

// Shapes recorded from Bitbucket Data Center 10.5, trimmed to the fields read.
async function bitbucket(path: string, init?: RequestInit): Promise<Response> {
  if (path === "/rest/api/1.0/application-properties") return Response.json({}, { headers: { "x-auserid": "7", "x-ausername": "triage-bot" } });
  if (path.startsWith("/rest/api/1.0/users?")) return Response.json({ values: [{ id: 7, slug: "triage-bot" }], isLastPage: true });
  if (path.startsWith(`${PR_PATH}/activities?`)) {
    const values = posted.map((text, id) => ({ action: "COMMENTED", commentAction: "ADDED", comment: { id, version: 0, text, author: { id: 7 } } }));
    return Response.json({ values, isLastPage: true });
  }
  if (path === PR_PATH) return Response.json({ state: "OPEN", version: 1, fromRef: { latestCommit: "abc", repository: { id: 1 } }, toRef: { repository: { id: 1 } }, links: { self: [{ href: "https://bitbucket.test/pr/1" }] }, author: { user: { id: 3, slug: "admin" } }, reviewers: [], participants: [] });
  if (init?.method === "POST" && path === `${PR_PATH}/comments`) {
    posted.push(JSON.parse(init.body as string).text);
    return Response.json({ id: posted.length - 1 });
  }
  throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
}

const send = createBitbucketCodeReviewSend({
  db: handle.db,
  cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
  onKeyMoved: noKeyPush,
  async authorize(principalId, tenantId, resource, action) {
    return (await authorize(grants, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
  },
  async tenantBitbucket() { return bitbucket satisfies BitbucketFetch; },
  codeReviews: { async latest() { return { review: COMPLETED, completed: COMPLETED, carriedTo: null }; } },
  changed: createRepoReads(() => new Date()).changed,
  log() {},
});

function member(principalId: string) {
  return { tenantId: TENANT, principalId };
}

beforeAll(async () => {
  await runMigrations(TEST_DB, { schema: testSchema });
  const db = handle.db;
  await db.insert(schema.tenant).values({
    id: TENANT, name: "Bitbucket review", slug: "bb-review", domain: "bb-review.test",
    config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, source: "bitbucket-datacenter" }] } },
  });
  await db.insert(schema.principal).values(["prn_user", "prn_commenter"].map((id) => ({ id, tenantId: TENANT, kind: "user" as const, refId: id.replace("prn_", "usr_"), status: "active" as const })));
  await db.insert(schema.provider).values({ id: "prv_bb", tenantId: TENANT, name: PROVIDER, plugin: "http", apiBaseUrl: "https://bitbucket.test" });
  await db.insert(schema.credential).values({ id: "crd_bb", tenantId: TENANT, principalId: null, providerId: "prv_bb", oauthClientId: null, name: TOKEN_CREDENTIAL, type: "api_key", secret: "unused", status: "active" });
  await db.insert(schema.grant).values([
    { id: "grt_user_use", tenantId: TENANT, principalId: "prn_user", resource: "credential:crd_bb", action: "use", effect: "allow", origin: "system" },
    { id: "grt_commenter_use", tenantId: TENANT, principalId: "prn_commenter", resource: "credential:crd_bb", action: "use", effect: "allow", origin: "system" },
    { id: "grt_commenter_comment", tenantId: TENANT, principalId: "prn_commenter", resource: doResource("comment", "bitbucket-datacenter", REPO), action: "invoke", effect: "allow", origin: "system" },
  ]);
}, 120_000);

afterAll(async () => {
  await handle.close();
  await dropSchema(TEST_DB, { schema: testSchema });
});

test("PostgreSQL: sending a code review to Bitbucket needs the comment grant on top of use, and posts it once per head", async () => {
  const body = { repo: REPO, number: 1, headSha: "abc" };
  const refused = await send(body, member("prn_user"));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "You do not have the grant for this kind of Do in this repository." } });
  expect(posted).toEqual([]);

  expect(await (await send(body, member("prn_commenter"))).json()).toEqual({ commentId: 0, sent: true });
  expect(await (await send(body, member("prn_commenter"))).json()).toEqual({ commentId: 0, sent: false });
  expect(posted).toEqual(["[corbits-code-review]: #abc\nLooks fine."]);
});
