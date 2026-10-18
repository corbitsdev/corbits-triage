// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { createSidecarPluginRegistry, type SidecarProvisioner } from "@intx/hub-sessions";
import type { SidecarCapabilityDeclaration } from "@intx/types";
import { createCodeReviewPlacement, createCodeReviewRun, createCodeReviewSwitch } from "./code-review.js";
import type { Offered } from "./code-review-feed.js";
import { codeReviewSources } from "./github/source-workflow.js";
import { repoRecords, triageNs } from "./github/tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_review";
const MEMBER = { tenantId: TENANT, principalId: "prn_owner" };

function provisioner(id: string, capabilities: SidecarCapabilityDeclaration[]): SidecarProvisioner {
  async function unused(): Promise<never> {
    throw new Error("not started in this test");
  }
  return { id, apiVersion: 2, bindingFingerprint: `${id}:test`, capabilities, ensure: unused, destroy: unused };
}
const LOCAL = provisioner("local-process", []);
const DOCKER = provisioner("docker", [{ capability: "isolation:workload", state: "available" }]);

test("PostgreSQL: code review turns on only with an isolated place to run, the host connected and the Anthropic key stored, and the hosts it reviews follow it", async () => {
  const database = `corbits_review_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    const repos = [{ name: "acme/widgets", connected: true }, { name: "TRI/widgets", source: "bitbucket-datacenter", connected: true }, { name: "acme/gone", connected: false }];
    await db.insert(schema.tenant).values({ id: TENANT, name: "Review", slug: "review", domain: "review.test", config: { corbitsTriage: { repos } } });
    await db.insert(schema.provider).values([
      { id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: "https://api.github.test" },
      { id: "prv_anthropic", tenantId: TENANT, name: "anthropic", plugin: "anthropic", apiBaseUrl: "https://api.anthropic.com" },
    ]);
    await db.insert(schema.credential).values({ id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key", secret: "unused", status: "active" });
    const place = createCodeReviewPlacement(db, createSidecarPluginRegistry({ provisioners: [LOCAL, DOCKER] }));
    const nowhere = createCodeReviewPlacement(db, createSidecarPluginRegistry({ provisioners: [LOCAL] }));
    expect(await place(TENANT)).toBe("docker");
    expect(await nowhere(TENANT)).toBeNull();
    await db.insert(schema.tenant).values({ id: "tnt_blocked", name: "Blocked", slug: "blocked", domain: "blocked.test", config: { sidecarPlacement: { capabilities: [{ capability: "isolation:workload", effect: "block" }] } } });
    expect(await place("tnt_blocked")).toBeNull();
    const changed: string[] = [];
    const setCodeReview = createCodeReviewSwitch({
      db,
      authorize: async () => true,
      async onChanged(tenantId) {
        changed.push(tenantId);
      },
      place,
    });
    async function answer(body: Parameters<typeof setCodeReview>[0]) {
      const response = await setCodeReview(body, MEMBER);
      return { status: response.status, body: await response.json() as { repo?: string; source?: string; codeReview?: boolean; error?: { code: string; message: string } } };
    }

    expect(await answer({ repo: "acme/widgets", enabled: true })).toEqual({
      status: 409,
      body: { error: { code: "anthropic_key_missing", message: "Save an Anthropic key in Settings before turning on code review." } },
    });
    await db.insert(schema.credential).values({ id: "crd_anthropic", tenantId: TENANT, principalId: null, providerId: "prv_anthropic", oauthClientId: null, name: "anthropic", type: "api_key", secret: "unused", status: "active" });
    const switchNowhere = createCodeReviewSwitch({ db, authorize: async () => true, onChanged: async () => {}, place: nowhere });
    expect((await (await switchNowhere({ repo: "acme/widgets", enabled: true }, MEMBER)).json() as { error: { code: string } }).error.code).toBe("no_isolated_place");
    expect((await answer({ repo: "TRI/widgets", source: "bitbucket-datacenter", enabled: true })).body.error?.code).toBe("source_not_connected");
    expect((await answer({ repo: "acme/missing", enabled: true })).status).toBe(404);
    expect((await answer({ repo: "acme/gone", enabled: true })).body.error?.code).toBe("repo_not_connected");
    expect(await answer({ repo: "acme/widgets", enabled: true })).toEqual({ status: 200, body: { repo: "acme/widgets", source: "github", codeReview: true } });
    expect(await codeReviewSources(db, TENANT)).toEqual(["github"]);

    expect((await answer({ repo: "acme/widgets", enabled: false })).body.codeReview).toBe(false);
    expect(await codeReviewSources(db, TENANT)).toEqual([]);
    const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, TENANT) });
    expect(repoRecords(triageNs(tenant?.config)).map((record) => [record.name, record.codeReview])).toEqual([["acme/widgets", false], ["TRI/widgets", undefined], ["acme/gone", undefined]]);
    expect(changed).toEqual([TENANT, TENANT]);

    const outcomes: Array<Offered | Error> = ["sent", "draft", new Error("github GET /repos/acme/widgets/pulls/7 -> 404")];
    const runCodeReview = createCodeReviewRun({
      db,
      authorize: async () => true,
      feed: {
        async again() {
          const next = outcomes.shift()!;
          if (next instanceof Error) throw next;
          return next;
        },
      },
      place,
    });
    const runNowhere = createCodeReviewRun({ db, authorize: async () => true, feed: { again: async () => "sent" }, place: nowhere });
    expect((await runNowhere({ repo: "acme/widgets", number: 7 }, MEMBER)).status).toBe(409);
    async function run(repo: string) {
      const response = await runCodeReview({ repo, number: 7 }, MEMBER);
      return [response.status, ((await response.json()) as { status?: string; error?: { code: string } }).error?.code ?? "queued"];
    }
    expect(await run("acme/missing")).toEqual([404, "repo_not_found"]);
    expect(await run("acme/widgets")).toEqual([202, "queued"]);
    expect(await run("acme/widgets")).toEqual([409, "draft"]);
    expect(await run("acme/widgets")).toEqual([502, "code_review_unavailable"]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
