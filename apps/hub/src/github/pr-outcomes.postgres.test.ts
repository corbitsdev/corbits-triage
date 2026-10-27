// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import { PROVIDER, TOKEN_CREDENTIAL } from "../bitbucket-datacenter/names.js";
import { createHostReads } from "./pr-outcomes.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_outcome_hosts";
const REPO = "acme/widgets";

async function noKeyPush(): Promise<void> {}

test("PostgreSQL: a name connected on both hosts is read from the host named, with that host's credential grant", async () => {
  const database = `corbits_outcome_hosts_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const { db } = handle;
    const repos = [{ name: REPO, connected: true, enabled: true, installationId: 1 }, { name: REPO, source: "bitbucket-datacenter", connected: true, enabled: true }];
    await db.insert(schema.tenant).values({ id: TENANT, name: "Outcome hosts", slug: "outcome-hosts", domain: "outcome-hosts.test", config: { corbitsTriage: { repos } } });
    await db.insert(schema.provider).values([
      { id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: "https://api.github.test" },
      { id: "prv_bb", tenantId: TENANT, name: PROVIDER, plugin: "http", apiBaseUrl: "https://bitbucket.test" },
    ]);
    await db.insert(schema.credential).values([
      { id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key", secret: "unused", status: "active" },
      { id: "crd_bb", tenantId: TENANT, principalId: null, providerId: "prv_bb", oauthClientId: null, name: TOKEN_CREDENTIAL, type: "api_key", secret: "unused", status: "active" },
    ]);
    async function authorize(_principalId: string, _tenantId: string, resource: string, action: string) {
      return resource === "credential:crd_bb" && action === "read";
    }
    async function bitbucket(): Promise<Response> {
      return Response.json({});
    }
    const reads = createHostReads({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      onKeyMoved: noKeyPush,
      authorize,
      githubApiOrigin: "https://api.github.test",
      tenantBitbucket: async () => bitbucket,
    });

    expect(await reads.host(TENANT, "prn_member", REPO, "bitbucket-datacenter")).toMatchObject({ source: "bitbucket-datacenter", host: expect.anything() });
    expect(await reads.host(TENANT, "prn_member", REPO, "github")).toEqual({ state: "no_credential" });
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
